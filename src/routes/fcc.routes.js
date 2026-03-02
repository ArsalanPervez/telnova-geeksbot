const express = require('express');
const router  = express.Router();
const { lookup } = require('../controllers/fcc.controller');

// GET /api/fcc/lookup?zip=35801
router.get('/lookup', lookup);

module.exports = router;
