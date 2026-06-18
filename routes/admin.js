'use strict';
// routes/admin.js — M
// Preserves all original endpoints + adds new ones for the admin dashboard.

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const Order   = require('../models/Order');
const Product = require('../models/Product');
const User    = require('../models/User');
const { protect, restrictTo }   = require('../middleware/auth');
const { AppError }              = require('../middleware/errorHandler');
const { sendEmail }             = require('../utils/email');
const logger                    = require('../utils/logger');
const auditLog                  = require('../middleware/adminAudit');

// New controllers (drop files into controllers/)
const { getDashboardStats }                              = require('../controllers/adminStats');
const { getRevenueReport, getTopProducts }               = require('../controllers/adminReports');
const { getReviews, approveReview, rejectReview, deleteReview } = require('../controllers/adminReviews');
const { getSettings, updateSettings }                    = require('../controllers/adminSettings');
const { getUsers, getUserById, updateUserRole, deleteUser } = require('../controllers/adminUsers');
const { getOrders, getOrderById, updateOrderStatus }     = require('../controllers/adminOrders');

const router = express.Router();

// ── AUTH + AUDIT on every route ───────────────────────────────────
router.use(protect, restrictTo('admin'), auditLog);

// ── VALIDATION HELPER ─────────────────────────────────────────────
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
}

// ─────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/dashboard
 * Original endpoint — month-based KPIs, recent orders, low stock.
 * Kept for backwards compatibility.
 */
