const bcrypt = require('bcryptjs');
const response = require('../utils/apiResponse');
const prisma = require('../config/prisma');

// User updates their own profile
const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, phone, password, currentPassword } = req.body;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return response.error(res, 'User not found', 404);
    }

    const data = {};
    if (name) data.name = name.trim();
    if (phone !== undefined) data.phone = phone || null;

    // Password change requires current password
    if (password) {
      if (!currentPassword) {
        return response.error(res, 'Current password is required to change password', 400);
      }
      const isValid = await bcrypt.compare(currentPassword, user.password);
      if (!isValid) {
        return response.error(res, 'Current password is incorrect', 401);
      }
      if (password.length < 6) {
        return response.error(res, 'New password must be at least 6 characters', 400);
      }
      const salt = await bcrypt.genSalt(10);
      data.password = await bcrypt.hash(password, salt);
    }

    if (Object.keys(data).length === 0) {
      return response.error(res, 'No fields to update', 400);
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, name: true, email: true, phone: true, role: true, tier: true, status: true },
    });

    return response.success(res, 'Profile updated successfully', updated);
  } catch (err) {
    console.error('[UPDATE PROFILE]', err.message);
    return response.error(res, 'Failed to update profile', 500);
  }
};

// Admin updates any user
const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, password, status, role, tier } = req.body;

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      return response.error(res, 'User not found', 404);
    }

    // If email is being changed, check it's not taken
    if (email && email.toLowerCase() !== user.email) {
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
    if (role) {
      const validRoles = ['CUSTOMER', 'AGENT', 'ADMIN'];
      if (!validRoles.includes(role)) {
        return response.error(res, `role must be one of: ${validRoles.join(', ')}`, 400);
      }
      data.role = role;
    }
    if (tier) {
      const validTiers = ['FREE', 'BASIC', 'PREMIUM', 'ENTERPRISE'];
      if (!validTiers.includes(tier)) {
        return response.error(res, `tier must be one of: ${validTiers.join(', ')}`, 400);
      }
      data.tier = tier;
    }

    if (Object.keys(data).length === 0) {
      return response.error(res, 'No fields to update', 400);
    }

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, phone: true, role: true, tier: true, status: true, createdAt: true },
    });

    return response.success(res, 'User updated successfully', updated);
  } catch (err) {
    console.error('[UPDATE USER]', err.message);
    return response.error(res, 'Failed to update user', 500);
  }
};

module.exports = { updateProfile, updateUser };
