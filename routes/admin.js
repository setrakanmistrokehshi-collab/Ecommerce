'use strict';
// routes/admin.js 

const express = require('express');
const argon2 = require('argon2');
const { body, query, param, validationResult } = require('express-validator');
const Order   = require('../models/Order');
const Product = require('../models/Product');
const User    = require('../models/User');
const { protect, restrictTo }      = require('../middleware/auth');
const { requirePermission }        = require('../middleware/requirePermission');
const { AppError }                 = require('../middleware/errorHandler');
const { sendEmail }                = require('../utils/email');
const logger                       = require('../utils/logger');
const auditLog                     = require('../middleware/adminAudit');

const { PERMISSIONS, STAFF_ROLES } = require('../config/permission');

// Controllers
const { getDashboardStats }  = require('../controllers/adminStats');
const { getRevenueReport, getTopProducts } = require('../controllers/adminReports');
const { getReviews, approveReview, rejectReview, deleteReview } = require('../controllers/adminReviews');
const { getSettings, updateSettings }                    = require('../controllers/adminSettings');
const { getUsers, getUserById, updateUserRole, deleteUser } = require('../controllers/adminUsers');
const { getOrders, getOrderById, updateOrderStatus }     = require('../controllers/adminOrders');

const router = express.Router();

// ── AUTH + AUDIT on every route ───────────────────────────────────
router.use(protect, restrictTo(...STAFF_ROLES), auditLog);

// ── VALIDATION HELPER ─────────────────────────────────────────────
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
}

// ─────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────

