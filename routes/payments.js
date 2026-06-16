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
const { paymentLimiter, statusLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();

// ── NOMBA API CLIENT ──────────────────────────────────────────────
let nombaTokenCache = { token: null, expiresAt: 0 };
let nombaTokenPromise = null; // In-flight token request — prevents a
                               // thundering herd when the cached token
                               // expires under concurrent checkouts.

async function getNombaToken() {
  if (nombaTokenCache.token && Date.now() < nombaTokenCache.expiresAt - 60000) {
    return nombaTokenCache.token;
  }

  if (nombaTokenPromise) return nombaTokenPromise;

  nombaTokenPromise = (async () => {
    try {
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
    } finally {
      nombaTokenPromise = null;
    }
  })();

  return nombaTokenPromise;
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

// ── KOBO UTILITIES ───────────────────────────────────────────────
// All monetary values are stored and computed internally in KOBO
// (integer) to avoid floating-point drift during arithmetic.
// Convert to a naira string only at the two external boundaries:
//   • Nomba API requests  → toNaira(kobo).toFixed(2)
//   • Nomba API responses → toKobo(Number(nombaData.amount))
//   • Logs / emails / API responses to the frontend also use toNaira()
//     so humans see a readable naira figure.
//
// IMPORTANT: Product.price and Order.subtotal/discount/shipping/total
// must all be stored in KOBO in their respective Mongoose schemas.
// e.g. ₦1,000.50 is stored as 100050.
function toKobo(naira) {
  return Math.round(Number(naira) * 100); // "1000.50" or 1000.50 → 100050
}

function toNaira(kobo) {
  return kobo / 100; // 100050 → 1000.50
}

// ── PROMO CODES ───────────────────────────────────────────────────
// In production these should be stored in DB with expiry and per-user
// usage tracking.
const PROMO_CODES = {
  VITA15:    { discount: 0.15, description: '15% off' },
  HEALTH10:  { discount: 0.10, description: '10% off' },
  WELCOME20: { discount: 0.20, description: '20% off first order', firstOrderOnly: true },
};

const MAX_PROMO_CODE_LENGTH = 30;

function calculatePricing(items, promoCode) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  let discount = 0;
  if (promoCode && PROMO_CODES[promoCode]) {
    discount = Math.round(subtotal * PROMO_CODES[promoCode].discount);
  }
  const shipping = subtotal - discount >= 2500000 ? 0 : 250000; // ₦25,000 = 2,500,000k | ₦2,500 = 250,000k
  const total = subtotal - discount + shipping;
  return { subtotal, discount, shipping, total };
}

// Checks whether `code` can be applied for this customer. Codes without
// restrictions always pass. `firstOrderOnly` codes check order history
// by both user id (authenticated) and email (covers guests and accounts
// previously used for guest checkout).
async function isPromoEligible(code, { userId, email }) {
  const promo = PROMO_CODES[code];
  if (!promo) return false;
  if (!promo.firstOrderOnly) return true;

  const priorOrder = await Order.findOne({
    paymentStatus: 'completed',
    $or: [
      ...(userId ? [{ user: userId }] : []),
      { customerEmail: email.toLowerCase() },
    ],
  }).select('_id').lean();

  return !priorOrder;
}

function maskEmail(email = '') {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}

// ── STOCK RESERVATION HELPER ──────────────────────────────────────
// Releases previously-acquired reservations. Uses Promise.allSettled so
// a single failure doesn't leave other products pinned. Called on Nomba
// failure, duplicate-key collision, and the abandoned-order cron job.
async function releaseReservations(reservations = []) {
  const results = await Promise.allSettled(
    reservations.map(({ productId, quantity }) =>
      Product.findByIdAndUpdate(productId, { $inc: { reserved: -quantity } })
    )
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.error(`Failed to release reservation for product ${reservations[i].productId}:`, r.reason?.message);
    }
  });
}

// ── VALIDATE PROMO CODE ───────────────────────────────────────────
router.post('/validate-promo', optionalAuth, async (req, res, next) => {
  try {
    const code = (req.body.code || '').toUpperCase().trim().slice(0, MAX_PROMO_CODE_LENGTH);
    const promo = PROMO_CODES[code];
    if (!promo) return next(new AppError('Invalid promo code', 400));

    // Best-effort preview — final eligibility is re-checked at checkout
    // against the email actually used for the order.
    if (promo.firstOrderOnly) {
      const email = (req.body.email || req.user?.email || '').toLowerCase();
      if (email) {
        const eligible = await isPromoEligible(code, { userId: req.user?._id, email });
        if (!eligible) return next(new AppError('This code is only valid for first-time customers', 400));
      }
    }

    const { firstOrderOnly, ...promoInfo } = promo;
    res.json({ success: true, code, ...promoInfo });
  } catch (err) { next(err); }
});

