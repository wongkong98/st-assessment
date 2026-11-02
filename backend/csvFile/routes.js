const express = require('express');
const router = express.Router();
const csvFileController = require('../csvFile/controller');
const upload = require('../utils/upload');

router.get('/file', csvFileController.getFiles);
router.get('/file/:id', csvFileController.getFileById);
router.post('/file', upload.single('file'), csvFileController.uploadFile);

module.exports = router;