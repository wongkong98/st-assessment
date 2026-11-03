const fs = require('fs');
const { parse } = require('csv-parse');
const db = require('../utils/db');

const BATCH_SIZE = 100;
const EDITABLE_COLUMNS = ['name', 'email', 'body', 'post_id'];

const parseCSV = (filePath) =>
    fs.createReadStream(filePath).pipe(parse({ columns: true, bom: true, skip_empty_lines: true, trim: true }));

const MAX_ID = 2147483647;

const toRowValues = (record, rowNumber) => {
    const id = Number(record.id);
    if (!Number.isInteger(id) || id < 1 || id > MAX_ID) {
        throw new Error(`Row ${rowNumber}: id must be a positive integer`);
    }
    const postId = Number(record.postId ?? record.post_id);
    if (!Number.isInteger(postId)) {
        throw new Error(`Row ${rowNumber}: postId must be an integer`);
    }
    return [id, record.name || null, record.email || null, record.body || null, postId];
};

const upsertBatch = async (client, batch) => {
    const placeholders = batch.map((_, i) => {
        const p = i * 5;
        return `($${p + 1}::integer, $${p + 2}::varchar, $${p + 3}::varchar, $${p + 4}::text, $${p + 5}::bigint)`;
    });
    const { rows } = await client.query(
        `WITH incoming(id, name, email, body, post_id) AS (VALUES ${placeholders.join(', ')}),
        archived AS (
            INSERT INTO csv_row_history(row_id, name, email, body, date_created, post_id, version)
            SELECT r.id, r.name, r.email, r.body, r.date_created, r.post_id, r.version
            FROM csv_row r JOIN incoming i ON i.id = r.id
            WHERE (r.name, r.email, r.body, r.post_id) IS DISTINCT FROM (i.name, i.email, i.body, i.post_id)
            FOR UPDATE OF r
            RETURNING row_id
        ),
        upserted AS (
            INSERT INTO csv_row(id, name, email, body, post_id)
            SELECT id, name, email, body, post_id FROM incoming
            ON CONFLICT (id) DO UPDATE
            SET name = EXCLUDED.name, email = EXCLUDED.email, body = EXCLUDED.body, post_id = EXCLUDED.post_id,
                version = csv_row.version + 1
            WHERE (csv_row.name, csv_row.email, csv_row.body, csv_row.post_id)
                IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.email, EXCLUDED.body, EXCLUDED.post_id)
        )
        SELECT row_id FROM archived`,
        batch.flat()
    );
    return rows.map((row) => row.row_id);
};

const buildFilters = ({ search, from, to }) => {
    const conditions = [];
    const values = [];
    if (search) {
        values.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
        const p = `$${values.length}`;
        conditions.push(`(name ILIKE ${p} OR email ILIKE ${p} OR body ILIKE ${p})`);
    }
    if (from) {
        values.push(from);
        conditions.push(`date_created >= $${values.length}`);
    }
    if (to) {
        values.push(to);
        conditions.push(`date_created <= $${values.length}`);
    }
    return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
};

const selectRowsJson = 'SELECT id, to_jsonb(r) AS data FROM csv_row r WHERE id = ANY($1::integer[])';

let importQueue = Promise.resolve();
let queuedImports = 0;

const runInImportQueue = (onWaiting, task) => {
    if (queuedImports > 0) onWaiting();
    queuedImports++;
    const run = importQueue.then(task);
    importQueue = run.catch(() => {});
    return run.finally(() => {
        queuedImports--;
    });
};

