const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

before(h.setupDb);
after(h.teardownDb);
beforeEach(async () => {
  await h.resetDb();
  await h.insertRows([
    { id: 1, name: 'one', email: 'one@example.com', body: 'body one', post_id: 3, date_created: '2023-05-06T07:08:09Z' },
    { id: 2, name: 'two', email: 'two@example.com', body: 'body two', post_id: 4 },
  ]);
});

const put = (id, body) => h.api().put(`/api/row/${id}`).send(body);

describe('PUT /api/row/:id', () => {
  test('updates the row, bumps the version and archives the previous version', async () => {
    const res = await put(1, { version: 1, name: 'uno', body: 'cuerpo' });
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 1);
    assert.equal(res.body.name, 'uno');
    assert.equal(res.body.body, 'cuerpo');
    assert.equal(res.body.email, 'one@example.com');
    assert.equal(res.body.post_id, '3');
    assert.equal(res.body.version, 2);
    assert.equal(new Date(res.body.date_created).toISOString(), '2023-05-06T07:08:09.000Z');

    const history = await h.dbHistory(1);
    assert.equal(history.length, 1);
    assert.equal(history[0].version, 1);
    assert.equal(history[0].name, 'one');
    assert.equal(history[0].body, 'body one');
    assert.equal(history[0].post_id, '3');
    assert.equal(history[0].date_created.toISOString(), '2023-05-06T07:08:09.000Z');
    assert.equal((await h.dbHistory(2)).length, 0);
  });

  test('accepts post_id as a number or a numeric string', async () => {
    const a = await put(1, { version: 1, post_id: 12 });
    assert.equal(a.status, 200);
    assert.equal(a.body.post_id, '12');
    const b = await put(1, { version: 2, post_id: '13' });
    assert.equal(b.status, 200);
    assert.equal(b.body.post_id, '13');
  });

  test('allows clearing a text field with null', async () => {
    const res = await put(1, { version: 1, email: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.email, null);
  });

  test('requires version', async () => {
    const res = await put(1, { name: 'x' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /version/);
    assert.equal((await h.dbRow(1)).name, 'one');
  });

  for (const version of [0, -1, 1.5, 'abc', null]) {
    test(`rejects version ${JSON.stringify(version)}`, async () => {
      assert.equal((await put(1, { name: 'x', version })).status, 400);
    });
  }

  test('rejects a body without editable fields', async () => {
    const res = await put(1, { version: 1, id: 99, version_extra: 1 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Nothing to update.');
    assert.equal((await put(1, { version: 1 })).body.error, 'Nothing to update.');
  });

  const invalid = {
    'post_id null': { post_id: null },
    'post_id empty string': { post_id: '' },
    'post_id decimal': { post_id: 1.5 },
    'post_id too long': { post_id: '99999999999999999999' },
    'post_id non-numeric string': { post_id: '12abc' },
    'post_id boolean': { post_id: true },
    'name too long': { name: 'n'.repeat(256) },
    'email too long': { email: 'e'.repeat(256) },
    'name not a string': { name: 123 },
    'email not a string': { email: { a: 1 } },
    'body not a string': { body: ['x'] },
  };
  for (const [label, fields] of Object.entries(invalid)) {
    test(`rejects ${label} with 400 and leaves the row unchanged`, async () => {
      const res = await put(1, { version: 1, ...fields });
      assert.equal(res.status, 400);
      assert.ok(res.body.error);
      const row = await h.dbRow(1);
      assert.equal(row.version, 1);
      assert.equal(row.name, 'one');
      assert.equal((await h.dbHistory(1)).length, 0);
    });
  }

  test('allows name and email of exactly 255 characters and a long body', async () => {
    const res = await put(1, { version: 1, name: 'n'.repeat(255), email: 'e'.repeat(255), body: 'b'.repeat(5000) });
    assert.equal(res.status, 200);
  });

  test('returns 409 with the current row when the version is stale', async () => {
    assert.equal((await put(1, { version: 1, name: 'first' })).status, 200);
    const res = await put(1, { version: 1, name: 'second' });
    assert.equal(res.status, 409);
    assert.ok(res.body.error);
    assert.equal(res.body.row.id, 1);
    assert.equal(res.body.row.name, 'first');
    assert.equal(res.body.row.version, 2);
    assert.equal((await h.dbHistory(1)).length, 1);
  });

  test('returns 409 for a version ahead of the current one', async () => {
    assert.equal((await put(1, { version: 5, name: 'x' })).status, 409);
  });

  test('returns 404 for a missing row', async () => {
    assert.equal((await put(999, { version: 1, name: 'x' })).status, 404);
  });

  for (const bad of ['abc', '0', '2147483648']) {
    test(`returns 400 for invalid id ${bad}`, async () => {
      assert.equal((await put(bad, { version: 1, name: 'x' })).status, 400);
    });
  }

  test('of six simultaneous edits with the same version exactly one wins', async () => {
    const results = await Promise.all(h.idRange(1, 6).map((i) => put(1, { version: 1, name: `writer ${i}` })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409, 409, 409, 409]);
    const winner = results.find((r) => r.status === 200).body;
    const row = await h.dbRow(1);
    assert.equal(row.version, 2);
    assert.equal(row.name, winner.name);
    for (const r of results.filter((x) => x.status === 409)) assert.equal(r.body.row.version, 2);
    const history = await h.dbHistory(1);
    assert.equal(history.length, 1);
    assert.equal(history[0].version, 1);
    assert.equal(history[0].name, 'one');
  });
});

describe('DELETE /api/row/:id', () => {
  test('returns 204 and the row is gone', async () => {
    const res = await h.api().delete('/api/row/1');
    assert.equal(res.status, 204);
    assert.equal((await h.api().get('/api/row/1')).status, 404);
    assert.equal(await h.dbRow(1), null);
    assert.ok(await h.dbRow(2));
  });

  test('a second delete returns 404', async () => {
    assert.equal((await h.api().delete('/api/row/1')).status, 204);
    assert.equal((await h.api().delete('/api/row/1')).status, 404);
  });

  for (const bad of ['abc', '0', '-2', '2147483648']) {
    test(`returns 400 for invalid id ${bad}`, async () => {
      assert.equal((await h.api().delete(`/api/row/${bad}`)).status, 400);
    });
  }

  test('deletes the row history too', async () => {
    assert.equal((await put(1, { version: 1, name: 'x' })).status, 200);
    assert.equal((await put(2, { version: 1, name: 'y' })).status, 200);
    assert.equal((await h.dbHistory(1)).length, 1);
    assert.equal((await h.api().delete('/api/row/1')).status, 204);
    assert.equal((await h.dbHistory(1)).length, 0);
    assert.equal((await h.dbHistory(2)).length, 1);
    assert.equal((await h.api().get('/api/row/1/history')).status, 404);
  });
});
