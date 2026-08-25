'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const PromoCode = require('../models/PromoCode');
const { protect, optionalAuth } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { sendEmail } = require('../utils/email');
const { paymentLimiter, statusLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const {
  initializeTransaction,
  verifyTransaction,
  evaluatePaymentAmount,
} = require('../services/monnifyclient');
const { getCacheClient, isRedisReady } = require('../config/redis');

const router = express.Router();

/** Real ioredis instance */
function redis() {
  return getCacheClient();
}

// ── UTILITY: KOBO ↔ NAIRA ────────────────────────────────────────

function toKobo(naira) {
  return Math.round(Number(naira) * 100);
}
function toNaira(kobo) {
  return kobo / 100;
}

// ── DYNAMIC PROMO CODE SERVICE (DB-backed) ──────────────────────
async function validatePromoCode(code, userId, email) {
  if (!code) return null;

  const promo = await PromoCode.findOne({
    code: code.toUpperCase(),
    isActive: true,
    expiresAt: { $gt: new Date() },
  });
  if (!promo) return null;

  if (promo.maxUses && promo.usedCount >= promo.maxUses) return null;
  if (promo.perUserLimit) {
    const userUsage = await Order.countDocuments({
      user: userId,
      promoCode: promo.code,
      paymentStatus: 'completed',
    });
    if (userUsage >= promo.perUserLimit) return null;
  }

  if (promo.firstOrderOnly) {
    const priorOrder = await Order.findOne({
      paymentStatus: 'completed',
      $or: [{ user: userId }, { customerEmail: email.toLowerCase() }],
    }).lean();
    if (priorOrder) return null;
  }

  return promo;
}

// ── STOCK RESERVATION RELEASE ────────────────────────────────────
async function releaseReservations(reservations = []) {
  const results = await Promise.allSettled(
    reservations.map(({ productId, quantity }) =>
      Product.findByIdAndUpdate(productId, { $inc: { reserved: -quantity } })
    )
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.error(`Failed to release reservation for ${reservations[i].productId}`);
    }
  });
}

// ── REDIS LOCK HELPER ─────────────────────────────────────────────
async function acquireLock(key, ttlSeconds = 30) {
  try {
    if (!isRedisReady()) {
      logger.warn(`Redis not ready for lock ${key} — proceeding without lock`);
      return true;
    }
    const client = redis();
    if (!client) {
      logger.warn(`Redis client missing for lock ${key} — proceeding without lock`);
      return true;
    }
    const result = await client.set(key, 'locked', 'NX', 'EX', ttlSeconds);
    return result === 'OK';
  } catch (err) {
    logger.error(`⚠️ Redis acquireLock failed for ${key} — proceeding without lock`, {
      error: err.message,
    });
    return true;
  }
}

async function releaseLock(key) {
  try {
    if (!isRedisReady()) return;
    const client = redis();
    if (!client) return;
    await client.del(key);
  } catch (err) {
    logger.warn(`Redis releaseLock failed for ${key} (will expire via TTL)`, {
      error: err.message,
    });
  }
}
// ── PROCESS SUCCESSFUL PAYMENT (with Transaction + Lock) ────────
// verifiedData: { transactionReference, paymentMethod, amountPaidNaira, currency }

