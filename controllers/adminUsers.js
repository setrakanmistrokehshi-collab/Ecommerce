'use strict';
// controllers/adminUsers.js
// Powers admin user management routes.

const User   = require('../models/User');
const Order  = require('../models/Order');
const logger = require('../utils/logger');

/**
 * GET /api/v1/admin/users
 */
async function getUsers(req, res) {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const filter = { role: 'user' };
    if (search) {
      const re = new RegExp(search, 'i');
      filter.$or = [{ name: re }, { email: re }];
    }

    const [users, total] = await Promise.all([
      User.find(filter, '-password -__v')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit, 10))
        .lean(),
      User.countDocuments(filter),
    ]);

    // Enrich with order counts and lifetime value
    const enriched = await Promise.all(
      users.map(async u => {
        const agg = await Order.aggregate([
          { $match: { user: u._id, status: { $ne: 'cancelled' } } },
          { $group: { _id: null, total: { $sum: '$totalPrice' }, count: { $sum: 1 } } },
        ]);
        return {
          ...u,
          orderCount:    agg[0]?.count ?? 0,
          lifetimeValue: agg[0]?.total ?? 0,
        };
      })
    );

    res.json({
      success: true,
      users:   enriched,
      total,
      page:    parseInt(page, 10),
      pages:   Math.ceil(total / parseInt(limit, 10)),
    });
  } catch (err) {
    logger.error('getUsers error:', err);
    res.status(500).json({ success: false, error: 'Failed to load users' });
  }
}

/**
 * GET /api/v1/admin/users/:id
 */
async function getUserById(req, res) {
  try {
    const user = await User.findById(req.params.id, '-password').lean();
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const [orders, agg] = await Promise.all([
      Order.find({ user: user._id }).sort({ createdAt: -1 }).limit(10).lean(),
      Order.aggregate([
        { $match: { user: user._id, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, total: { $sum: '$totalPrice' }, count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      success: true,
      data: {
        ...user,
        orderCount:    agg[0]?.count ?? 0,
        lifetimeValue: agg[0]?.total ?? 0,
        recentOrders:  orders,
      },
    });
  } catch (err) {
    logger.error('getUserById error:', err);
    res.status(500).json({ success: false, error: 'Failed to load user' });
  }
}

/**
 * PATCH /api/v1/admin/users/:id/role
 */
async function updateUserRole(req, res) {
  try {
    // Prevent self-demotion
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ success: false, error: 'Cannot change your own role' });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role: req.body.role },
      { new: true, select: '-password' }
    );
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    logger.info(`User ${user._id} role changed to ${req.body.role} by admin ${req.user._id}`);
    res.json({ success: true, data: user });
  } catch (err) {
    logger.error('updateUserRole error:', err);
    res.status(500).json({ success: false, error: 'Failed to update role' });
  }
}

/**
 * DELETE /api/v1/admin/users/:id
 */
async function deleteUser(req, res) {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({ success: false, error: 'Cannot delete your own account' });
    }

    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    logger.info(`User ${user._id} deleted by admin ${req.user._id}`);
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    logger.error('deleteUser error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete user' });
  }
}

module.exports = { getUsers, getUserById, updateUserRole, deleteUser };
