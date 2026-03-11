const express = require('express');
const router = express.Router();
const { updateProfile, updateUser } = require('../controllers/user.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

// PATCH /api/users/profile — User updates their own profile
router.patch('/profile', authenticate, updateProfile);

// PATCH /api/users/:id — Admin updates any user
router.patch('/:id', authenticate, authorize('ADMIN'), updateUser);

module.exports = router;