async function processSuccessfulPayment(order, verifiedData = {}) {
  const lockKey = `payment:process:${order._id}`;
  const locked = await acquireLock(lockKey, 60);
  if (!locked) {
    logger.warn(`Payment processing already running for ${order.orderNumber}`);
    return;
  }

  try {
    if (order.paymentStatus === 'completed') {
      logger.info(`Order ${order.orderNumber} already completed — skipping`);
      return;
    }

    // ── Amount validation ────────────────────────────────────────
    let paidKobo = verifiedData._verifiedAmountKobo;
    if (paidKobo === undefined && verifiedData.amountPaidNaira !== undefined) {
      const evaluation = evaluatePaymentAmount({
        expectedKobo: order.total,
        amountPaidNaira: verifiedData.amountPaidNaira,
      });
      if (evaluation.verdict === 'invalid' || evaluation.verdict === 'underpaid') {
        logger.error(`Amount mismatch for ${order.orderNumber}`, evaluation);
        order.paymentStatus = 'payment_discrepancy';
        await order.save();
        return;
      }
      paidKobo = evaluation.paidKobo;
    }

    if (verifiedData.currency && verifiedData.currency !== 'NGN') {
      logger.error(`Currency mismatch for ${order.orderNumber}`);
      order.paymentStatus = 'payment_discrepancy';
      await order.save();
      return;
    }

    // ── ATOMIC UPDATE using MongoDB Transaction ──────────────────
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      order.paymentStatus = 'completed';
      order.transactionId =
        verifiedData.transactionReference || verifiedData.reference || order.transactionId;
      order.paidAt = new Date();
      order.addStatus('paid', 'Payment confirmed');
      await order.save({ session });

      const stockIssues = [];
      for (const item of order.items) {
        const result = await Product.findOneAndUpdate(
          {
            _id: item.product,
            stock: { $gte: item.quantity },
          },
          {
            $inc: {
              stock: -item.quantity,
              totalSold: item.quantity,
              reserved: -item.quantity,
            },
          },
          { session, returnDocument: 'after' }
        );

        if (!result) {
          await Product.findByIdAndUpdate(
            item.product,
            { $inc: { reserved: -item.quantity } },
            { session }
          );
          stockIssues.push({
            product: item.product.toString(),
            name: item.name,
            requested: item.quantity,
          });
        }
      }

      if (order.promoCode) {
        await PromoCode.findOneAndUpdate(
          { code: order.promoCode },
          { $inc: { usedCount: 1 } },
          { session }
        );
      }

      await session.commitTransaction();

      if (stockIssues.length) {
        logger.error(`STOCK ISSUE — order ${order.orderNumber} paid but oversold`, {
          orderId: order._id.toString(),
          items: stockIssues,
        });
        // TODO: Send admin alert
      }
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
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
          subtotal: toNaira(order.subtotal),
          discount: toNaira(order.discount),
          shipping: toNaira(order.shipping),
          total: toNaira(order.total),
          shippingAddress: order.shippingAddress,
        },
      });
    } catch (emailErr) {
      logger.error('Failed to send confirmation email:', emailErr.message);
    }

    logger.info(`✅ Payment processed: ${order.orderNumber}`);
  } finally {
    await releaseLock(lockKey);
  }
}

