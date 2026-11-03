const { describe, test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const supertest = require('supertest');
const h = require('./helpers');

let srv;
let clients = [];
const api = () => supertest(srv.url);

before(async () => {
  await h.setupDb();
  srv = await h.startServer();
});
after(async () => {
  if (srv) await srv.close();
  await h.teardownDb();
});
beforeEach(async () => {
  await h.resetDb();
  clients = await Promise.all([1, 2, 3].map(() => h.connectClient(srv.wsUrl)));
});
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

const SENTINEL_ID = 499;

const expectOnlySentinelNext = async () => {
  const row = (await api().get(`/api/row/${SENTINEL_ID}`)).body;
  const res = await api().put(`/api/row/${SENTINEL_ID}`).send({ version: row.version, name: `sentinel ${row.version}` });
  assert.equal(res.status, 200);
  for (const c of clients) assert.deepEqual(await c.next(), { type: 'rows_updated', ids: [SENTINEL_ID] });
};

const insertBasicRows = () =>
  h.insertRows([1, 2, 3, SENTINEL_ID].map((id) => ({ id, name: `row ${id}`, email: 'e', body: 'b', post_id: 1 })));

describe('websocket connection', () => {
  test('sends a connected message with a client id', () => {
    const ids = new Set();
    for (const c of clients) {
      assert.equal(c.firstMessage.type, 'connected');
      assert.match(c.clientId, /^[0-9a-f-]{36}$/);
      ids.add(c.clientId);
    }
    assert.equal(ids.size, 3);
  });

  test('only accepts connections on /api/ws', async () => {
    await assert.rejects(h.connectClient(srv.wsUrl.replace('/api/ws', '/other')));
  });
});

describe('row change broadcasts', () => {
  beforeEach(insertBasicRows);

  test('an edit is broadcast to everyone except the client named in X-Client-Id', async () => {
    const [sender, b, c] = clients;
    const res = await api().put('/api/row/1').set('X-Client-Id', sender.clientId).send({ version: 1, name: 'x' });
    assert.equal(res.status, 200);
    assert.deepEqual(await b.next(), { type: 'rows_updated', ids: [1] });
    assert.deepEqual(await c.next(), { type: 'rows_updated', ids: [1] });
    await expectOnlySentinelNext();
  });

  test('an edit without X-Client-Id is broadcast to everyone', async () => {
    assert.equal((await api().put('/api/row/2').send({ version: 1, name: 'y' })).status, 200);
    for (const c of clients) assert.deepEqual(await c.next(), { type: 'rows_updated', ids: [2] });
  });

  test('a delete is broadcast as rows_deleted except to the sender', async () => {
    const [a, sender, c] = clients;
    assert.equal((await api().delete('/api/row/3').set('X-Client-Id', sender.clientId)).status, 204);
    assert.deepEqual(await a.next(), { type: 'rows_deleted', ids: [3] });
    assert.deepEqual(await c.next(), { type: 'rows_deleted', ids: [3] });
    await expectOnlySentinelNext();
  });

  test('a delete without X-Client-Id is broadcast to everyone', async () => {
    assert.equal((await api().delete('/api/row/3')).status, 204);
    for (const c of clients) assert.deepEqual(await c.next(), { type: 'rows_deleted', ids: [3] });
  });

  test('failed edits and deletes broadcast nothing', async () => {
    assert.equal((await api().put('/api/row/77').send({ version: 1, name: 'x' })).status, 404);
    assert.equal((await api().delete('/api/row/77')).status, 404);
    assert.equal((await api().put('/api/row/1').send({ version: 9, name: 'x' })).status, 409);
    assert.equal((await api().put('/api/row/1').send({ version: 1, post_id: 'x' })).status, 400);
    await expectOnlySentinelNext();
  });
});

describe('import broadcasts', () => {
  beforeEach(async () => {
    await h.seedSample();
  });

  test('the first import of new rows broadcasts nothing', async () => {
    await expectOnlySentinelNext();
  });

  test('a completed import broadcasts only existing rows whose data changed', async () => {
    const records = h.withChanges(h.onlyIds(h.sample(), [1, 2, 3, 4, 5]), { 2: { name: 'two!' }, 4: { body: 'four!' } });
    records.push({ postId: '9', id: '600', name: 'new', email: 'n@e', body: 'b' });
    const job = await h.importCsv(h.toCsv(records));
    assert.equal(job.status, 'completed');
    for (const c of clients) {
      const msg = await c.next();
      assert.equal(msg.type, 'rows_updated');
      assert.deepEqual([...msg.ids].sort((x, y) => x - y), [2, 4]);
    }
    await expectOnlySentinelNext();
  });

  test('an import that changes nothing broadcasts nothing', async () => {
    const job = await h.importCsv(h.toCsv(h.sample()));
    assert.equal(job.status, 'completed');
    await expectOnlySentinelNext();
  });

  test('a failed import broadcasts nothing', async () => {
    const records = h.withChanges(h.sample(), { 1: { name: 'changed' } });
    records[300] = { ...records[300], id: 'bad' };
    const job = await h.importCsv(h.toCsv(records));
    assert.equal(job.status, 'failed');
    await expectOnlySentinelNext();
  });

  test('a stale import broadcasts nothing', { timeout: 120000 }, async () => {
    const a = await h.upload(h.bigCsv('A', { ids: h.idRange(1, 100), times: 20 }));
    await h.waitFor(async () => (await h.getJob(a.id)).processed_rows > 0, { interval: 10, timeout: 60000 });
    const b = await h.upload(h.toCsv(h.withChanges(h.onlyIds(h.sample(), [1, 2]), { 1: { name: 'b' } })));
    await h.waitFor(async () => (await h.getJob(b.id)).status === 'waiting', { interval: 10, timeout: 60000 });
    assert.equal((await h.waitForJob(a.id)).status, 'completed');
    assert.equal((await h.waitForJob(b.id)).status, 'stale');
    for (const c of clients) {
      const msg = await c.next();
      assert.equal(msg.type, 'rows_updated');
      assert.equal(msg.ids.length, 100);
    }
    await expectOnlySentinelNext();
  });

  test('a row inserted and then changed within the same import is not broadcast as an existing row', async () => {
    const records = [
      { postId: '1', id: '700', name: 'first', email: 'e', body: 'b' },
      { postId: '1', id: '700', name: 'second', email: 'e', body: 'b' },
    ];
    const job = await h.importCsv(h.toCsv(records));
    assert.equal(job.status, 'completed');
    await expectOnlySentinelNext();
  });
});