const CsvFile = {
    EDITABLE_COLUMNS,
    async importCSV(filePath, onProgress, { force = false } = {}) {
        let total = 0;
        const fileIds = new Set();
        for await (const record of parseCSV(filePath)) {
            total++;
            const id = Number(record.id);
            if (Number.isInteger(id) && id > 0 && id <= MAX_ID) fileIds.add(id);
        }
        const ids = [...fileIds];
        onProgress({ total_rows: total, processed_rows: 0 });

        const { rows: baselineRows } = await db.query(selectRowsJson, [ids]);
        const baseline = new Map(baselineRows.map((row) => [row.id, row.data]));

        return runInImportQueue(() => onProgress({ status: 'waiting' }), async () => {
            onProgress({ status: 'processing' });
            const client = await db.connect();

            try {
                await client.query('BEGIN');
                await client.query("SELECT pg_advisory_xact_lock(hashtext('csv_row_import'))");
                const { rows: existingRows } = await client.query(
                    'SELECT id FROM csv_row WHERE id = ANY($1::integer[]) FOR UPDATE',
                    [ids]
                );
                const existingIds = new Set(existingRows.map((row) => row.id));

                if (!force) {
                    const { rows: currentRows } = await client.query(selectRowsJson, [ids]);
                    const current = new Map(currentRows.map((row) => [row.id, row.data]));
                    const concurrentChanges = ids
                        .filter((id) => JSON.stringify(baseline.get(id) ?? null) !== JSON.stringify(current.get(id) ?? null))
                        .sort((a, b) => a - b)
                        .map((id) => ({ id, old: baseline.get(id) ?? null, new: current.get(id) ?? null }));
                    if (concurrentChanges.length > 0) {
                        await client.query('ROLLBACK');
                        return { concurrentChanges };
                    }
                }

                await client.query('CREATE TEMP TABLE import_snapshot (id integer, data jsonb) ON COMMIT DROP');
                await client.query(`INSERT INTO import_snapshot ${selectRowsJson}`, [ids]);

                let processed = 0;
                let batch = [];
                let batchIds = new Set();
                const updatedIds = new Set();
                const flush = async () => {
                    for (const id of await upsertBatch(client, batch)) updatedIds.add(id);
                    processed += batch.length;
                    batch = [];
                    batchIds = new Set();
                    onProgress({ processed_rows: processed });
                };

                for await (const record of parseCSV(filePath)) {
                    const row = toRowValues(record, processed + batch.length + 1);
                    if (batchIds.has(row[0])) await flush();
                    batch.push(row);
                    batchIds.add(row[0]);
                    if (batch.length === BATCH_SIZE) await flush();
                }
                if (batch.length > 0) await flush();

                const { rows: changedRows } = await client.query(
                    `SELECT (diff.data->>'id')::integer AS id, old.data AS old, diff.data AS new FROM (
                        SELECT to_jsonb(r) AS data FROM csv_row r WHERE id = ANY($1::integer[])
                        EXCEPT
                        SELECT data FROM import_snapshot
                    ) diff
                    LEFT JOIN import_snapshot old ON old.id = (diff.data->>'id')::integer
                    ORDER BY id`,
                    [ids]
                );

                await client.query('COMMIT');
                return { updatedIds: [...updatedIds].filter((id) => existingIds.has(id)), changedRows };
            } catch (err) {
                await client.query('ROLLBACK');
                onProgress({ processed_rows: 0 });
                throw err;
            } finally {
                client.release();
            }
        });
    },
    async getAll(page, limit, filters = {}) {
        const { where, values } = buildFilters(filters);
        const n = values.length;
        const [countRes, dataRes] = await Promise.all([
            db.query(`SELECT COUNT(*) AS total FROM csv_row ${where}`, values),
            db.query(
                `SELECT * FROM csv_row ${where} ORDER BY id ASC LIMIT $${n + 1} OFFSET $${n + 2}`,
                [...values, limit, (page - 1) * limit]
            ),
        ]);
        const totalItems = parseInt(countRes.rows[0].total, 10);
        const totalPages = Math.ceil(totalItems / limit);

        return {
            metadata: {
                totalItems,
                totalPages,
                currentPage: page,
                pageSize: limit,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1,
            },
            data: dataRes.rows,
        };
    },

    async edit(id, version, fields) {
        const keys = EDITABLE_COLUMNS.filter((key) => fields[key] !== undefined);
        const setClause = [...keys.map((key, i) => `${key} = $${i + 3}`), 'version = csv_row.version + 1'].join(', ');
        const { rows } = await db.query(
            `WITH old AS (
                SELECT * FROM csv_row WHERE id = $1 AND version = $2 FOR UPDATE
            ),
            archived AS (
                INSERT INTO csv_row_history(row_id, name, email, body, date_created, post_id, version)
                SELECT id, name, email, body, date_created, post_id, version FROM old
            )
            UPDATE csv_row SET ${setClause} FROM old WHERE csv_row.id = old.id RETURNING csv_row.*`,
            [id, version, ...keys.map((k) => fields[k])]
        );
        return rows[0] || null;
    },
    async delete(id) {
        const { rows } = await db.query('DELETE FROM csv_row WHERE id = $1 RETURNING *', [id]);
        return rows[0] || null;
    },
    async findRowById(id) {
        const { rows } = await db.query('SELECT * FROM csv_row WHERE id = $1', [id]);
        return rows[0] || null;
    },
    async getHistory(rowId) {
        const { rows } = await db.query(
            'SELECT * FROM csv_row_history WHERE row_id = $1 ORDER BY id DESC',
            [rowId]
        );
        return rows;
    }
};

module.exports = CsvFile;
