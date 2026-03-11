const express = require('express');
const router = express.Router();
const { getAgents, getAgentById, createAgent, updateAgent } = require('../controllers/agent.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

// GET /api/agents
router.get('/', authenticate, getAgents);

// GET /api/agents/:id
router.get('/:id', authenticate, getAgentById);

// POST /api/agents
router.post('/', authenticate, authorize('ADMIN'), createAgent);

// PATCH /api/agents/:id
router.patch('/:id', authenticate, authorize('ADMIN'), updateAgent);

module.exports = router;
