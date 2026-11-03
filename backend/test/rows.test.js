const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.setupDb);
after(h.teardownDb);
beforeEach(h.resetDb);

const ids = (res) => res.body.data.map((r) => r.id);
const list = (query) => h.api().get('/api/row').query(query);
const listRaw = (qs) => h.api().get(`/api/row?${qs}`);

const insertNumbered = (n, extra = () => ({})) => {
  const order = h.idRange(1, n).sort((a, b) => ((a * 7919) % n) - ((b * 7919) % n));
  return h.insertRows(order.map((id) => ({ id, name: `row ${id}`, email: `r${id}@example.com`, body: 'b', post_id: id, ...extra(id) })));
};

describe('GET /api/row pagination', () => {
  test('defaults to page 1 with 10 rows ordered by id', async () => {
    await insertNumbered(25);
    const res = await h.api().get('/api/row');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.metadata, {
      totalItems: 25,
      totalPages: 3,
      currentPage: 1,
      pageSize: 10,
      hasNextPage: true,
      hasPreviousPage: false,
    });
    assert.deepEqual(ids(res), h.idRange(1, 10));
  });

  test('returns the requested page and limit', async () => {
    await insertNumbered(25);
    const res = await list({ page: 3, limit: 10 });
    assert.deepEqual(ids(res), h.idRange(21, 25));
    assert.equal(res.body.metadata.hasNextPage, false);
    assert.equal(res.body.metadata.hasPreviousPage, true);
    const res2 = await list({ page: 2, limit: 7 });
    assert.deepEqual(ids(res2), h.idRange(8, 14));
    assert.equal(res2.body.metadata.totalPages, 4);
  });

  test('a page past the end returns empty data', async () => {
    await insertNumbered(25);
    const res = await list({ page: 4 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.metadata.totalItems, 25);
    assert.equal(res.body.metadata.currentPage, 4);
    assert.equal(res.body.metadata.hasNextPage, false);
  });

  test('an empty table returns no rows and zero pages', async () => {
    const res = await h.api().get('/api/row');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.metadata.totalItems, 0);
    assert.equal(res.body.metadata.totalPages, 0);
    assert.equal(res.body.metadata.hasNextPage, false);
  });

  test('limit 100 is allowed', async () => {
    await insertNumbered(120);
    const res = await list({ limit: 100 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 100);
  });

  for (const qs of ['page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=', 'limit=0', 'limit=-5', 'limit=2.5', 'limit=x', 'limit=101', 'limit=1000', 'page=1&page=2']) {
    test(`rejects ${qs} with 400`, async () => {
      const res = await listRaw(qs);
      assert.equal(res.status, 400);
      assert.ok(res.body.error);
    });
  }
});

describe('GET /api/row search', () => {
  beforeEach(() =>
    h.insertRows([
      { id: 1, name: 'Alpha Beta', email: 'a@x.com', body: 'hello' },
      { id: 2, name: 'gamma', email: 'GAMMA@y.com', body: 'percent 100% done' },
      { id: 3, name: 'delta_under', email: 'd@z.com', body: 'world' },
      { id: 4, name: 'deltaXunder', email: 'e@z.com', body: 'foo' },
      { id: 5, name: 'zeta', email: 'z@z.com', body: 'contains BETA in body' },
      { id: 6, name: 'back\\slash', email: 'b@z.com', body: 'bar' },
      { id: 7, name: null, email: null, body: null },
    ])
  );

  test('is a case-insensitive substring match over name and body', async () => {
    const res = await list({ search: 'beta' });
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res), [1, 5]);
    assert.equal(res.body.metadata.totalItems, 2);
  });

  test('matches email', async () => {
    assert.deepEqual(ids(await list({ search: 'gamma@Y' })), [2]);
    assert.deepEqual(ids(await list({ search: '@z.com' })), [3, 4, 5, 6]);
  });

  test('is trimmed', async () => {
    assert.deepEqual(ids(await list({ search: '   BeTa  ' })), [1, 5]);
  });

  test('treats % as a literal character', async () => {
    assert.deepEqual(ids(await list({ search: '%' })), [2]);
    assert.deepEqual(ids(await list({ search: '100%' })), [2]);
  });

  test('treats _ as a literal character', async () => {
    assert.deepEqual(ids(await list({ search: '_' })), [3]);
    assert.deepEqual(ids(await list({ search: 'delta_under' })), [3]);
  });

  test('treats a backslash as a literal character', async () => {
    assert.deepEqual(ids(await list({ search: '\\' })), [6]);
  });

  test('empty or whitespace-only search means no filter', async () => {
    assert.equal((await list({ search: '' })).body.metadata.totalItems, 7);
    assert.equal((await list({ search: '    ' })).body.metadata.totalItems, 7);
  });

  test('returns nothing when nothing matches', async () => {
    const res = await list({ search: 'no such text' });
    assert.deepEqual(res.body.data, []);
    assert.equal(res.body.metadata.totalItems, 0);
  });

  test('search given twice is rejected', async () => {
    assert.equal((await listRaw('search=a&search=b')).status, 400);
  });
});