router.get('/dashboard', async (req, res, next) => {
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
      User.countDocuments({ role: 'customer', isActive: true }),
      User.countDocuments({ role: 'customer', createdAt: { $gte: startOfMonth } }),
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

/**
 * GET /api/v1/admin/stats?period=7d|30d|90d|today
 * New endpoint — period-based KPIs for the React dashboard page.
 */
router.get(
  '/stats',
  [query('period').optional().isIn(['today','7d','30d','90d'])],
  validate,
  getDashboardStats,
);

// ─────────────────────────────────────────────────────────────────
// ANALYTICS / REPORTS
// ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/analytics/revenue?months=6
 * Original — month-grouped revenue for the reports page.
 */
router.get('/analytics/revenue', [
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

/**
 * GET /api/v1/admin/analytics/top-products
 * Original — top products by totalSold field.
 */
router.get('/analytics/top-products', async (req, res, next) => {
  try {
    const products = await Product.find({ isActive: true })
      .sort({ totalSold: -1 })
      .limit(10)
      .select('name emoji category price totalSold rating numReviews stock');
    res.json({ success: true, products });
  } catch (err) { next(err); }
});

/**
 * GET /api/v1/admin/analytics/categories
 * Original — revenue and units by product category.
 */
router.get('/analytics/categories', async (req, res, next) => {
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

/**
 * GET /api/v1/admin/reports/revenue?period=monthly|weekly
 * New — chart-ready revenue for the React Reports page.
 */
router.get(
  '/reports/revenue',
  [query('period').optional().isIn(['monthly','weekly'])],
  validate,
  getRevenueReport,
);

/**
 * GET /api/v1/admin/reports/top-products?limit=9
 * New — top products with trend arrows for the React Reports page.
 */
router.get(
  '/reports/top-products',
  [query('limit').optional().isInt({ min: 1, max: 50 })],
  validate,
  getTopProducts,
);

// ─────────────────────────────────────────────────────────────────
// USERS
// ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/users
 */
router.get('/users', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('search').optional().isString().isLength({ max: 100 }),
  query('role').optional().isIn(['user','admin','customer']),
], validate, getUsers);

/**
 * GET /api/v1/admin/users/:id
 */
router.get('/users/:id', [param('id').isMongoId()], validate, getUserById);

/**
 * PATCH /api/v1/admin/users/:id/status  — toggle active (original)
 */
router.patch('/users/:id/status', async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return next(new AppError('User not found', 404));
    if (user.role === 'admin') return next(new AppError('Cannot deactivate admin accounts', 403));

    user.isActive = !user.isActive;
    await user.save({ validateBeforeSave: false });

    logger.info(`User ${user.email} ${user.isActive ? 'activated' : 'deactivated'} by admin ${req.user._id}`);
    res.json({ success: true, isActive: user.isActive });
  } catch (err) { next(err); }
});

/**
 * PATCH /api/v1/admin/users/:id/role  — change role (new)
 */
router.patch('/users/:id/role', [
  param('id').isMongoId(),
  body('role').isIn(['user','admin']),
], validate, updateUserRole);

/**
 * DELETE /api/v1/admin/users/:id
 */
router.delete('/users/:id', [param('id').isMongoId()], validate, deleteUser);

// ─────────────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/orders
 */
router.get('/orders', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('status').optional().isIn(['pending','processing','shipped','delivered','cancelled']),
  query('search').optional().isString().isLength({ max: 100 }),
  query('sort').optional().isString(),
], validate, getOrders);

/**
 * GET /api/v1/admin/orders/:id
 */
router.get('/orders/:id', [param('id').isMongoId()], validate, getOrderById);

/**
 * PATCH /api/v1/admin/orders/:id/status
 */
router.patch('/orders/:id/status', [
  param('id').isMongoId(),
  body('status').isIn(['pending','processing','shipped','delivered','cancelled']),
], validate, updateOrderStatus);

/**
 * POST /api/v1/admin/orders/:id/notify-shipped  — send shipment email (original)
 */
router.post('/orders/:id/notify-shipped', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id).populate('user', 'name email');
    if (!order) return next(new AppError('Order not found', 404));

    await sendEmail({
      to:       order.user?.email ?? order.customerEmail,
      subject:  `🚚 Your  order has shipped!`,
      template: 'orderShipped',
      data: {
        name:           order.user?.name ?? order.customerName,
        orderNumber:    order.orderNumber ?? order._id,
        trackingNumber: order.trackingNumber,
      },
    });

    logger.info(`Shipment notification sent for order ${order._id} by admin ${req.user._id}`);
    res.json({ success: true, message: 'Shipment notification sent' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// PRODUCTS — admin-specific patches
// ─────────────────────────────────────────────────────────────────

/**
 * PATCH /api/v1/admin/products/:id/stock  — restock (original)
 */
router.patch('/products/:id/stock', [
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
    logger.info(`Stock updated: ${product.name} → ${req.body.stock} by admin ${req.user._id}`);
    res.json({ success: true, product });
  } catch (err) { next(err); }
});

/**
 * PATCH /api/v1/admin/products/:productId/reviews/:reviewId/visibility
 * Toggle review hidden/visible (original — uses embedded reviews on Product model).
 * Note: if you migrate to the standalone Review model, remove this route.
 */
router.patch('/products/:productId/reviews/:reviewId/visibility', async (req, res, next) => {
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
});

// ─────────────────────────────────────────────────────────────────
// REVIEWS (standalone Review model)
// ─────────────────────────────────────────────────────────────────

router.get('/reviews', [
  query('status').optional().isIn(['pending','approved','rejected','all']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('product').optional().isMongoId(),
], validate, getReviews);

router.patch('/reviews/:id/approve', [param('id').isMongoId()], validate, approveReview);

router.patch('/reviews/:id/reject', [
  param('id').isMongoId(),
  body('reason').optional().isString().isLength({ max: 200 }),
], validate, rejectReview);

router.delete('/reviews/:id', [param('id').isMongoId()], validate, deleteReview);

// ─────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────

router.get('/settings', getSettings);

router.post('/settings', [
  body('store.name').optional().isString().isLength({ max: 100 }),
  body('store.email').optional().isEmail(),
  body('store.phone').optional().isString().isLength({ max: 20 }),
  body('notifications.lowStockThreshold').optional().isInt({ min: 0, max: 1000 }),
], validate, updateSettings);

module.exports = router;