// ── CHECKOUT ENDPOINT ─────────────────────────────────────────────
router.post('/checkout', optionalAuth, paymentLimiter, (req, res, next) => {
  logger.info('Checkout payload received', {
    contentType: req.headers['content-type'],
    body: req.body,
  });
  next();
}, [
  body('items').isArray({ min: 1, max: 20 }),
  body('items.*.productId').notEmpty(),
  body('items.*.quantity').isInt({ min: 1, max: 99 }),
  body('customer.email').isEmail().normalizeEmail(),
  body('customer.name').trim().notEmpty().isLength({ max: 60 }),
  body('customer.phone').trim().notEmpty().matches(/^\+?[0-9\s\-()]{7,20}$/),
  body('shippingAddress.street').trim().notEmpty().isLength({ max: 200 }),
  body('shippingAddress.city').trim().notEmpty().isLength({ max: 100 }),
  body('shippingAddress.state').trim().notEmpty().isLength({ max: 100 }),
  body('promoCode').optional({ checkFalsy: true }).isString().trim().toUpperCase(),
  body('guestToken').optional({ checkFalsy: true }).isString().isLength({ min: 32 }),
], async (req, res, next) => {
  const reservations = [];
  let order = null;

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { items, customer, shippingAddress, promoCode, guestToken } = req.body;
    logger.info('checkout: step 1 — starting product validation');

    // ── 1. Validate products ──────────────────────────────────────
    const validatedItems = [];
    for (const item of items) {
      if (!mongoose.Types.ObjectId.isValid(item.productId)) {
        await releaseReservations(reservations);
        return next(new AppError(`Invalid product id: ${item.productId}`, 400));
      }

      const product = await Product.findById(item.productId)
        .select('name price stock reserved isActive')
        .lean();

      if (!product || product.isActive === false) {
        await releaseReservations(reservations);
        return next(new AppError(`Product not found or unavailable`, 404));
      }

      const available = (product.stock ?? 0) - (product.reserved ?? 0);
      if (available < item.quantity) {
        return next(
          new AppError(`"${product.name}" just went out of stock.`, 409)
        );
      }

      validatedItems.push({
        product: product._id,
        name: product.name,
        price: product.price,          // stored in kobo
        quantity: item.quantity,
      });
    }

    logger.info('checkout: step 2 — products validated, reserving stock');

    // ── 2. Reserve stock atomically ──────────────────────────────
    for (const item of validatedItems) {
      const result = await Product.findOneAndUpdate(
        {
          _id: item.product,
          $expr: {
            $gte: [
              { $subtract: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$reserved', 0] }] },
              item.quantity,
            ],
          },
        },
        { $inc: { reserved: item.quantity } },
        { returnDocument: 'after' }
      );

      if (!result) {
        await releaseReservations(reservations);
        const current = await Product.findById(item.product).select('name stock reserved');
        logger.warn('OOS details', {
          productId: item.product,
          name: item.name,
          requested: item.quantity,
          stock: current?.stock,
          reserved: current?.reserved,
          available: (current?.stock ?? 0) - (current?.reserved ?? 0),
        });
        return next(new AppError(`"${item.name}" just went out of stock.`, 409));
      }

      reservations.push({ productId: item.product, quantity: item.quantity });
    }

    // ── 3. Validate promo code ────────────────────────────────────
    let appliedPromo = null;
    if (promoCode) {
      logger.info('checkout: step 3 — validating promo code');
      const userId = req.user?._id;
      const promo = await validatePromoCode(promoCode, userId, customer.email);
      if (!promo) {
        await releaseReservations(reservations);
        return next(new AppError('Invalid or expired promo code', 400));
      }
      appliedPromo = promo;
    }

    // ── 4. Calculate pricing ──────────────────────────────────────
    const subtotal = validatedItems.reduce(
      (sum, i) => sum + i.price * i.quantity,
      0
    );

    let discount = 0;
    if (appliedPromo) {
      // appliedPromo.discount MUST be a fraction: 0.1 = 10% off
      discount = Math.round(subtotal * appliedPromo.discount);
      discount = Math.min(discount, subtotal); // never more than subtotal
    }

    const FREE_SHIPPING_THRESHOLD_KOBO = 2_500_000; // ₦25,000
    const SHIPPING_FEE_KOBO = 250_000;              // ₦2,500

    const shipping =
      subtotal - discount >= FREE_SHIPPING_THRESHOLD_KOBO ? 0 : SHIPPING_FEE_KOBO;

    const total = subtotal - discount + shipping;

    if (total < 100_000) { // ₦1000
      await releaseReservations(reservations);
      return next(new AppError('Order total too low', 400));
    }

    // ── 5. Resolve user ───────────────────────────────────────────
    let userId;
    let isGuest = false;

    if (req.user) {
      userId = req.user._id;
    } else {
      logger.info('checkout: step 5 — resolving guest token via Redis');

      if (!guestToken) {
        await releaseReservations(reservations);
        return next(new AppError('Guest token required for guest checkout', 400));
      }

      let tokenData;
      try {
        const client = redis();
        if (!client || !isRedisReady()) {
          await releaseReservations(reservations);
          return next(new AppError('Session service unavailable. Please try again.', 503));
        }
        tokenData = await client.get(`guest:token:${guestToken}`);
      } catch (redisErr) {
        logger.error('Redis guest token lookup failed', redisErr);
        await releaseReservations(reservations);
        return next(new AppError('Session service unavailable. Please try again.', 503));
      }

      if (!tokenData) {
        await releaseReservations(reservations);
        return next(new AppError('Invalid or expired guest session', 401));
      }

      const guestEmail = customer.email.toLowerCase();

      let guestUser = await User.findOne({ guestToken });
      if (!guestUser) {
        try {
          const tempPassword = crypto.randomBytes(32).toString('hex');
          guestUser = await User.create({
            name: customer.name || 'Guest',
            email: guestEmail,
            password: tempPassword,
            isGuest: true,
            guestToken,
            isEmailVerified: false,
            isActive: true,
          });
          logger.info(`Guest user created: ${guestToken.slice(0, 8)}`);
        } catch (createErr) {
          // common: E11000 duplicate email
          logger.error('Guest User.create failed', {
            message: createErr.message,
            code: createErr.code,
          });
          await releaseReservations(reservations);

          if (createErr.code === 11000) {
            return next(new AppError('An account with this email already exists. Please log in.', 409));
          }
          return next(new AppError('Could not create guest account. Please try again.', 500));
        }
      } else if (guestUser.email !== guestEmail) {
        guestUser.email = guestEmail;
        await guestUser.save();
      }

      userId = guestUser._id;
      isGuest = true;
    }

    const STALE_AFTER_MS = 15 * 60 * 1000; // keep in sync with releaseAbandonedReservations
    const existingPending = await Order.findOne({ user: userId, paymentStatus: 'pending' });
    if (existingPending) {
      const ageMs = Date.now() - existingPending.createdAt.getTime();
      if (ageMs < STALE_AFTER_MS) {
        await releaseReservations(reservations);
        return next(new AppError(
          'You already have a payment in progress. Please complete it, or wait a few minutes and try again.',
          409
        ));
      }
      await releaseReservations(
        existingPending.items.map(i => ({ productId: i.product, quantity: i.quantity }))
      );
      existingPending.paymentStatus = 'expired';
      existingPending.addStatus('cancelled', 'Auto-expired: superseded by a new checkout attempt');
      await existingPending.save();
      logger.info(`Auto-expired stale pending order ${existingPending.orderNumber} to allow new checkout`);
    }

    // ── 6. Create pending order ──────────────────────────────────
    order = await Order.create({
      user: userId,
      items: validatedItems,
      shippingAddress,
      subtotal,
      discount,
      shipping,
      total,
      promoCode: appliedPromo?.code,
      status: 'pending',
      paymentStatus: 'pending',
      customerName: customer.name,
      customerEmail: customer.email.toLowerCase(),
      customerPhone: customer.phone,
      guestEmail: isGuest ? customer.email.toLowerCase() : undefined,
      guestToken: isGuest ? guestToken : undefined,
    });

    logger.info(`Order created: ${order.orderNumber} | ₦${toNaira(total).toFixed(2)}`);

    // ── 7. Initiate Monnify transaction ───────────────────────────
    const paymentReference = order._id.toString();
    let checkoutUrl;
    try {
      logger.info('checkout: step 7 — calling Monnify initializeTransaction', { paymentReference });
      const monnifyRes = await initializeTransaction({
        amount: toNaira(total), // Monnify expects a decimal Naira amount, not kobo
        paymentReference,
        customerName: customer.name,
        customerEmail: customer.email,
        paymentDescription: `Winners Health Order #${order.orderNumber}`,
        redirectUrl: `${process.env.FRONTEND_URL}/order-confirmation?ref=${paymentReference}`,
      });
      logger.info('checkout: step 7b — Monnify initializeTransaction returned', {
        hasCheckoutUrl: !!monnifyRes.checkoutUrl,
      });
      checkoutUrl = monnifyRes.checkoutUrl;
      order.monnifyReference = monnifyRes.paymentReference || paymentReference;
      await order.save();
    } catch (monnifyErr) {
      await Promise.allSettled([
        Order.findByIdAndDelete(order._id),
        releaseReservations(reservations),
      ]);
      logger.error('Monnify checkout failed', {
        message: monnifyErr.message,
        monnifyResponse: monnifyErr.response?.data,
        status: monnifyErr.response?.status,
      });
      return next(new AppError('Payment gateway unavailable. Please try again.', 503));
    }

    res.status(201).json({
      success: true,
      orderId: order._id,
      orderNumber: order.orderNumber,
      checkoutUrl,
      total: toNaira(total),
      guestToken: isGuest ? guestToken : undefined,
    });
  } catch (err) {
    if (reservations.length) await releaseReservations(reservations);
    if (order) await Order.findByIdAndDelete(order._id).catch(() => {});
    next(err);
  }
});

