const express = require('express');
const router = express.Router();
const csvFileController = require('../csvFile/controller');
const upload = require('../utils/upload');

router.post('/file', upload.single('file'), csvFileController.uploadFile);
router.get('/file/:id', csvFileController.getImportProgress);
router.get('/row', csvFileController.getRows);
router.get('/row/:id', csvFileController.getRow);
router.put('/row/:id', csvFileController.editRow);
router.delete('/row/:id', csvFileController.deleteRow);
router.get('/row/:id/history', csvFileController.getRowHistory);

module.exports = router;