// ── CHECKOUT ──────────────────────────────────────────────────────
router.post('/checkout', optionalAuth, paymentLimiter, [
  body('items').isArray({ min: 1, max: 20 }).withMessage('Items are required (max 20)'),
  body('items.*.productId').notEmpty().withMessage('Product ID required'),
  body('items.*.quantity').isInt({ min: 1, max: 99 }).withMessage('Invalid quantity'),
  body('customer.email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('customer.name').trim().notEmpty().isLength({ max: 60 }).withMessage('Customer name required'),
  body('customer.phone').trim().notEmpty()
    .matches(/^\+?[0-9\s\-()]{7,20}$/).withMessage('Valid phone number required'),
  body('shippingAddress.street').trim().notEmpty().isLength({ max: 200 }),
  body('shippingAddress.city').trim().notEmpty().isLength({ max: 100 }),
  body('shippingAddress.state').trim().notEmpty().isLength({ max: 100 }),
  body('promoCode')
    .optional({ checkFalsy: true })
    .isString().withMessage('Invalid promo code').bail()
    .trim().toUpperCase()
    .isLength({ max: MAX_PROMO_CODE_LENGTH }).withMessage('Invalid promo code'),
], async (req, res, next) => {
  const reservations = []; // tracks reservations made in this request
                            // so we can roll back cleanly on any failure

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });

    const { items, customer, shippingAddress } = req.body;
    const promoCode = req.body.promoCode || undefined; // already trimmed/uppercased by validator

    // ── 1. VALIDATE PRODUCTS ──────────────────────────────────────
    // Read available = stock - reserved so we don't oversell units
    // already held by in-flight checkouts.
    const validatedItems = [];
    for (const item of items) {
      const product = await Product.findById(item.productId)
        .select('name price stock reserved emoji isActive');
      if (!product || !product.isActive)
        return next(new AppError(`Product "${item.productId}" not available`, 400));

      const available = product.stock - (product.reserved || 0);
      if (available < item.quantity) {
        return next(new AppError(`Only ${available} units of "${product.name}" available`, 400));
      }
      validatedItems.push({
        product: product._id,
        name: product.name,
        emoji: product.emoji,
        price: product.price, // server-side price always
        quantity: item.quantity,
      });
    }

    // ── 2. ATOMICALLY RESERVE STOCK ───────────────────────────────
    // Done BEFORE creating the order or calling Nomba, so stock is
    // held for the duration of the checkout session regardless of how
    // long the Nomba await takes (up to 15 s).
    // Uses $expr/$subtract so the available-unit check and the increment
    // are a single atomic operation — safe under concurrent requests.
    for (const item of validatedItems) {
      const result = await Product.findOneAndUpdate(
        {
          _id: item.product,
          $expr: {
            $gte: [
              { $subtract: ['$stock', { $add: ['$reserved', 0] }] },
              item.quantity,
            ],
          },
        },
        { $inc: { reserved: item.quantity } },
        { new: true }
      );

      if (!result) {
        // Race condition: another checkout reserved the last unit(s)
        // between our read above and this update. Roll back what we
        // already reserved in this loop before returning.
        await releaseReservations(reservations);
        return next(new AppError(`"${item.name}" just went out of stock. Please update your cart.`, 409));
      }
      reservations.push({ productId: item.product, quantity: item.quantity });
    }

    // ── 3. PROMO CODE VALIDATION ──────────────────────────────────
    let appliedPromoCode;
    if (promoCode) {
      if (!PROMO_CODES[promoCode]) {
        await releaseReservations(reservations);
        return next(new AppError('Invalid promo code', 400));
      }
      const eligible = await isPromoEligible(promoCode, { userId: req.user?._id, email: customer.email });
      if (!eligible) {
        await releaseReservations(reservations);
        return next(new AppError('This code is only valid for first-time customers', 400));
      }
      appliedPromoCode = promoCode;
    }

    // ── 4. SERVER-SIDE PRICING ────────────────────────────────────
    const { subtotal, discount, shipping, total } = calculatePricing(validatedItems, appliedPromoCode);
    if (total < 10000) { // 10,000 kobo = ₦100.00 minimum
      await releaseReservations(reservations);
      return next(new AppError('Order total is too low', 400));
    }

    // ── 5. RESOLVE USER ───────────────────────────────────────────
    // getOrCreateGuestUser throws AppError(409) if the email belongs
    // to a non-guest registered account, forcing the user to log in.
    let userId;
    try {
      userId = req.user ? req.user._id : await getOrCreateGuestUser(customer.email, customer.name);
    } catch (err) {
      await releaseReservations(reservations);
      return next(err);
    }
    const isGuest = !req.user;

    // ── 6. CREATE PENDING ORDER ───────────────────────────────────
    // The sparse unique index { user, paymentStatus: 'pending' } on the
    // Order model means a duplicate-key error here if this user already
    // has an in-flight checkout — prevents double-submit race conditions.
    let order;
    try {
      order = await Order.create({
        user: userId,
        items: validatedItems,
        shippingAddress,
        subtotal, discount, shipping, total,
        promoCode: appliedPromoCode,
        status: 'pending',
        paymentStatus: 'pending',
        customerName: customer.name,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        guestEmail: isGuest ? customer.email : undefined,
      });
    } catch (err) {
      await releaseReservations(reservations);
      if (err.code === 11000) {
        // Duplicate pending order for this user — likely a double-submit
        return next(new AppError('You already have a checkout in progress. Please complete or cancel it first.', 409));
      }
      return next(err);
    }

    logger.info(`Order created: ${order.orderNumber} | ₦${toNaira(total).toFixed(2)} | user: ${userId}`);

    // ── 7. INITIATE NOMBA CHECKOUT ────────────────────────────────
    // Stock is reserved above, so even though this await can take up
    // to 15 s the units are held and won't be oversold. On any failure
    // we delete the order AND release reservations atomically via
    // Promise.allSettled (so one failure doesn't block the other).
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
          amount: toNaira(total).toFixed(2), // Nomba expects a naira string e.g. "1000.50"
          currency: 'NGN',
          description: `VitaCore Order #${order.orderNumber}`,
        },
      });
      checkoutUrl = nombaRes.data?.data?.checkoutLink;
      order.nombaReference = nombaRes.data?.data?.orderReference;
      await order.save();
    } catch (nombaErr) {
      // Run both cleanup tasks independently — a Mongo hiccup shouldn't
      // leave reservations pinned, and a reservation failure shouldn't
      // leave an orphaned order in the DB.
      await Promise.allSettled([
        Order.findByIdAndDelete(order._id),
        releaseReservations(reservations),
      ]);
      logger.error('Nomba checkout failed:', nombaErr.message);
      return next(new AppError('Payment gateway unavailable. Please try again shortly.', 503));
    }

    res.status(201).json({
      success: true,
      orderId: order._id,
      orderNumber: order.orderNumber,
      checkoutUrl,
      total: toNaira(total), // naira float e.g. 1000.50 — frontend displays this
    });
  } catch (err) {
    // Catch-all: release any reservations that were made before the
    // unexpected throw, then pass to the error handler.
    if (reservations.length) await releaseReservations(reservations);
    next(err);
  }
});

