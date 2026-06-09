'use strict';

const express = require('express');
const { query, body, validationResult } = require('express-validator');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { protect, restrictTo } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { sendEmail } = require('../utils/email');
const logger = require('../utils/logger');
const auditLog = require('../middleware/adminAudit');

const router = express.Router();
router.use(protect, restrictTo('admin'), auditLog);

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
}

// ── DASHBOARD STATS ───────────────────────────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const now = new Date();
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
      Order.aggregate([{ $match: { paymentStatus: 'completed' } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { paymentStatus: 'completed', createdAt: { $gte: startOfMonth } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      Order.aggregate([{ $match: { paymentStatus: 'completed', createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } }, { $group: { _id: null, total: { $sum: '$total' } } }]),
      User.countDocuments({ role: 'customer', isActive: true }),
      User.countDocuments({ role: 'customer', createdAt: { $gte: startOfMonth } }),
      Product.countDocuments({ isActive: true }),
      Order.countDocuments({ status: 'pending' }),
      Order.find({ paymentStatus: 'completed' }).sort({ createdAt: -1 }).limit(10).populate('user', 'name email').lean(),
      Product.find({ isActive: true, $expr: { $gt: ['$lowStockThreshold', '$stock'] }, stock: { $gt: 0 } })
        .select('name emoji stock lowStockThreshold').limit(10).lean(),
    ]);

    const thisMonthRev  = monthRevenue[0]?.total || 0;
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

// ── REVENUE ANALYTICS ─────────────────────────────────────────────
router.get('/analytics/revenue', [
  query('months').optional().isInt({ min: 1, max: 24 }),
], validate, async (req, res, next) => {
  try {
    const months = parseInt(req.query.months) || 6;
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    const revenue = await Order.aggregate([
      { $match: { paymentStatus: 'completed', createdAt: { $gte: startDate } } },
      { $group: {
        _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
        revenue: { $sum: '$total' },
        orders:  { $sum: 1 },
        avgOrderValue: { $avg: '$total' },
      }},
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    res.json({ success: true, revenue });
  } catch (err) { next(err); }
});

// ── TOP PRODUCTS ──────────────────────────────────────────────────
router.get('/analytics/top-products', async (req, res, next) => {
  try {
    const products = await Product.find({ isActive: true })
      .sort({ totalSold: -1 })
      .limit(10)
      .select('name emoji category price totalSold rating numReviews stock');
    res.json({ success: true, products });
  } catch (err) { next(err); }
});

// ── ORDER CATEGORY BREAKDOWN ──────────────────────────────────────
router.get('/analytics/categories', async (req, res, next) => {
  try {
    const data = await Order.aggregate([
      { $match: { paymentStatus: 'completed' } },
      { $unwind: '$items' },
      { $lookup: { from: 'products', localField: 'items.product', foreignField: '_id', as: 'productInfo' } },
      { $unwind: '$productInfo' },
      { $group: {
        _id: '$productInfo.category',
        revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
        units: { $sum: '$items.quantity' },
      }},
      { $sort: { revenue: -1 } },
    ]);
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// ── ALL USERS (paginated) ─────────────────────────────────────────
router.get('/users', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
], validate, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, search, role } = req.query;
    const filter = {};
    if (role) filter.role = role;
    if (search) {
      filter.$or = [
        { name: new RegExp(search.slice(0, 50), 'i') },
        { email: new RegExp(search.slice(0, 50), 'i') },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .select('-password -passwordResetToken -emailVerificationToken'),
      User.countDocuments(filter),
    ]);

    res.json({ success: true, users, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// ── TOGGLE USER ACTIVE STATUS ─────────────────────────────────────
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

// ── UPDATE STOCK ──────────────────────────────────────────────────
router.patch('/products/:id/stock', [
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

// ── HIDE/SHOW REVIEW ──────────────────────────────────────────────
router.patch('/products/:productId/reviews/:reviewId/visibility', async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.productId);
    if (!product) return next(new AppError('Product not found', 404));

    const review = product.reviews.id(req.params.reviewId);
    if (!review) return next(new AppError('Review not found', 404));

    review.hidden = !review.hidden;
    product.recalcRating();
    await product.save();

    res.json({ success: true, hidden: review.hidden });
  } catch (err) { next(err); }
});

// ── NOTIFY ORDER SHIPPED ──────────────────────────────────────────
router.post('/orders/:id/notify-shipped', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return next(new AppError('Order not found', 404));

    await sendEmail({
      to: order.customerEmail,
      subject: `🚚 Your winners-health order ${order.orderNumber} has shipped!`,
      template: 'orderShipped',
      data: { name: order.customerName, orderNumber: order.orderNumber, trackingNumber: order.trackingNumber },
    });

    res.json({ success: true, message: 'Shipment notification sent' });
  } catch (err) { next(err); }
});

module.exports = router;
