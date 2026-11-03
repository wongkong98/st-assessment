const crypto = require('crypto');
const fs = require('fs');
const csvFile = require('./model');
const socket = require('../utils/socket');

const broadcastRows = (type, ids, excludeClientId) => {
  if (ids.length > 0) socket.broadcast({ type, ids }, excludeClientId);
};

const imports = new Map();
const IMPORT_TTL_MS = 10 * 60 * 1000;

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

const parsePositiveInt = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const MAX_ROW_ID = 2147483647;

const parseRowId = (value) => {
  const id = parsePositiveInt(value);
  return id && id <= MAX_ROW_ID ? id : null;
};

const MAX_TEXT_LENGTH = 255;

const validateRowFields = ({ name, email, body, post_id }) => {
  for (const [key, value] of Object.entries({ name, email })) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${key} must be a string.`;
    if (value.length > MAX_TEXT_LENGTH) return `${key} must be at most ${MAX_TEXT_LENGTH} characters.`;
  }
  if (body !== undefined && body !== null && typeof body !== 'string') {
    return 'body must be a string.';
  }
  if (post_id !== undefined) {
    const valid = typeof post_id === 'number'
      ? Number.isSafeInteger(post_id)
      : typeof post_id === 'string' && /^-?\d{1,15}$/.test(post_id.trim());
    if (!valid) return 'post_id must be an integer.';
  }
  return null;
};

const parseDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? false : date;
};

const uploadFile = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const job = {
    id: crypto.randomUUID(),
    name: req.file.originalname,
    status: 'processing',
    total_rows: null,
    processed_rows: 0,
    error: null,
  };
  imports.set(job.id, job);

  const force = req.body?.force === 'true';

  csvFile.importCSV(req.file.path, (progress) => Object.assign(job, progress), { force })
    .then(({ updatedIds, changedRows, concurrentChanges }) => {
      if (concurrentChanges) {
        job.concurrent_changes = concurrentChanges;
        job.status = 'stale';
        return;
      }
      broadcastRows('rows_updated', updatedIds);
      job.changed_rows = changedRows;
      job.status = 'completed';
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
      console.error(`Import ${job.id} failed:`, err.message);
    })
    .finally(() => {
      fs.promises.unlink(req.file.path).catch(() => {});
      setTimeout(() => imports.delete(job.id), IMPORT_TTL_MS).unref();
    });

  res.status(202).json(job);
};

const getImportProgress = (req, res) => {
  const job = imports.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Import not found.' });
  }
  res.json(job);
};

const getRows = async (req, res) => {
  const page = req.query.page === undefined ? 1 : parsePositiveInt(req.query.page);
  const limit = req.query.limit === undefined ? DEFAULT_PAGE_SIZE : parsePositiveInt(req.query.limit);
  if (!page || !limit || limit > MAX_PAGE_SIZE) {
    return res.status(400).json({ error: `page must be a positive integer and limit between 1 and ${MAX_PAGE_SIZE}.` });
  }

  const { search, from, to } = req.query;
  if ([search, from, to].some((value) => value !== undefined && typeof value !== 'string')) {
    return res.status(400).json({ error: 'search, from and to may each be given once.' });
  }

  const fromDate = parseDate(from);
  const toDate = parseDate(to);
  if (fromDate === false || toDate === false) {
    return res.status(400).json({ error: 'from and to must be valid dates.' });
  }
  if (fromDate && toDate && fromDate > toDate) {
    return res.status(400).json({ error: 'from must not be after to.' });
  }

  try {
    const rows = await csvFile.getAll(page, limit, { search: search?.trim(), from: fromDate, to: toDate });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch rows' });
  }
};

const getRow = async (req, res) => {
  const id = parseRowId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Invalid row id.' });
  }

  try {
    const row = await csvFile.findRowById(id);
    if (!row) {
      return res.status(404).json({ error: 'Row not found.' });
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch row' });
  }
};

const getRowHistory = async (req, res) => {
  const id = parseRowId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Invalid row id.' });
  }

  try {
    const [row, history] = await Promise.all([csvFile.findRowById(id), csvFile.getHistory(id)]);
    if (!row) {
      return res.status(404).json({ error: 'Row not found.' });
    }
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch row history' });
  }
};

const editRow = async (req, res) => {
  const id = parseRowId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Invalid row id.' });
  }

  const fields = req.body ?? {};
  const invalid = validateRowFields(fields);
  if (invalid) {
    return res.status(400).json({ error: invalid });
  }
  if (!csvFile.EDITABLE_COLUMNS.some((key) => fields[key] !== undefined)) {
    return res.status(400).json({ error: 'Nothing to update.' });
  }

  const version = parsePositiveInt(fields.version);
  if (!version || version > MAX_ROW_ID) {
    return res.status(400).json({ error: 'version of the row being edited is required.' });
  }

  try {
    const row = await csvFile.edit(id, version, fields);
    if (!row) {
      const current = await csvFile.findRowById(id);
      if (!current) {
        return res.status(404).json({ error: 'Row not found.' });
      }
      return res.status(409).json({ error: 'Row was changed by someone else.', row: current });
    }
    broadcastRows('rows_updated', [row.id], req.get('X-Client-Id'));
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update row' });
  }
};

const deleteRow = async (req, res) => {
  const id = parseRowId(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Invalid row id.' });
  }

  try {
    const row = await csvFile.delete(id);
    if (!row) {
      return res.status(404).json({ error: 'Row not found.' });
    }
    broadcastRows('rows_deleted', [row.id], req.get('X-Client-Id'));
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete row' });
  }
};

module.exports = { uploadFile, getImportProgress, getRows, getRow, getRowHistory, editRow, deleteRow };
