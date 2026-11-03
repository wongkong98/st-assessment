const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

before(h.setupDb);
after(h.teardownDb);
beforeEach(h.resetDb);

describe('POST /api/file', () => {
  test('returns 400 when no file is sent', async () => {
    const res = await h.api().post('/api/file');
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });

  test('returns 400 when only the force field is sent', async () => {
    const res = await h.api().post('/api/file').field('force', 'true');
    assert.equal(res.status, 400);
  });

  test('returns 202 with a fresh processing job', async () => {
    const res = await h.api().post('/api/file').attach('file', Buffer.from(h.toCsv(h.sample())), 'sample.csv');
    assert.equal(res.status, 202);
    assert.match(res.body.id, UUID);
    assert.deepEqual(res.body, {
      id: res.body.id,
      name: 'sample.csv',
      status: 'processing',
      total_rows: null,
      processed_rows: 0,
      error: null,
    });
    await h.waitForJob(res.body.id);
  });

  test('GET /api/file/:id returns 404 for an unknown job', async () => {
    const res = await h.api().get('/api/file/00000000-0000-4000-8000-000000000000');
    assert.equal(res.status, 404);
  });
});

describe('importing the sample file', () => {
  test('first import inserts all rows and reports every row as new, ordered by id', async () => {
    const job = await h.seedSample();
    assert.equal(job.status, 'completed');
    assert.equal(job.total_rows, 500);
    assert.equal(job.processed_rows, 500);
    assert.equal(job.error, null);
    assert.equal(job.changed_rows.length, 500);
    assert.deepEqual(job.changed_rows.map((c) => c.id), h.idRange(1, 500));
    const records = h.sample();
    job.changed_rows.forEach((change, i) => {
      assert.equal(change.old, null);
      assert.equal(change.new.id, Number(records[i].id));
      assert.equal(change.new.name, records[i].name);
      assert.equal(change.new.email, records[i].email);
      assert.equal(change.new.body, records[i].body);
      assert.equal(Number(change.new.post_id), Number(records[i].postId));
      assert.equal(change.new.version, 1);
    });
    assert.equal(await h.countRows(), 500);
    assert.equal(await h.countRows('csv_row_history'), 0);
  });

  test('the BOM in the header is handled', async () => {
    const withBom = await h.importCsv(h.toCsv(h.onlyIds(h.sample(), [1, 2]), { bom: true }));
    assert.equal(withBom.status, 'completed');
    assert.equal((await h.dbRow(1)).name, h.sample()[0].name);
    await h.resetDb();
    const withoutBom = await h.importCsv(h.toCsv(h.onlyIds(h.sample(), [1, 2]), { bom: false }));
    assert.equal(withoutBom.status, 'completed');
    assert.equal(await h.countRows(), 2);
  });

  test('the original sample file with its BOM imports', async () => {
    const fs = require('fs');
    const job = await h.importCsv(fs.readFileSync('uploads/file.csv'));
    assert.equal(job.status, 'completed');
    assert.equal(job.total_rows, 500);
    assert.equal(await h.countRows(), 500);
  });

  test('re-importing identical data changes nothing', async () => {
    await h.seedSample();
    const job = await h.importCsv(h.toCsv(h.sample()));
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.changed_rows, []);
    const { rows } = await h.sql('SELECT MAX(version) AS v FROM csv_row');
    assert.equal(rows[0].v, 1);
    assert.equal(await h.countRows('csv_row_history'), 0);
  });

  test('changed rows get a version bump, history of the previous version and old/new in changed_rows', async () => {
    await h.seedSample();
    await h.sql("UPDATE csv_row SET date_created = '2020-01-02T03:04:05Z' WHERE id = 10");
    const before10 = await h.dbRow(10);
    const before30 = await h.dbRow(30);
    const csv = h.toCsv(h.withChanges(h.sample(), { 10: { name: 'renamed ten' }, 20: { body: 'new body' }, 30: { email: 'x@y.z' } }));
    const job = await h.importCsv(csv);
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.changed_rows.map((c) => c.id), [10, 20, 30]);

    const ten = job.changed_rows[0];
    assert.equal(ten.old.name, before10.name);
    assert.equal(ten.old.version, 1);
    assert.equal(ten.new.name, 'renamed ten');
    assert.equal(ten.new.version, 2);
    assert.equal(job.changed_rows[2].old.email, before30.email);
    assert.equal(job.changed_rows[2].new.email, 'x@y.z');

    const row10 = await h.dbRow(10);
    assert.equal(row10.version, 2);
    assert.equal(row10.name, 'renamed ten');
    assert.equal(row10.date_created.toISOString(), '2020-01-02T03:04:05.000Z');

    const history = await h.dbHistory(10);
    assert.equal(history.length, 1);
    assert.equal(history[0].version, 1);
    assert.equal(history[0].name, before10.name);
    assert.equal(history[0].date_created.toISOString(), '2020-01-02T03:04:05.000Z');
    assert.equal(await h.countRows('csv_row_history'), 3);
    assert.equal((await h.dbRow(11)).version, 1);
  });

  test('the same id twice in one file keeps the last occurrence and archives both earlier versions', async () => {
    await h.seedSample();
    const original = await h.dbRow(2);
    const records = h.onlyIds(h.sample(), [1, 2, 3]);
    records[1] = { ...records[1], name: 'first change' };
    records.push({ ...records[1], name: 'second change' });
    const job = await h.importCsv(h.toCsv(records));
    assert.equal(job.status, 'completed');

    const row = await h.dbRow(2);
    assert.equal(row.name, 'second change');
    assert.equal(row.version, 3);
    const history = await h.dbHistory(2);
    assert.deepEqual(history.map((x) => [x.version, x.name]), [[1, original.name], [2, 'first change']]);

    assert.deepEqual(job.changed_rows.map((c) => c.id), [2]);
    assert.equal(job.changed_rows[0].old.name, original.name);
    assert.equal(job.changed_rows[0].new.name, 'second change');
  });

  for (const [label, badId] of [['non-integer', 'abc'], ['decimal', '1.5'], ['zero', '0'], ['negative', '-3'], ['too large', '2147483648']]) {
    test(`an invalid id (${label}) fails the import and writes nothing`, async () => {
      await h.seedSample();
      const records = h.withChanges(h.sample(), { 1: { name: 'should not persist' } });
      records[249] = { ...records[249], id: badId };
      const job = await h.importCsv(h.toCsv(records));
      assert.equal(job.status, 'failed');
      assert.equal(job.error, 'Row 250: id must be a positive integer');
      assert.notEqual((await h.dbRow(1)).name, 'should not persist');
      assert.equal(await h.countRows('csv_row_history'), 0);
      assert.equal(await h.countRows(), 500);
    });
  }

  test('an invalid id on an empty table leaves the table empty', async () => {
    const records = h.sample();
    records[349] = { ...records[349], id: 'nope' };
    const job = await h.importCsv(h.toCsv(records));
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'Row 350: id must be a positive integer');
    assert.equal(await h.countRows(), 0);
  });

  test('a non-integer postId fails the import and writes nothing', async () => {
    const records = h.sample();
    records[120] = { ...records[120], postId: 'x' };
    const job = await h.importCsv(h.toCsv(records));
    assert.equal(job.status, 'failed');
    assert.match(job.error, /^Row 121: postId must be an integer/);
    assert.equal(await h.countRows(), 0);
  });

  test('the uploaded temp file is deleted after a completed import', async () => {
    const beforeFiles = h.uploadFiles();
    const job = await h.importCsv(h.toCsv(h.sample()));
    assert.equal(job.status, 'completed');
    await h.waitFor(() => JSON.stringify(h.uploadFiles()) === JSON.stringify(beforeFiles), { message: 'temp file removal' });
    assert.ok(h.uploadFiles().includes('file.csv'));
  });

  test('the uploaded temp file is deleted after a failed import', async () => {
    const beforeFiles = h.uploadFiles();
    const records = h.sample();
    records[0] = { ...records[0], id: 'bad' };
    const job = await h.importCsv(h.toCsv(records));
    assert.equal(job.status, 'failed');
    await h.waitFor(() => JSON.stringify(h.uploadFiles()) === JSON.stringify(beforeFiles), { message: 'temp file removal' });
  });
});
