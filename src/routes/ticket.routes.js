const express = require('express');
const router = express.Router();
const { getTickets, getTicketById, createTicket, assignTicket, completeTicket } = require('../controllers/ticket.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

// GET /api/tickets
router.get('/', authenticate, getTickets);

// GET /api/tickets/:id
router.get('/:id', authenticate, getTicketById);

// POST /api/tickets
router.post('/', authenticate, createTicket);

// PATCH /api/tickets/:id/assign — Admin assigns ticket to an agent
router.patch('/:id/assign', authenticate, authorize('ADMIN'), assignTicket);

// PATCH /api/tickets/:id/complete — Agent marks ticket as complete
router.patch('/:id/complete', authenticate, authorize('AGENT'), completeTicket);

module.exports = router;