describe('GET /api/row date filter', () => {
  beforeEach(() =>
    h.insertRows([
      { id: 1, name: 'jan first', date_created: '2024-01-01T00:00:00Z' },
      { id: 2, name: 'jan mid', date_created: '2024-01-15T12:00:00Z' },
      { id: 3, name: 'jan last', date_created: '2024-01-31T00:00:00Z' },
      { id: 4, name: 'feb', date_created: '2024-02-10T00:00:00Z' },
    ])
  );

  test('from is inclusive', async () => {
    assert.deepEqual(ids(await list({ from: '2024-01-15T12:00:00Z' })), [2, 3, 4]);
    assert.deepEqual(ids(await list({ from: '2024-01-01T00:00:00Z' })), [1, 2, 3, 4]);
  });

  test('to is inclusive', async () => {
    assert.deepEqual(ids(await list({ to: '2024-01-15T12:00:00Z' })), [1, 2]);
  });

  test('from and to together select an inclusive range', async () => {
    assert.deepEqual(ids(await list({ from: '2024-01-15T12:00:00Z', to: '2024-01-31T00:00:00Z' })), [2, 3]);
    assert.deepEqual(ids(await list({ from: '2024-01-31T00:00:00Z', to: '2024-01-31T00:00:00Z' })), [3]);
  });

  test('accepts plain dates', async () => {
    assert.deepEqual(ids(await list({ from: '2024-01-02', to: '2024-02-01' })), [2, 3]);
  });

  for (const qs of ['from=notadate', 'to=2024-13-45', 'from=yesterday&to=2024-01-01']) {
    test(`an invalid date (${qs}) is rejected with 400`, async () => {
      const res = await listRaw(qs);
      assert.equal(res.status, 400);
      assert.ok(res.body.error);
    });
  }

  test('from after to is rejected with 400', async () => {
    const res = await list({ from: '2024-02-01', to: '2024-01-01' });
    assert.equal(res.status, 400);
  });

  for (const qs of ['from=2024-01-01&from=2024-01-02', 'to=2024-01-01&to=2024-01-02']) {
    test(`a repeated date parameter (${qs}) is rejected with 400`, async () => {
      assert.equal((await listRaw(qs)).status, 400);
    });
  }

  test('combines with search and pagination, and totals reflect the filter', async () => {
    await h.insertRows(
      h.idRange(10, 34).map((id) => ({
        id,
        name: id % 2 ? 'match odd' : 'other',
        date_created: id < 30 ? '2024-03-01T00:00:00Z' : '2025-01-01T00:00:00Z',
      }))
    );
    const res = await list({ search: 'MATCH', from: '2024-02-15', to: '2024-12-31', page: 2, limit: 4 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.metadata, {
      totalItems: 10,
      totalPages: 3,
      currentPage: 2,
      pageSize: 4,
      hasNextPage: true,
      hasPreviousPage: true,
    });
    assert.deepEqual(ids(res), [19, 21, 23, 25]);
  });
});

describe('GET /api/row/:id', () => {
  test('returns the row', async () => {
    await h.insertRows([{ id: 42, name: 'n', email: 'e', body: 'b', post_id: 7 }]);
    const res = await h.api().get('/api/row/42');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 42);
    assert.equal(res.body.name, 'n');
    assert.equal(res.body.post_id, '7');
    assert.equal(res.body.version, 1);
    assert.ok(res.body.date_created);
  });

  test('returns 404 for a missing row', async () => {
    assert.equal((await h.api().get('/api/row/43')).status, 404);
  });

  for (const bad of ['abc', '0', '-1', '1.5', '2147483648', '99999999999']) {
    test(`returns 400 for invalid id ${bad}`, async () => {
      assert.equal((await h.api().get(`/api/row/${bad}`)).status, 400);
    });
  }

  test('accepts the largest integer id', async () => {
    assert.equal((await h.api().get('/api/row/2147483647')).status, 404);
  });
});

describe('GET /api/row/:id/history', () => {
  test('returns 404 when the row does not exist', async () => {
    assert.equal((await h.api().get('/api/row/5/history')).status, 404);
  });

  test('returns 400 for an invalid id', async () => {
    assert.equal((await h.api().get('/api/row/0/history')).status, 400);
    assert.equal((await h.api().get('/api/row/2147483648/history')).status, 400);
  });

  test('returns [] for a row that was never changed', async () => {
    await h.insertRows([{ id: 5, name: 'five' }]);
    const res = await h.api().get('/api/row/5/history');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('lists archived versions newest first', async () => {
    await h.insertRows([{ id: 5, name: 'v1' }]);
    for (let v = 1; v <= 3; v++) {
      const res = await h.api().put('/api/row/5').send({ version: v, name: `v${v + 1}` });
      assert.equal(res.status, 200);
    }
    const res = await h.api().get('/api/row/5/history');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((x) => [x.version, x.name]), [[3, 'v3'], [2, 'v2'], [1, 'v1']]);
    const ids = res.body.map((x) => x.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));
    for (const entry of res.body) {
      assert.equal(entry.row_id, 5);
      assert.ok(!Number.isNaN(new Date(entry.date_archived).getTime()));
      assert.ok(entry.date_created);
    }
  });
});
