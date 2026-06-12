'use strict';

const express = require('express');
const Order = require('../models/Order');
const { protect, restrictTo } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();

// ── GUEST ORDER LOOKUP (no auth required) ──────────────────────────
// Guests can check order status by email + order number/ID
router.get('/guest/:reference', async (req, res, next) => {
  try {
    const { email } = req.query;
    if (!email) return next(new AppError('Email query parameter required', 400));

    const order = await Order.findOne({
      $or: [
        ...((/^[a-f\d]{24}$/i.test(req.params.reference)) ? [{ _id: req.params.reference }] : []),
        { orderNumber: new RegExp(`^${req.params.reference}$`, 'i') },
      ],
      customerEmail: email.toLowerCase(),
    }).populate('items.product', 'name emoji slug price');

    if (!order) return next(new AppError('Order not found', 404));

    res.json({ success: true, order });
  } catch (err) {
    next(err);
  }
});

// All subsequent order routes require authentication
router.use(protect);

// GET /api/v1/orders — get current user's orders
router.get('/', async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      Order.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('items.product', 'name emoji slug'),
      Order.countDocuments({ user: req.user._id }),
    ]);

    res.json({
      success: true,
      orders,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/orders/:id — get single order
router.get('/:id', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id).populate('items.product', 'name emoji slug price');

    if (!order) return next(new AppError('Order not found', 404));

    if (order.user.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized to view this order', 403));
    }

    res.json({ success: true, order });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/orders/:id/cancel — cancel order
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return next(new AppError('Order not found', 404));

    if (order.user.toString() !== req.user._id.toString()) {
      return next(new AppError('Not authorized', 403));
    }

    if (!['pending', 'paid'].includes(order.status)) {
      return next(new AppError(`Cannot cancel an order with status: ${order.status}`, 400));
    }

    order.addStatus('cancelled', req.body.reason || 'Cancelled by customer');
    order.cancelReason = req.body.reason;
    await order.save();

    res.json({ success: true, message: 'Order cancelled successfully', order });
  } catch (err) {
    next(err);
  }
});

// ── ADMIN ONLY ROUTES ─────────────────────────────────────────────
router.use(restrictTo('admin'));

// GET /api/v1/orders/admin/all — all orders with filters
router.get('/admin/all', async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { orderNumber: new RegExp(search, 'i') },
        { customerEmail: new RegExp(search, 'i') },
        { customerName: new RegExp(search, 'i') },
      ];
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('user', 'name email'),
      Order.countDocuments(filter),
    ]);

    res.json({ success: true, orders, total, page: parseInt(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/orders/admin/:id/status — update order status
router.patch('/admin/:id/status', async (req, res, next) => {
  try {
    const { status, note, trackingNumber } = req.body;
    const validStatuses = ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];

    if (!validStatuses.includes(status)) {
      return next(new AppError(`Invalid status: ${status}`, 400));
    }

    const order = await Order.findById(req.params.id);
    if (!order) return next(new AppError('Order not found', 404));

    order.addStatus(status, note);
    if (trackingNumber) order.trackingNumber = trackingNumber;
    if (status === 'delivered') order.deliveredAt = new Date();
    await order.save();

    res.json({ success: true, order });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