// ── STATUS POLLING ENDPOINT (with Lock) ──────────────────────────
router.get('/:reference/status', protect, statusLimiter, async (req, res, next) => {
  try {
    const ref = req.params.reference;
    const order = await Order.findOne({
      $or: [
        ...(/^[a-f\d]{24}$/i.test(ref) ? [{ _id: ref }] : []),
        { monnifyReference: ref },
        { orderNumber: ref },
      ],
    });
    if (!order) return next(new AppError('Order not found', 404));

    if (order.user.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    if (order.paymentStatus === 'pending' && order.monnifyReference) {
      const lockKey = `status:poll:${order._id}`;
      const locked = await acquireLock(lockKey, 10);
      if (locked) {
        try {
          const verified = await verifyTransaction(order.monnifyReference);
          if (verified.paymentStatus === 'PAID' || verified.paymentStatus === 'OVERPAID') {
            await processSuccessfulPayment(order, {
              transactionReference: verified.transactionReference,
              paymentMethod: verified.paymentMethod,
              amountPaidNaira: verified.amountPaid,
              currency: 'NGN',
            });
          }
        } catch (err) {
          logger.warn('Monnify status poll failed:', err.message);
        } finally {
          await releaseLock(lockKey);
        }
      }
    }

    const freshOrder = await Order.findById(order._id).populate('items.product', 'name emoji');
    res.json({ success: true, order: freshOrder });
  } catch (err) {
    next(err);
  }
});

// ── ABANDONED ORDER CLEANUP ──────────────────────────────────────
async function releaseAbandonedReservations() {
  const EXPIRY_MS = 15 * 60 * 1000; // 15 min — don't kill in-flight card/OTP
  const cutoff = new Date(Date.now() - EXPIRY_MS);

  const stale = await Order.find({
    paymentStatus: 'pending',
    createdAt: { $lt: cutoff },
    paidAt: { $exists: false },
    transactionId: { $exists: false },
  });

  for (const order of stale) {
    // If Monnify already collected, complete — don't expire
    if (order.monnifyReference) {
      try {
        const verified = await verifyTransaction(order.monnifyReference);
        if (verified.paymentStatus === 'PAID' || verified.paymentStatus === 'OVERPAID') {
          await processSuccessfulPayment(order, {
            transactionReference: verified.transactionReference,
            paymentMethod: verified.paymentMethod,
            amountPaidNaira: verified.amountPaid,
            currency: 'NGN',
          });
          continue;
        }
      } catch (err) {
        logger.warn(`Cleanup verify failed for ${order.orderNumber}: ${err.message}`);
      }
    }

    await releaseReservations(
      order.items.map((i) => ({ productId: i.product, quantity: i.quantity }))
    );
    order.paymentStatus = 'expired';
    order.addStatus('cancelled', 'Checkout session expired');
    await order.save();
    logger.info(`Abandoned order expired: ${order.orderNumber}`);
  }
}

// ── EXPORTS ────────────────────────────────────────────────────────
module.exports = router;
module.exports.processSuccessfulPayment = processSuccessfulPayment;
module.exports.releaseAbandonedReservations = releaseAbandonedReservations;