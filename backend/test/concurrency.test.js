const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const BIG = { timeout: 180000 };

before(h.setupDb);
after(h.teardownDb);
beforeEach(h.resetDb);

const waitForProgress = (id) =>
  h.waitFor(async () => {
    const job = await h.getJob(id);
    if (job.status !== 'processing') throw new Error(`expected ${id} to be processing, got ${job.status}`);
    return job.processed_rows > 0 && job;
  }, { timeout: 60000, interval: 10, message: 'import progress' });

const waitForStatus = (id, status) =>
  h.waitFor(async () => (await h.getJob(id)).status === status, { timeout: 60000, interval: 10, message: `status ${status}` });

const renamed = (ids, tag) => h.toCsv(h.onlyIds(h.sample(), ids).map((r) => ({ ...r, name: `${r.name} ${tag}` })));
const versionsOf = async (ids) =>
  (await h.sql('SELECT id, version FROM csv_row WHERE id = ANY($1) ORDER BY id', [ids])).rows.map((r) => r.version);

describe('import queue', () => {
  test('a second import waits while another runs and then completes; rows outside its file are ignored', BIG, async () => {
    await h.seedSample();
    const a = await h.upload(h.bigCsv('A', { ids: h.idRange(1, 250), times: 20 }));
    await waitForProgress(a.id);
    const b = await h.upload(renamed(h.idRange(251, 260), 'B'));
    await waitForStatus(b.id, 'waiting');

    const aWhileWaiting = await h.getJob(a.id);
    const bWhileWaiting = await h.getJob(b.id);
    assert.equal(aWhileWaiting.status, 'processing');
    assert.equal(bWhileWaiting.processed_rows, 0);
    assert.equal(bWhileWaiting.total_rows, 10);
    assert.deepEqual(await versionsOf([251, 252]), [1, 1]);

    await h.waitFor(async () => (await h.getJob(b.id)).status !== 'waiting', { timeout: 120000, interval: 10 });
    assert.equal((await h.getJob(a.id)).status, 'completed');

    const bDone = await h.waitForJob(b.id);
    const aDone = await h.waitForJob(a.id);
    assert.equal(aDone.status, 'completed');
    assert.equal(bDone.status, 'completed');
    assert.deepEqual(bDone.changed_rows.map((c) => c.id), h.idRange(251, 260));
    assert.equal((await h.dbRow(251)).version, 2);
    assert.equal((await h.dbRow(1)).version, 21);
  });

  test('changed_rows ignores a concurrent edit to a row that is not in the file', BIG, async () => {
    await h.seedSample();
    const a = await h.upload(h.bigCsv('A', { ids: h.idRange(1, 250), times: 20 }));
    await waitForProgress(a.id);
    const edit = await h.api().put('/api/row/400').send({ version: 1, name: 'edited elsewhere' });
    assert.equal(edit.status, 200);
    assert.equal((await h.getJob(a.id)).status, 'processing');

    const done = await h.waitForJob(a.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.changed_rows.map((c) => c.id), h.idRange(1, 250));
    assert.equal((await h.dbRow(400)).name, 'edited elsewhere');
  });
});

