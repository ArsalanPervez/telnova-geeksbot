const response = require('../utils/apiResponse');
const prisma = require('../config/prisma');

const getTickets = async (req, res) => {
  try {
    const { status, type, priority, agentId, userId, page = 1, limit = 20 } = req.query;

    const where = {};
    if (status) where.status = status;
    if (type) where.type = type;
    if (priority) where.priority = parseInt(priority);
    if (agentId) where.agentId = agentId;
    if (userId) where.userId = userId;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const [tickets, total] = await Promise.all([
      prisma.ticket.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          agent: { select: { id: true, name: true, email: true } },
        },
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        skip,
        take,
      }),
      prisma.ticket.count({ where }),
    ]);

    return response.success(res, 'Tickets retrieved successfully', {
      tickets,
      pagination: {
        total,
        page: parseInt(page),
        limit: take,
        totalPages: Math.ceil(total / take),
      },
    });
  } catch (err) {
    console.error('[GET TICKETS]', err.message);
    return response.error(res, 'Failed to retrieve tickets', 500);
  }
};

const getTicketById = async (req, res) => {
  try {
    const { id } = req.params;

    const ticket = await prisma.ticket.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        agent: { select: { id: true, name: true, email: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!ticket) {
      return response.error(res, 'Ticket not found', 404);
    }

    // Fetch FCC provider details if ticket has a ZIP
    let providers = null;
    if (ticket.zip) {
      const rows = await prisma.zipProvider.findMany({ where: { zip: ticket.zip } });
      if (rows.length > 0) {
        providers = {
          zip: ticket.zip,
          city: rows[0].city,
          state: rows[0].stateUsps,
          list: rows
            .map(r => ({ brand: r.brandName, tech: r.technology, dl: r.maxDlSpeed, ul: r.maxUlSpeed, ll: r.lowLatency, svc: r.serviceType }))
            .sort((a, b) => b.dl - a.dl || a.brand.localeCompare(b.brand)),
          total: rows.length,
        };
      }
    }

    return response.success(res, 'Ticket retrieved successfully', { ...ticket, providers });
  } catch (err) {
    console.error('[GET TICKET]', err.message);
    return response.error(res, 'Failed to retrieve ticket', 500);
  }
};

const createTicket = async (req, res) => {
  try {
    const { type, subject, priority, message, zip } = req.body;
    const userId = req.user.id;

    if (!type || !subject) {
      return response.error(res, 'type and subject are required', 400);
    }

    const validTypes = ['BILLING', 'TECHNICAL', 'PLAN_CHANGE', 'CANCELLATION', 'GENERAL'];
    if (!validTypes.includes(type)) {
      return response.error(res, `type must be one of: ${validTypes.join(', ')}`, 400);
    }

    const ticket = await prisma.ticket.create({
      data: {
        userId,
        type,
        subject,
        zip: zip || null,
        priority: priority ? parseInt(priority) : 3,
        ...(message && {
          messages: {
            create: {
              senderType: 'USER',
              senderId: userId,
              message,
            },
          },
        }),
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        agent: { select: { id: true, name: true, email: true } },
        messages: true,
      },
    });

    return response.created(res, 'Ticket created successfully', ticket);
  } catch (err) {
    console.error('[CREATE TICKET]', err.message);
    return response.error(res, 'Failed to create ticket', 500);
  }
};

const assignTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const { agentId } = req.body;

    if (!agentId) {
      return response.error(res, 'agentId is required', 400);
    }

    // Verify ticket exists
    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) {
      return response.error(res, 'Ticket not found', 404);
    }

    // Verify agent exists and has AGENT role
    const agent = await prisma.user.findFirst({ where: { id: agentId, role: 'AGENT' } });
    if (!agent) {
      return response.error(res, 'Agent not found', 404);
    }

    const updated = await prisma.ticket.update({
      where: { id },
      data: {
        agentId,
        status: 'IN_PROGRESS',
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        agent: { select: { id: true, name: true, email: true } },
      },
    });

    return response.success(res, 'Ticket assigned successfully', updated);
  } catch (err) {
    console.error('[ASSIGN TICKET]', err.message);
    return response.error(res, 'Failed to assign ticket', 500);
  }
};

const completeTicket = async (req, res) => {
  try {
    const { id } = req.params;
    const agentId = req.user.id;

    const ticket = await prisma.ticket.findUnique({ where: { id } });
    if (!ticket) {
      return response.error(res, 'Ticket not found', 404);
    }

    if (ticket.agentId !== agentId) {
      return response.error(res, 'Only the assigned agent can complete this ticket', 403);
    }

    if (ticket.status === 'CLOSED') {
      return response.error(res, 'Ticket is already closed', 400);
    }

    const updated = await prisma.ticket.update({
      where: { id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        agent: { select: { id: true, name: true, email: true } },
      },
    });

    return response.success(res, 'Ticket completed successfully', updated);
  } catch (err) {
    console.error('[COMPLETE TICKET]', err.message);
    return response.error(res, 'Failed to complete ticket', 500);
  }
};

module.exports = { getTickets, getTicketById, createTicket, assignTicket, completeTicket };
