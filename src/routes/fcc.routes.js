const express = require('express');
const router  = express.Router();
const { lookup }            = require('../controllers/fcc.controller');
const { upload, uploadCSV } = require('../controllers/fcc-upload.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

// GET /api/fcc/lookup?zip=35801
router.get('/lookup', lookup);

// POST /api/fcc/upload  (multipart/form-data, field: "file")  — ADMIN only
router.post('/upload', authenticate, authorize('ADMIN'), upload.single('file'), uploadCSV);

module.exports = router;
