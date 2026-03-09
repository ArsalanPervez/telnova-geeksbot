const express = require('express');
const router  = express.Router();
const { lookup }            = require('../controllers/fcc.controller');
const { upload, uploadCSV } = require('../controllers/fcc-upload.controller');

// GET /api/fcc/lookup?zip=35801
router.get('/lookup', lookup);

// POST /api/fcc/upload  (multipart/form-data, field: "file")
router.post('/upload', upload.single('file'), uploadCSV);

module.exports = router;
