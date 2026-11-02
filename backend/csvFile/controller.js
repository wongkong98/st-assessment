const csvFile = require('./model');

const getFiles = async (req, res) => {
  try {
    const files = await csvFile.getAll();
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch files' });
  }
};

const getFileById = async (req, res) => {
  try {
    const fileId = req.params.id;
    const file = await csvFile.findById(fileId);
    res.json(file);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch file' });
  }
};

const uploadFile = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    const now = new Date();
    const { name } = req.body;
    const path = '/uploads/' + req.file.originalname;
    
    const newFile = await csvFile.create(name, path, now);
    res.status(201).json(newFile);
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload file' });
  }
};

module.exports = { getFiles, getFileById, uploadFile };