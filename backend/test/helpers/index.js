const fs = require('fs');
const path = require('path');
const http = require('http');

const BACKEND_DIR = path.resolve(__dirname, '..', '..');
process.chdir(BACKEND_DIR);

const dotenv = require('dotenv');
const fileEnv = fs.existsSync('.env') ? dotenv.parse(fs.readFileSync('.env')) : {};
const envOr = (key, fallback) => process.env[key] || fileEnv[key] || fallback;

const testFile = process.argv[1] ? path.basename(process.argv[1]).replace(/\.test\.js$|\.js$/, '') : 'main';
const TEST_DB = `csv_backend_test_${testFile.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
if (TEST_DB === 'mydb') throw new Error('Refusing to use the mydb database for tests');

const conn = {
  host: envOr('DB_HOST', 'localhost'),
  port: Number(envOr('DB_PORT', 5433)),
  user: envOr('DB_USER', 'postgres'),
  password: envOr('DB_PASSWORD', 'admin'),
};
process.env.DB_HOST = conn.host;
process.env.DB_PORT = String(conn.port);
process.env.DB_USER = conn.user;
process.env.DB_PASSWORD = conn.password;
process.env.DB_NAME = TEST_DB;
process.env.DOTENV_CONFIG_QUIET = 'true';

const { Client } = require('pg');
const { parse } = require('csv-parse/sync');
const supertest = require('supertest');
const { WebSocket } = require('ws');
const app = require('../../app');
const socket = require('../../utils/socket');

let sqlClient = null;

const adminQuery = async (text) => {
  const admin = new Client({ ...conn, database: 'postgres' });
  await admin.connect();
  try {
    return await admin.query(text);
  } finally {
    await admin.end();
  }
};

const setupDb = async () => {
  await adminQuery(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE ${TEST_DB}`);
  sqlClient = new Client({ ...conn, database: TEST_DB });
  await sqlClient.connect();
  await sqlClient.query(fs.readFileSync(path.join(BACKEND_DIR, '..', 'db', 'init.sql'), 'utf8'));
};

const teardownDb = async () => {
  if (sqlClient) await sqlClient.end().catch(() => {});
  sqlClient = null;
  await adminQuery(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
};

const sql = (text, params) => sqlClient.query(text, params);

const resetDb = () => sql('TRUNCATE csv_row, csv_row_history RESTART IDENTITY');

const insertRows = async (rows) => {
  for (const r of rows) {
    await sql(
      `INSERT INTO csv_row(id, name, email, body, post_id, date_created, version)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()), COALESCE($7, 1))`,
      [r.id, r.name ?? null, r.email ?? null, r.body ?? null, r.post_id ?? 1, r.date_created ?? null, r.version ?? null]
    );
  }
};

const dbRow = async (id) => (await sql('SELECT * FROM csv_row WHERE id = $1', [id])).rows[0] || null;
const dbHistory = async (id) =>
  (await sql('SELECT * FROM csv_row_history WHERE row_id = $1 ORDER BY id', [id])).rows;
const countRows = async (table = 'csv_row') => Number((await sql(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);

const SAMPLE_PATH = path.join(BACKEND_DIR, 'uploads', 'file.csv');
const sampleText = fs.readFileSync(SAMPLE_PATH, 'utf8');
const SAMPLE = parse(sampleText, { columns: true, bom: true, skip_empty_lines: true, trim: true });
const COLUMNS = ['postId', 'id', 'name', 'email', 'body'];

const sample = () => SAMPLE.map((r) => ({ ...r }));
const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const toCsv = (records, { bom = true } = {}) =>
  (bom ? '﻿' : '') +
  [COLUMNS.map(quote).join(','), ...records.map((r) => COLUMNS.map((c) => quote(r[c])).join(','))].join('\n') +
  '\n';
const onlyIds = (records, ids) => {
  const set = new Set(ids.map(String));
  return records.filter((r) => set.has(String(r.id)));
};
const withChanges = (records, changes) =>
  records.map((r) => (changes[r.id] ? { ...r, ...changes[r.id] } : r));
const repeat = (records, times, variant = (r) => r) => {
  const out = [];
  for (let i = 0; i < times; i++) for (const r of records) out.push(variant(r, i));
  return out;
};
const idRange = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const bigCsv = (tag, { ids = idRange(1, 500), times = 40 } = {}) =>
  toCsv(repeat(onlyIds(sample(), ids), times, (r, i) => ({ ...r, name: `${r.name} ${tag}${i}` })));

const api = () => supertest(app);

const upload = async (csv, { name = 'test.csv', force = false, agent = api() } = {}) => {
  let req = agent.post('/api/file');
  if (force) req = req.field('force', 'true');
  const res = await req.attach('file', Buffer.from(csv), name);
  if (res.status !== 202) throw new Error(`upload failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

const getJob = async (id, agent = api()) => (await agent.get(`/api/file/${id}`)).body;

const waitFor = async (fn, { timeout = 30000, interval = 20, message = 'condition' } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((r) => setTimeout(r, interval));
  }
};

const FINAL = new Set(['completed', 'failed', 'stale']);
const waitForJob = (id, { timeout = 120000, agent } = {}) =>
  waitFor(async () => {
    const job = await getJob(id, agent);
    return FINAL.has(job.status) ? job : null;
  }, { timeout, interval: 50, message: `import ${id} to finish` });

const importCsv = async (csv, opts = {}) => waitForJob((await upload(csv, opts)).id, opts);

const seedSample = async () => {
  const job = await importCsv(toCsv(sample()));
  if (job.status !== 'completed') throw new Error(`seed failed: ${JSON.stringify(job)}`);
  return job;
};

const startServer = async () => {
  const server = http.createServer(app);
  socket.attach(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { server, url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/api/ws`, close };
};

const connectClient = (wsUrl) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const queue = [];
    let waiter = null;
    const client = {
      ws,
      clientId: null,
      next(timeout = 5000) {
        if (queue.length) return Promise.resolve(queue.shift());
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            waiter = null;
            rej(new Error('Timed out waiting for a websocket message'));
          }, timeout);
          waiter = (msg) => {
            clearTimeout(timer);
            res(msg);
          };
        });
      },
      pending: () => queue.slice(),
      close: () =>
        new Promise((res) => {
          if (ws.readyState === WebSocket.CLOSED) return res();
          ws.once('close', res);
          ws.close();
        }),
    };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (!client.clientId && msg.type === 'connected') {
        client.clientId = msg.clientId;
        client.firstMessage = msg;
        return resolve(client);
      }
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(msg);
      } else queue.push(msg);
    });
    ws.once('error', reject);
  });

const uploadFiles = () => fs.readdirSync(path.join(BACKEND_DIR, 'uploads')).sort();

module.exports = {
  TEST_DB,
  app,
  api,
  sql,
  setupDb,
  teardownDb,
  resetDb,
  insertRows,
  dbRow,
  dbHistory,
  countRows,
  sample,
  toCsv,
  onlyIds,
  withChanges,
  repeat,
  idRange,
  bigCsv,
  upload,
  getJob,
  waitFor,
  waitForJob,
  importCsv,
  seedSample,
  startServer,
  connectClient,
  uploadFiles,
};
