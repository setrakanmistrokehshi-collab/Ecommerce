'use strict';
// controllers/adminOrders.js
// Powers admin order management routes.

const Order  = require('../models/Order');
const logger = require('../utils/logger');
const { sendOrderConfirmation } = require('../services/orderEmails');
const { sendOrderAlertToAdmin } = require('../services/orderAlerts');

/**
 * GET /api/v1/admin/orders  OR  GET /api/v1/orders
 * Query: status, search, page, limit, sort
 */


async function createOrder(req, res) {
  const order = await Order.create(req.body);
  const customer = await User.findById(order.userId);

  // Fire both emails but never let email failure break the order response
  Promise.allSettled([
    sendOrderConfirmation(order, customer),
    sendOrderAlertToAdmin(order, customer),
  ]).then((results) => {
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`Email ${i === 0 ? 'confirmation' : 'admin alert'} failed:`, r.reason);
      }
    });
  });

  res.status(201).json({ success: true, order });
}

async function getOrders(req, res) {
  try {
    const {
      status,
      search,
      page  = 1,
      limit = 10,
      sort  = '-createdAt',
    } = req.query;

    const filter = {};
    if (status) filter.status = status;

    if (search) {
      // Search by order _id suffix or customer name
      filter.$or = [
        { 'user.name': new RegExp(search, 'i') },
      ];
      // If it looks like an ID fragment, try matching by ID too
      if (/^[a-f\d]{4,24}$/i.test(search)) {
        filter.$or.push({ _id: search });
      }
    }

    const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('user', 'name email')
        .populate('items.product', 'name emoji images')
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit, 10))
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.json({
      success: true,
      orders,
      total,
      page:  parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
    });
  } catch (err) {
    logger.error('getOrders error:', err);
    res.status(500).json({ success: false, error: 'Failed to load orders' });
  }
}

/**
 * GET /api/v1/admin/orders/:id
 */
async function getOrderById(req, res) {
  try {
    const order = await Order.findById(req.params.id)
      .populate('user', 'name email phone')
      .populate('items.product', 'name emoji images price category')
      .lean();

    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    res.json({ success: true, data: order });
  } catch (err) {
    logger.error('getOrderById error:', err);
    res.status(500).json({ success: false, error: 'Failed to load order' });
  }
}

/**
 * PATCH /api/v1/admin/orders/:id/status
 * Body: { status }
 */
async function updateOrderStatus(req, res) {
  try {
    const { status } = req.body;
    const VALID = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

    if (!VALID.includes(status)) {
      return res.status(400).json({ success: false, error: `Status must be one of: ${VALID.join(', ')}` });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });

    // Prevent rolling back a delivered order
    if (order.status === 'delivered' && status !== 'delivered') {
      return res.status(400).json({ success: false, error: 'Cannot change status of a delivered order' });
    }

    order.status = status;
    if (status === 'delivered') order.deliveredAt = new Date();
    await order.save();

    logger.info(`Order ${order._id} status → ${status} by admin ${req.user._id}`);
    res.json({ success: true, message: `Order marked as ${status}`, data: order });
  } catch (err) {
    logger.error('updateOrderStatus error:', err);
    res.status(500).json({ success: false, error: 'Failed to update order status' });
  }
}

module.exports = { getOrders, getOrderById, updateOrderStatus, createOrder };