router.get('/dashboard', requirePermission(PERMISSIONS.DASHBOARD_VIEW), async (req, res, next) => {
  try {
    const now              = new Date();
    const startOfMonth     = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0);

    const [
      totalOrders, monthOrders, lastMonthOrders,
      totalRevenue, monthRevenue, lastMonthRevenue,
      totalUsers, monthUsers,
      totalProducts, pendingOrders,
      recentOrders, lowStockList,
    ] = await Promise.all([
      Order.countDocuments({ paymentStatus: 'completed' }),
      Order.countDocuments({ paymentStatus: 'completed', createdAt: { $gte: startOfMonth } }),
      Order.countDocuments({ paymentStatus: 'completed', createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } }),
      Order.aggregate([{ $match: { paymentStatus: 'completed' } },                                                              { $group: { _id: null, total: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { paymentStatus: 'completed', createdAt: { $gte: startOfMonth } } },                          { $group: { _id: null, total: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { paymentStatus: 'completed', createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      User.countDocuments({ role: 'user', isActive: true }),
      User.countDocuments({ role: 'user', createdAt: { $gte: startOfMonth } }),
      Product.countDocuments({ isActive: true }),
      Order.countDocuments({ status: 'pending' }),
      Order.find({ paymentStatus: 'completed' }).sort({ createdAt: -1 }).limit(10).populate('user', 'name email').lean(),
      Product.find({ isActive: true, $expr: { $gt: ['$lowStockThreshold', '$stock'] }, stock: { $gt: 0 } })
        .select('name emoji stock lowStockThreshold').limit(10).lean(),
    ]);

    const thisMonthRev  = monthRevenue[0]?.total    || 0;
    const lastMonthRev  = lastMonthRevenue[0]?.total || 0;
    const revenueGrowth = lastMonthRev > 0
      ? Math.round(((thisMonthRev - lastMonthRev) / lastMonthRev) * 100)
      : 0;

    res.json({
      success: true,
      stats: {
        orders:   { total: totalOrders, thisMonth: monthOrders, lastMonth: lastMonthOrders, pending: pendingOrders },
        revenue:  { total: totalRevenue[0]?.total || 0, thisMonth: thisMonthRev, lastMonth: lastMonthRev, growth: revenueGrowth },
        users:    { total: totalUsers, newThisMonth: monthUsers },
        products: { total: totalProducts, lowStock: lowStockList.length },
      },
      recentOrders,
      lowStockProducts: lowStockList,
    });
  } catch (err) { next(err); }
});

router.get(
  '/stats',
  requirePermission(PERMISSIONS.DASHBOARD_VIEW),
  [query('period').optional().isIn(['today','7d','30d','90d'])],
  validate,
  getDashboardStats,
);

// ─────────────────────────────────────────────────────────────────
// ANALYTICS / REPORTS
// ─────────────────────────────────────────────────────────────────

router.get('/analytics/revenue', requirePermission(PERMISSIONS.REPORTS_VIEW), [
  query('months').optional().isInt({ min: 1, max: 24 }),
], validate, async (req, res, next) => {
  try {
    const months    = parseInt(req.query.months, 10) || 6;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const revenue = await Order.aggregate([
      { $match: { paymentStatus: 'completed', createdAt: { $gte: startDate } } },
      {
        $group: {
          _id:           { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          revenue:       { $sum: '$total' },
          orders:        { $sum: 1 },
          avgOrderValue: { $avg: '$total' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    res.json({ success: true, revenue });
  } catch (err) { next(err); }
});

router.get('/analytics/top-products', requirePermission(PERMISSIONS.REPORTS_VIEW), async (req, res, next) => {
  try {
    const products = await Product.find({ isActive: true })
      .sort({ totalSold: -1 })
      .limit(10)
      .select('name emoji category price totalSold rating numReviews stock');
    res.json({ success: true, products });
  } catch (err) { next(err); }
});

router.get('/analytics/categories', requirePermission(PERMISSIONS.REPORTS_VIEW), async (req, res, next) => {
  try {
    const data = await Order.aggregate([
      { $match: { paymentStatus: 'completed' } },
      { $unwind: '$items' },
      { $lookup: { from: 'products', localField: 'items.product', foreignField: '_id', as: 'productInfo' } },
      { $unwind: '$productInfo' },
      {
        $group: {
          _id:     '$productInfo.category',
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          units:   { $sum: '$items.quantity' },
        },
      },
      { $sort: { revenue: -1 } },
    ]);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.get(
  '/reports/revenue',
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  [query('period').optional().isIn(['monthly','weekly'])],
  validate,
  getRevenueReport,
);

router.get(
  '/reports/top-products',
  requirePermission(PERMISSIONS.REPORTS_VIEW),
  [query('limit').optional().isInt({ min: 1, max: 50 })],
  validate,
  getTopProducts,
);

// ─────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────

router.get('/users', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('search').optional().isString().isLength({ max: 100 }),
  // FIX #2: was ...ROLE_PRESETS (object, not iterable) — now STAFF_ROLES (array)
  query('role').optional().isIn(['user', ...STAFF_ROLES]),
], validate, getUsers);

router.get('/users/:id', requirePermission(PERMISSIONS.CUSTOMERS_VIEW), [param('id').isMongoId()], validate, getUserById);

/**
 * PATCH /api/v1/admin/users/:id/status — toggle active
 */
router.patch(
  '/users/:id/status',
  requirePermission(PERMISSIONS.CUSTOMERS_UPDATE),
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const user = await User.findById(req.params.id);
      if (!user) return next(new AppError('User not found', 404));

      if (user.role === 'super_admin') {
        return next(new AppError('Cannot deactivate a super admin account', 403));
      }

      user.isActive = !user.isActive;
      await user.save({ validateBeforeSave: false });

      logger.info(`User ${user.email} ${user.isActive ? 'activated' : 'deactivated'} by ${req.user.email}`);
      res.json({ success: true, isActive: user.isActive });
    } catch (err) { next(err); }
  }
);

/**
 * PATCH /api/v1/admin/users/:id/role — change role / promote to staff
 */
router.patch(
  '/users/:id/role',
  requirePermission(PERMISSIONS.STAFF_MANAGE),
  [
    param('id').isMongoId(),
    // FIX #2: was ...ROLE_PRESETS — now STAFF_ROLES
    body('role').isIn(['user', ...STAFF_ROLES]),
  ],
  validate,
  async (req, res, next) => {
    if (req.body.role === 'super_admin' && req.user.role !== 'super_admin') {
      return next(new AppError('Only a super admin can grant super admin access', 403));
    }
    return updateUserRole(req, res, next);
  }
);

/**
 * DELETE /api/v1/admin/users/:id
 */
router.delete(
  '/users/:id',
  requirePermission(PERMISSIONS.CUSTOMERS_DELETE),
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    const target = await User.findById(req.params.id);
    // FIX #2: was ROLE_PRESETS.includes() — object has no .includes(); now STAFF_ROLES.includes()
    if (target && STAFF_ROLES.includes(target.role) && req.user.role !== 'super_admin') {
      return next(new AppError('Only a super admin can delete staff accounts', 403));
    }
    return deleteUser(req, res, next);
  }
);

// ─────────────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────────────

router.get('/orders', requirePermission(PERMISSIONS.ORDERS_VIEW), [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('status').optional().isIn(['pending','processing','shipped','delivered','cancelled']),
  query('search').optional().isString().isLength({ max: 100 }),
  query('sort').optional().isString(),
], validate, getOrders);

router.get('/orders/:id', requirePermission(PERMISSIONS.ORDERS_VIEW), [param('id').isMongoId()], validate, getOrderById);

router.patch('/orders/:id/status', requirePermission(PERMISSIONS.ORDERS_UPDATE), [
  param('id').isMongoId(),
  body('status').isIn(['pending','processing','shipped','delivered','cancelled']),
], validate, updateOrderStatus);

router.post(
  '/orders/:id/notify-shipped',
  requirePermission(PERMISSIONS.ORDERS_NOTIFY),
  [param('id').isMongoId()],
  validate,
  async (req, res, next) => {
    try {
      const order = await Order.findById(req.params.id).populate('user', 'name email');
      if (!order) return next(new AppError('Order not found', 404));

      await sendEmail({
        to:       order.user?.email ?? order.customerEmail,
        subject:  `🚚 Your winners-health order has shipped!`,
        template: 'orderShipped',
        data: {
          name:           order.user?.name ?? order.customerName,
          orderNumber:    order.orderNumber ?? order._id,
          trackingNumber: order.trackingNumber,
        },
      });

      logger.info(`Shipment notification sent for order ${order._id} by ${req.user.email}`);
      res.json({ success: true, message: 'Shipment notification sent' });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────
// PRODUCTS
// ─────────────────────────────────────────────────────────────────

router.patch('/products/:id/stock', requirePermission(PERMISSIONS.PRODUCTS_STOCK), [
  param('id').isMongoId(),
  body('stock').isInt({ min: 0 }).withMessage('Stock must be a non-negative integer'),
], validate, async (req, res, next) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { stock: req.body.stock },
      { new: true }
    );
    if (!product) return next(new AppError('Product not found', 404));
    logger.info(`Stock updated: ${product.name} → ${req.body.stock} by ${req.user.email}`);
    res.json({ success: true, product });
  } catch (err) { next(err); }
});

router.patch(
  '/products/:productId/reviews/:reviewId/visibility',
  requirePermission(PERMISSIONS.REVIEWS_MODERATE),
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.productId);
      if (!product) return next(new AppError('Product not found', 404));

      const review = product.reviews?.id(req.params.reviewId);
      if (!review) return next(new AppError('Review not found', 404));

      review.hidden = !review.hidden;
      if (typeof product.recalcRating === 'function') product.recalcRating();
      await product.save();

      res.json({ success: true, hidden: review.hidden });
    } catch (err) { next(err); }
  }
);

// ─────────────────────────────────────────────────────────────────
// REVIEWS
// ─────────────────────────────────────────────────────────────────

router.get('/reviews', requirePermission(PERMISSIONS.REVIEWS_VIEW), [
  query('status').optional().isIn(['pending','approved','rejected','all']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('product').optional().isMongoId(),
], validate, getReviews);

router.patch('/reviews/:id/approve', requirePermission(PERMISSIONS.REVIEWS_MODERATE), [param('id').isMongoId()], validate, approveReview);

router.patch('/reviews/:id/reject', requirePermission(PERMISSIONS.REVIEWS_MODERATE), [
  param('id').isMongoId(),
  body('reason').optional().isString().isLength({ max: 200 }),
], validate, rejectReview);

router.delete('/reviews/:id', requirePermission(PERMISSIONS.REVIEWS_DELETE), [param('id').isMongoId()], validate, deleteReview);

// ─────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────


// ── CHANGE PASSWORD ──────────────────────────────────────────────
router.put('/settings/password', 
  requirePermission(PERMISSIONS.SETTINGS_UPDATE),
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body;
      
      const user = await User.findById(req.user._id).select('+password +tokenVersion');
      
      if (!user) {
        return next(new AppError('User not found', 404));
      }
      
      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        return next(new AppError('Current password is incorrect', 401));
      }
      
      const isSamePassword = await argon2.verify(user.password, newPassword);
      if (isSamePassword) {
        return next(new AppError('New password must be different from your current password', 400));
      }
      
      user.password = newPassword;
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      await user.save();
      
      sendEmail({
        to: user.email,
        subject: 'Your admin password was changed',
        template: 'passwordChanged',
        data: { name: user.name },
      }).catch(err => console.error('[password-change] email failed:', err));
      
      res.json({
        success: true,
        message: 'Password changed successfully. Please login again.'
      });
      
    } catch (err) {
      next(err);
    }
  }
);

router.get('/settings', requirePermission(PERMISSIONS.SETTINGS_VIEW), getSettings);

router.post('/settings', requirePermission(PERMISSIONS.SETTINGS_UPDATE), [
  body('store.name').optional().isString().isLength({ max: 100 }),
  body('store.email').optional().isEmail(),
  body('store.phone').optional().isString().isLength({ max: 20 }),
  body('notifications.lowStockThreshold').optional().isInt({ min: 0, max: 1000 }),
], validate, updateSettings);

module.exports = router;