describe('stale detection', () => {
  test('an import whose rows were changed by an earlier import ends stale and writes nothing; force imports it', BIG, async () => {
    const seed = await h.seedSample();
    const seeded = new Map(seed.changed_rows.map((c) => [c.id, c.new]));
    const extra = { postId: '1', id: '501', name: 'brand new', email: 'new@example.com', body: 'nb' };
    const aRecords = h.repeat(h.sample(), 20, (r, i) => ({ ...r, name: `${r.name} A${i}` }));
    aRecords.push(extra);
    const a = await h.upload(h.toCsv(aRecords));
    await waitForProgress(a.id);

    const bRecords = [...h.onlyIds(h.sample(), h.idRange(1, 10)), extra].map((r) => ({ ...r, name: `${r.name} B` }));
    const bCsv = h.toCsv(bRecords);
    const b = await h.upload(bCsv);
    await waitForStatus(b.id, 'waiting');

    const bDone = await h.waitForJob(b.id);
    const aDone = await h.waitForJob(a.id);
    assert.equal(aDone.status, 'completed');
    assert.equal(bDone.status, 'stale');
    assert.equal(bDone.changed_rows, undefined);

    const changes = bDone.concurrent_changes;
    assert.deepEqual(changes.map((c) => c.id), [...h.idRange(1, 10), 501]);
    const current1 = await h.dbRow(1);
    assert.deepEqual(changes[0].old, seeded.get(1));
    assert.equal(changes[0].new.name, `${h.sample()[0].name} A19`);
    assert.equal(changes[0].new.version, 21);
    assert.equal(current1.version, 21);
    assert.equal(changes[10].old, null);
    assert.equal(changes[10].new.name, 'brand new');

    assert.equal((await h.dbRow(1)).name, `${h.sample()[0].name} A19`);
    assert.equal((await h.dbRow(501)).name, 'brand new');
    assert.equal((await h.dbHistory(1)).length, 20);
    assert.equal((await h.dbHistory(501)).length, 0);

    const forced = await h.importCsv(bCsv, { force: true });
    assert.equal(forced.status, 'completed');
    assert.deepEqual(forced.changed_rows.map((c) => c.id), [...h.idRange(1, 10), 501]);
    assert.equal((await h.dbRow(1)).name, `${h.sample()[0].name} B`);
    assert.equal((await h.dbRow(1)).version, 22);
    assert.equal((await h.dbRow(501)).name, 'brand new B');
  });

  test('edits and deletes of rows in a waiting import make it stale; edits elsewhere are ignored', BIG, async () => {
    const seed = await h.seedSample();
    const seeded = new Map(seed.changed_rows.map((c) => [c.id, c.new]));
    const a = await h.upload(h.bigCsv('A', { ids: h.idRange(1, 250), times: 20 }));
    await waitForProgress(a.id);
    const c = await h.upload(renamed(h.idRange(300, 310), 'C'));
    await waitForStatus(c.id, 'waiting');

    assert.equal((await h.api().put('/api/row/300').send({ version: 1, name: 'edited 300' })).status, 200);
    assert.equal((await h.api().delete('/api/row/301')).status, 204);
    assert.equal((await h.api().put('/api/row/400').send({ version: 1, name: 'edited 400' })).status, 200);
    assert.equal((await h.getJob(c.id)).status, 'waiting');

    const cDone = await h.waitForJob(c.id);
    assert.equal((await h.waitForJob(a.id)).status, 'completed');
    assert.equal(cDone.status, 'stale');
    assert.equal(cDone.concurrent_changes.length, 2);
    const [edited, deleted] = cDone.concurrent_changes;
    assert.equal(edited.id, 300);
    assert.deepEqual(edited.old, seeded.get(300));
    assert.equal(edited.new.name, 'edited 300');
    assert.equal(edited.new.version, 2);
    assert.equal(deleted.id, 301);
    assert.deepEqual(deleted.old, seeded.get(301));
    assert.equal(deleted.new, null);

    assert.equal((await h.dbRow(302)).name, h.sample()[301].name);
    assert.equal((await h.dbRow(302)).version, 1);
    assert.equal(await h.dbRow(301), null);
  });
});

describe('edits during a running import', () => {
  test('an edit to a row in the running import blocks until it commits and then returns 409', BIG, async () => {
    await h.seedSample();
    const a = await h.upload(h.bigCsv('A', { ids: h.idRange(1, 250), times: 20 }));
    await waitForProgress(a.id);
    const res = await h.api().put('/api/row/5').send({ version: 1, name: 'too late' });
    assert.equal(res.status, 409);
    assert.equal(res.body.row.version, 21);
    assert.equal(res.body.row.name, `${h.sample()[4].name} A19`);
    assert.equal((await h.waitForJob(a.id)).status, 'completed');
    assert.equal((await h.dbHistory(5)).length, 20);
  });
});

describe('history invariant', () => {
  test('two overlapping imports plus concurrent edits keep every version archived exactly once', { timeout: 300000 }, async () => {
    await h.seedSample();
    let running = true;
    const stats = { ok: 0, conflict: 0, other: [] };
    const worker = async (w) => {
      let i = 0;
      while (running) {
        const id = 1 + Math.floor(Math.random() * 500);
        const current = await h.api().get(`/api/row/${id}`);
        if (current.status !== 200) {
          stats.other.push(`GET ${id} -> ${current.status}`);
          continue;
        }
        const stale = i % 3 === 0 && current.body.version > 1;
        const version = stale ? current.body.version - 1 : current.body.version;
        const res = await h.api().put(`/api/row/${id}`).send({ version, name: `edit ${w}-${i++}` });
        if (res.status === 200) stats.ok++;
        else if (res.status === 409) stats.conflict++;
        else stats.other.push(`PUT ${id} -> ${res.status}`);
      }
    };
    const workers = [1, 2, 3, 4].map(worker);

    const a = await h.upload(h.bigCsv('A', { times: 20 }), { force: true });
    await waitForProgress(a.id);
    const b = await h.upload(h.bigCsv('B', { times: 20 }), { force: true });
    const [aDone, bDone] = [await h.waitForJob(a.id), await h.waitForJob(b.id)];
    const afterImports = stats.ok;
    await h.waitFor(() => stats.ok >= afterImports + 50, { timeout: 60000, message: 'edits after imports' });
    running = false;
    await Promise.all(workers);

    assert.equal(aDone.status, 'completed');
    assert.equal(bDone.status, 'completed');
    assert.deepEqual(stats.other, []);
    assert.ok(stats.conflict > 0);

    const { rows } = await h.sql(
      `SELECT r.id, r.version, COALESCE(array_agg(hi.version ORDER BY hi.version) FILTER (WHERE hi.id IS NOT NULL), '{}') AS versions
       FROM csv_row r LEFT JOIN csv_row_history hi ON hi.row_id = r.id
       GROUP BY r.id, r.version ORDER BY r.id`
    );
    assert.equal(rows.length, 500);
    const broken = rows.filter((r) => JSON.stringify(r.versions) !== JSON.stringify(h.idRange(1, r.version - 1)));
    assert.deepEqual(broken, []);
    for (const r of rows) assert.ok(r.version >= 41);
  });
});