// ── VERIFY PAYMENT STATUS ─────────────────────────────────────────
// statusLimiter is more lenient than paymentLimiter (e.g. 30 req/min)
// because the frontend may poll this while the user sits on the
// "waiting for payment" screen.
router.get('/:reference/status', protect, statusLimiter, async (req, res, next) => {
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
          // processSuccessfulPayment does its own amount/currency check
          // before marking the order complete, so polling this endpoint
          // is just as safe as receiving the webhook.
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
// Called by both the webhook (webhooks/nomba.js) and the /status
// polling endpoint above. Idempotent — safe to call twice.
async function processSuccessfulPayment(order, nombaData = {}) {
  if (order.paymentStatus === 'completed') return;

  // Defense-in-depth: confirm what Nomba says was paid matches the
  // order total before marking it complete.
  // Nomba returns `amount` as a naira STRING (e.g. "1000.50").
  // We convert to kobo (integer) before comparing so float drift
  // can never cause a false mismatch. A ±1 kobo tolerance (< ₦0.01)
  // absorbs any rounding Nomba applies on their side.
  // NOTE: verify the field names below (`amount`, `currency`) against
  // Nomba's actual webhook and order-status response shapes.
  if (nombaData.amount !== undefined) {
    const paidKobo = toKobo(nombaData.amount); // "1000.50" → 100050
    if (!Number.isFinite(paidKobo) || Math.abs(paidKobo - order.total) > 1) {
      logger.error(`Payment amount mismatch for order ${order.orderNumber} — holding for manual review`, {
        expectedKobo: order.total,
        receivedNaira: nombaData.amount,
        receivedKobo: paidKobo,
      });
      // TODO: trigger admin alert (email / Slack) so this doesn't sit
      // silently as 'pending' forever.
      return;
    }
  }
  if (nombaData.currency && nombaData.currency !== 'NGN') {
    logger.error(`Payment currency mismatch for order ${order.orderNumber} — holding for manual review`, {
      expected: 'NGN',
      received: nombaData.currency,
    });
    return;
  }

  order.paymentStatus = 'completed';
  order.transactionId = nombaData.transactionId || nombaData.reference;
  order.paidAt = new Date();
  order.addStatus('paid', 'Payment confirmed via Nomba');
  await order.save();

  // Atomic stock decrement + reservation release in one operation.
  // The reservation was placed at checkout; now we convert it into a
  // real decrement. $gte guards against oversell (should be prevented
  // by the reservation, but belt-and-suspenders).
  const stockIssues = [];
  for (const item of order.items) {
    const result = await Product.findOneAndUpdate(
      { _id: item.product, stock: { $gte: item.quantity } },
      {
        $inc: {
          stock:     -item.quantity,
          totalSold:  item.quantity,
          reserved:  -item.quantity, // release the reservation
        },
      },
      { new: true }
    );

    if (!result) {
      // Decrement failed — oversold. Payment already captured.
      // Release the dangling reservation so the field stays accurate
      // for other products, then flag for manual admin resolution
      // (partial refund, backorder, restock).
      await Product.findByIdAndUpdate(item.product, { $inc: { reserved: -item.quantity } });
      stockIssues.push({
        product:   item.product.toString(),
        name:      item.name,
        requested: item.quantity,
      });
    }
  }

  if (stockIssues.length) {
    logger.error(`STOCK ISSUE — order ${order.orderNumber} paid but oversold`, {
      orderId: order._id.toString(),
      items: stockIssues,
    });
    // TODO: set order.fulfillmentFlag = true + save, and alert admin,
    // so this surfaces in the admin dashboard rather than just the logs.
  }

  try {
    await sendEmail({
      to: order.customerEmail,
      subject: `✅ Order Confirmed — ${order.orderNumber}`,
      template: 'orderConfirmation',
      data: {
        name:            order.customerName,
        orderNumber:     order.orderNumber,
        items:           order.items,
        // Convert kobo → naira for human-readable email display
        subtotal:        toNaira(order.subtotal),
        discount:        toNaira(order.discount),
        shipping:        toNaira(order.shipping),
        total:           toNaira(order.total),
        shippingAddress: order.shippingAddress,
      },
    });
  } catch (emailErr) {
    logger.error('Failed to send confirmation email:', emailErr.message);
  }

  logger.info(`Payment processed: ${order.orderNumber} | ₦${toNaira(order.total).toFixed(2)}`);
}

// ── ABANDONED ORDER CLEANUP ───────────────────────────────────────
// Call this on a cron schedule (e.g. every 30 minutes) to expire orders
// where the user abandoned the Nomba checkout page without paying.
// Releases the stock reservations so those units become available again.
//
// Usage: import and wire up in your scheduler, e.g.:
//   const { releaseAbandonedReservations } = require('./payments');
//   cron.schedule('*/30 * * * *', releaseAbandonedReservations);
async function releaseAbandonedReservations() {
  const EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
  const cutoff = new Date(Date.now() - EXPIRY_MS);

  const stale = await Order.find({
    paymentStatus: 'pending',
    createdAt: { $lt: cutoff },
  });

  for (const order of stale) {
    await releaseReservations(
      order.items.map(i => ({ productId: i.product, quantity: i.quantity }))
    );
    order.paymentStatus = 'expired';
    order.addStatus('cancelled', 'Checkout session expired — stock released');
    await order.save();
    logger.info(`Abandoned order expired: ${order.orderNumber}`);
  }
}

// ── GUEST USER HELPER ─────────────────────────────────────────────
async function getOrCreateGuestUser(email, name) {
  const existing = await User.findOne({ email });

  if (existing) {
    // SECURITY: do not silently attach a guest order to an existing
    // registered account — that lets anyone place orders against any
    // account whose email they know (order history pollution, spam
    // confirmation emails to a real user, etc.).
    // Only reuse accounts that were themselves created via guest checkout.
    //
    // ASSUMPTION: User schema has `isGuest: { type: Boolean, default: false }`.
    // Add this field if it doesn't exist yet.
    if (!existing.isGuest) {
      throw new AppError(
        'An account already exists with this email. Please log in to continue.',
        409
      );
    }
    return existing._id;
  }

  const crypto = require('crypto');
  const tempPassword = crypto.randomBytes(32).toString('hex');

  const user = await User.create({
    name: name || 'Guest',
    email,
    password: tempPassword, // lowercase `password` — verify this field
                             // name matches your User schema and that your
                             // pre-save hash hook fires on User.create().
    isGuest: true,
    isEmailVerified: false,
    isActive: true,
  });

  logger.info(`Guest user created: ${maskEmail(email)}`);
  return user._id;
}

module.exports = router;
module.exports.processSuccessfulPayment = processSuccessfulPayment;
module.exports.getOrCreateGuestUser = getOrCreateGuestUser;
module.exports.releaseAbandonedReservations = releaseAbandonedReservations;