const { verifyToken } = require('../utils/jwt');
const response = require('../utils/apiResponse');

const authenticate = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return response.error(res, 'Access token required', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) {
      return response.error(res, 'Invalid or expired token', 401);
    }

    req.user = decoded;
    next();
  } catch (error) {
    return response.error(res, 'Authentication failed', 401);
  }
};

// Role-based authorization
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return response.error(res, 'Authentication required', 401);
    }

    if (!roles.includes(req.user.role)) {
      return response.error(res, 'Insufficient permissions', 403);
    }

    next();
  };
};

// Tier-based authorization
const requireTier = (...tiers) => {
  return (req, res, next) => {
    if (!req.user) {
      return response.error(res, 'Authentication required', 401);
    }

    if (!tiers.includes(req.user.tier)) {
      return response.error(res, 'Upgrade your plan to access this feature', 403);
    }

    next();
  };
};

module.exports = {
  authenticate,
  authorize,
  requireTier,
};
