const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');
const response = require('../utils/apiResponse');
const { validateRegisterInput, validateLoginInput } = require('../utils/validators');
const { generateToken } = require('../utils/jwt');

const register = async (req, res) => {
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

    // Create user (default tier is FREE)
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase(),
        password: hashedPassword,
        phone: phone || null,
        // role: 'CUSTOMER' (default)
        // tier: 'FREE' (default)
        // status: 'ACTIVE' (default)
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        tier: true,
        status: true,
        createdAt: true,
      },
    });

    return response.created(res, 'User registered successfully', { user });
  } catch (error) {
    console.error('Registration error:', error);
    return response.error(res, 'Registration failed', 500);
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    const validation = validateLoginInput({ email, password });
    if (!validation.isValid) {
      return response.validationError(res, validation.errors);
    }

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      return response.error(res, 'Invalid email or password', 401);
    }

    // Check if user is active
    if (user.status !== 'ACTIVE') {
      return response.error(res, 'Account is not active', 403);
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return response.error(res, 'Invalid email or password', 401);
    }

    // Generate JWT token
    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      tier: user.tier,
    });

    // Return user data without password
    const userData = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      tier: user.tier,
      status: user.status,
    };

    return response.success(res, 'Login successful', {
      user: userData,
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    return response.error(res, 'Login failed', 500);
  }
};

const logout = async (req, res) => {
  return response.success(res, 'Logged out successfully');
};

module.exports = {
  register,
  login,
  logout,
};
