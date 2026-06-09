'use strict';

const express = require('express');
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const { protect, optionalAuth } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { sendEmail } = require('../utils/email');
const { paymentLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

// ── NOMBA API CLIENT ──────────────────────────────────────────────
let nombaTokenCache = { token: null, expiresAt: 0 };

async function getNombaToken() {
  if (nombaTokenCache.token && Date.now() < nombaTokenCache.expiresAt - 60000) {
    return nombaTokenCache.token;
  }

  const res = await axios.post(
    `${process.env.NOMBA_BASE_URL}/auth/token/issue`,
    {
      grant_type: 'client_credentials',
      client_id: process.env.NOMBA_CLIENT_ID,
      client_secret: process.env.NOMBA_CLIENT_SECRET,
    },
    { timeout: 10000 }
  );

  nombaTokenCache = {
    token: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in * 1000 || 3600000),
  };
  return nombaTokenCache.token;
}

async function nombaRequest(method, endpoint, data = {}) {
  const token = await getNombaToken();
  return axios({
    method,
    url: `${process.env.NOMBA_BASE_URL}${endpoint}`,
    data,
    headers: {
      Authorization: `Bearer ${token}`,
      accountId: process.env.NOMBA_ACCOUNT_ID,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

// ── PROMO CODES ───────────────────────────────────────────────────
// In production these should be stored in DB with expiry, per-user usage tracking
const PROMO_CODES = {
  VITA15:    { discount: 0.15, description: '15% off' },
  HEALTH10:  { discount: 0.10, description: '10% off' },
  WELCOME20: { discount: 0.20, description: '20% off first order' },
};

function calculatePricing(items, promoCode) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  let discount = 0;
  if (promoCode && PROMO_CODES[promoCode.toUpperCase()]) {
    discount = Math.round(subtotal * PROMO_CODES[promoCode.toUpperCase()].discount);
  }
  const shipping = subtotal - discount >= 25000 ? 0 : 2500;
  const total = subtotal - discount + shipping;
  return { subtotal, discount, shipping, total };
}

// ── VALIDATE PROMO CODE ───────────────────────────────────────────
router.post('/validate-promo', async (req, res, next) => {
  try {
    const code = (req.body.code || '').toUpperCase().trim().slice(0, 30);
    const promo = PROMO_CODES[code];
    if (!promo) return next(new AppError('Invalid promo code', 400));
    res.json({ success: true, code, ...promo });
  } catch (err) { next(err); }
});

// ── CHECKOUT ──────────────────────────────────────────────────────
router.post('/checkout', optionalAuth, paymentLimiter, [
  body('items').isArray({ min: 1, max: 20 }).withMessage('Items are required (max 20)'),
  body('items.*.productId').notEmpty().withMessage('Product ID required'),
  body('items.*.quantity').isInt({ min: 1, max: 99 }).withMessage('Invalid quantity'),
  body('customer.email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('customer.name').trim().notEmpty().isLength({ max: 60 }).withMessage('Customer name required'),
  body('customer.phone').notEmpty().withMessage('Phone number required'),
  body('shippingAddress.street').trim().notEmpty().isLength({ max: 200 }),
  body('shippingAddress.city').trim().notEmpty().isLength({ max: 100 }),
  body('shippingAddress.state').trim().notEmpty().isLength({ max: 100 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { items, customer, shippingAddress, promoCode } = req.body;

    // 1. Validate products against DB — NEVER trust frontend prices
    const validatedItems = [];
    for (const item of items) {
      const product = await Product.findById(item.productId).select('name price stock emoji isActive');
      if (!product || !product.isActive) return next(new AppError(`Product "${item.productId}" not available`, 400));
      if (product.stock < item.quantity) {
        return next(new AppError(`Only ${product.stock} units of "${product.name}" in stock`, 400));
      }
      validatedItems.push({
        product: product._id,
        name: product.name,
        emoji: product.emoji,
        price: product.price, // server-side price always
        quantity: item.quantity,
      });
    }

    // 2. Server-side pricing
    const { subtotal, discount, shipping, total } = calculatePricing(validatedItems, promoCode);
    if (total < 100) return next(new AppError('Order total is too low', 400));

    // 3. Resolve user
    const userId = req.user ? req.user._id : await getOrCreateGuestUser(customer.email, customer.name);

    // 4. Create pending order
    const order = await Order.create({
      user: userId,
      items: validatedItems,
      shippingAddress,
      subtotal, discount, shipping, total,
      promoCode: promoCode?.toUpperCase() || undefined,
      status: 'pending',
      paymentStatus: 'pending',
      customerName: customer.name,
      customerEmail: customer.email,
      customerPhone: customer.phone,
    });

    logger.info(`Order created: ${order.orderNumber} | ₦${total} | user: ${userId}`);

    // 5. Initiate Nomba checkout
    let checkoutUrl;
    try {
      const nombaRes = await nombaRequest('POST', '/checkout/orders', {
        orderReference: order._id.toString(),
        customerId: customer.email,
        callbackUrl: `${process.env.BASE_URL}/webhooks/nomba`,
        customer: { email: customer.email, name: customer.name, phoneNumber: customer.phone },
        order: {
          orderReference: order._id.toString(),
          customerId: customer.email,
          callbackUrl: `${process.env.BASE_URL}/webhooks/nomba`,
          amount: total,
          currency: 'NGN',
          description: `VitaCore Order #${order.orderNumber}`,
        },
      });
      checkoutUrl = nombaRes.data?.data?.checkoutLink;
      order.nombaReference = nombaRes.data?.data?.orderReference;
      await order.save();
    } catch (nombaErr) {
      await Order.findByIdAndDelete(order._id);
      logger.error('Nomba checkout failed:', nombaErr.message);
      return next(new AppError('Payment gateway unavailable. Please try again shortly.', 503));
    }

    res.status(201).json({ success: true, orderId: order._id, orderNumber: order.orderNumber, checkoutUrl, total });
  } catch (err) { next(err); }
});

// ── VERIFY PAYMENT STATUS ─────────────────────────────────────────
router.get('/:reference/status', protect, async (req, res, next) => {
  try {
    const order = await Order.findOne({
      $or: [
        ...((/^[a-f\d]{24}$/i.test(req.params.reference)) ? [{ _id: req.params.reference }] : []),
        { nombaReference: req.params.reference },
        { orderNumber: req.params.reference },
      ]
    });

    if (!order) return next(new AppError('Order not found', 404));
    if (order.user.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    if (order.paymentStatus === 'pending') {
      try {
        const nombaRes = await nombaRequest('GET', `/checkout/orders/${order._id}`);
        if (nombaRes.data?.data?.status === 'successful') {
          await processSuccessfulPayment(order, nombaRes.data.data);
        }
      } catch (err) {
        logger.warn('Could not verify with Nomba:', err.message);
      }
    }

    const freshOrder = await Order.findById(order._id).populate('items.product', 'name emoji');
    res.json({ success: true, order: freshOrder });
  } catch (err) { next(err); }
});

// ── SHARED: PROCESS SUCCESSFUL PAYMENT ───────────────────────────
async function processSuccessfulPayment(order, nombaData = {}) {
  if (order.paymentStatus === 'completed') return; // idempotent

  order.paymentStatus = 'completed';
  order.transactionId = nombaData.transactionId || nombaData.reference;
  order.paidAt = new Date();
  order.addStatus('paid', 'Payment confirmed via Nomba');
  await order.save();

  // Atomic stock decrement
  for (const item of order.items) {
    const result = await Product.findOneAndUpdate(
      { _id: item.product, stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity, totalSold: item.quantity } },
      { new: true }
    );
    if (!result) {
      logger.error(`Stock underflow for product ${item.product} on order ${order.orderNumber}`);
    }
  }

  try {
    await sendEmail({
      to: order.customerEmail,
      subject: `✅ Order Confirmed — ${order.orderNumber}`,
      template: 'orderConfirmation',
      data: {
        name: order.customerName,
        orderNumber: order.orderNumber,
        items: order.items,
        subtotal: order.subtotal,
        discount: order.discount,
        shipping: order.shipping,
        total: order.total,
        shippingAddress: order.shippingAddress,
      },
    });
  } catch (emailErr) {
    logger.error('Failed to send confirmation email:', emailErr.message);
  }

  logger.info(`Payment processed: ${order.orderNumber} | ₦${order.total}`);
}

module.exports = router;
module.exports.processSuccessfulPayment = processSuccessfulPayment;

async function getOrCreateGuestUser(email, name) {
  let user = await User.findOne({ email });
  if (!user) {
    const tempPassword = require('crypto').randomBytes(16).toString('hex');
    user = await User.create({ email, name, password: tempPassword });
  }
  return user._id;
}
