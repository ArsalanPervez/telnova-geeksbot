const bcrypt = require('bcryptjs');
const response = require('../utils/apiResponse');
const prisma = require('../config/prisma');
const { validateRegisterInput } = require('../utils/validators');

const getAgents = async (req, res) => {
  try {
    const agents = await prisma.user.findMany({
      where: { role: 'AGENT' },
      select: { id: true, name: true, email: true, phone: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    return response.success(res, 'Agents retrieved successfully', {
      agents,
      total: agents.length,
    });
  } catch (err) {
    console.error('[GET AGENTS]', err.message);
    return response.error(res, 'Failed to retrieve agents', 500);
  }
};

const getAgentById = async (req, res) => {
  try {
    const { id } = req.params;

    const agent = await prisma.user.findFirst({
      where: { id, role: 'AGENT' },
      select: { id: true, name: true, email: true, phone: true, status: true, createdAt: true },
    });

    if (!agent) {
      return response.error(res, 'Agent not found', 404);
    }

    return response.success(res, 'Agent retrieved successfully', agent);
  } catch (err) {
    console.error('[GET AGENT]', err.message);
    return response.error(res, 'Failed to retrieve agent', 500);
  }
};

const createAgent = async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    // Validate input
    const validation = validateRegisterInput({ name, email, password, phone });
    if (!validation.isValid) {
      return response.validationError(res, validation.errors);
    }

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (existingUser) {
      return response.error(res, 'Email already registered', 409);
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const agent = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase(),
        password: hashedPassword,
        phone: phone || null,
        role: 'AGENT',
      },
      select: { id: true, name: true, email: true, phone: true, role: true, createdAt: true },
    });

    return response.created(res, 'Agent created successfully', agent);
  } catch (err) {
    console.error('[CREATE AGENT]', err.message);
    return response.error(res, 'Failed to create agent', 500);
  }
};

const updateAgent = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, status, password } = req.body;

    // Verify agent exists
    const agent = await prisma.user.findFirst({ where: { id, role: 'AGENT' } });
    if (!agent) {
      return response.error(res, 'Agent not found', 404);
    }

    // If email is being changed, check it's not taken
    if (email && email.toLowerCase() !== agent.email) {
      const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
      if (existing) {
        return response.error(res, 'Email already registered', 409);
      }
    }

    const data = {};
    if (name) data.name = name.trim();
    if (email) data.email = email.toLowerCase();
    if (phone !== undefined) data.phone = phone || null;
    if (password) {
      if (password.length < 6) {
        return response.error(res, 'Password must be at least 6 characters', 400);
      }
      const salt = await bcrypt.genSalt(10);
      data.password = await bcrypt.hash(password, salt);
    }
    if (status) {
      const validStatuses = ['ACTIVE', 'INACTIVE', 'SUSPENDED'];
      if (!validStatuses.includes(status)) {
        return response.error(res, `status must be one of: ${validStatuses.join(', ')}`, 400);
      }
      data.status = status;
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, phone: true, status: true, role: true, createdAt: true },
    });

    return response.success(res, 'Agent updated successfully', updated);
  } catch (err) {
    console.error('[UPDATE AGENT]', err.message);
    return response.error(res, 'Failed to update agent', 500);
  }
};

module.exports = { getAgents, getAgentById, createAgent, updateAgent };
