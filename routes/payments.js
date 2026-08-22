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

// ⭐ FIX: was `require('../routes/webhooks')`, which created a circular
// require with webhooks.js (which itself requires this file for
// processSuccessfulPayment). Depending on load order that left
// initializeTransaction/verifyTransaction/evaluatePaymentAmount undefined
// here. Both route files now depend on this shared, dependency-free module
// instead of on each other — no more cycle.
const { initializeTransaction, verifyTransaction, evaluatePaymentAmount } = require('../services/monnifyclient');

const { getRedisClient } = require('../config/redis');

const router = express.Router();
const redis = getRedisClient();

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
  const result = await redis.set(key, 'locked', 'NX', 'EX', ttlSeconds);
  return result === 'OK';
}
async function releaseLock(key) {
  await redis.del(key);
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
  // TEMPORARY — remove once the payload-shape issue is confirmed/fixed.
  // Logs exactly what the client sent, before express-validator runs,
  // so you can see whether `customer` is missing keys vs. sending empty
  // strings vs. never arriving at all.
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
      const product = await Product.findById(item.productId)
        .select('name price stock reserved emoji isActive');
      if (!product || !product.isActive) {
        return next(new AppError(`Product "${item.productId}" not available`, 400));
      }
      const available = product.stock - (product.reserved || 0);
      if (available < item.quantity) {
        return next(new AppError(`Only ${available} units of "${product.name}" available`, 400));
      }
      validatedItems.push({
        product: product._id,
        name: product.name,
        emoji: product.emoji,
        price: product.price,
        quantity: item.quantity,
      });
    }
    logger.info('checkout: step 2 — products validated, reserving stock');

    // ── 2. Reserve stock atomically ──────────────────────────────
    for (const item of validatedItems) {
      const result = await Product.findOneAndUpdate(
        {
          _id: item.product,
          $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, item.quantity] },
        },
        { $inc: { reserved: item.quantity } },
        { returnDocument: 'after' }
      );
      if (!result) {
        await releaseReservations(reservations);
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
    const subtotal = validatedItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
    let discount = 0;
    if (appliedPromo) {
      discount = Math.round(subtotal * appliedPromo.discount);
    }
    const shipping = subtotal - discount >= 2500000 ? 0 : 250000; // ₦25,000
    const total = subtotal - discount + shipping;

    if (total < 10000) {
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
      const tokenData = await redis.get(`guest:token:${guestToken}`);
      logger.info('checkout: step 5b — guest token lookup complete');
      if (!tokenData) {
        await releaseReservations(reservations);
        return next(new AppError('Invalid or expired guest session', 401));
      }
      const guestEmail = customer.email.toLowerCase();
      let guestUser = await User.findOne({ guestToken: guestToken });
      if (!guestUser) {
        const tempPassword = crypto.randomBytes(32).toString('hex');
        guestUser = await User.create({
          name: customer.name || 'Guest',
          email: guestEmail,
          password: tempPassword,
          isGuest: true,
          guestToken: guestToken,
          isEmailVerified: false,
          isActive: true,
        });
        logger.info(`Guest user created with token: ${guestToken.slice(0, 8)}`);
      } else {
        if (guestUser.email !== guestEmail) {
          guestUser.email = guestEmail;
          await guestUser.save();
        }
      }
      userId = guestUser._id;
      isGuest = true;
    }

    // ── 5b. Auto-resolve any existing pending order for this user ──
    // Rather than let the unique_pending_payment_per_user index reject
    // this checkout outright (confusing 409 for a customer who just
    // wants to try again), check for a stuck pending order first.
    // - If it's genuinely fresh (within STALE_AFTER_MS), it's very
    //   likely a real double-submission (double-click, network retry) —
    //   let the unique index do its job and reject, since two live
    //   payment attempts for the same cart is exactly what it prevents.
    // - If it's older than that, treat it as abandoned: release its
    //   stock reservation and expire it right now, so this new checkout
    //   can proceed immediately instead of waiting on the cron.
    const STALE_AFTER_MS = 5 * 60 * 1000; // keep in sync with your comfort window
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
    // paymentReference must be unique per attempt — Monnify rejects reuse.
    // Fine as-is for a first attempt since order._id is freshly minted
    // above. If you ever add a "retry payment on an existing pending
    // order" endpoint, do NOT reuse this same reference on retry —
    // append a timestamp/nonce, e.g. `${order._id}-${Date.now()}`, or
    // Monnify will reject the init call as a duplicate reference.
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
      logger.error('Monnify checkout failed:', monnifyErr.message);
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

    // If still pending, poll Monnify — but with a lock, and only act on
    // PAID/OVERPAID here. Everything else (FAILED, EXPIRED, REVERSED,
    // REJECTED_PAYMENT) is handled authoritatively by the webhook so we
    // don't duplicate that state machine in two places.
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
  const EXPIRY_MS = 5 * 60 * 1000; // 15 minutes
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
    order.addStatus('cancelled', 'Checkout session expired');
    await order.save();
    logger.info(`Abandoned order expired: ${order.orderNumber}`);
  }
}

// ── EXPORTS ────────────────────────────────────────────────────────
module.exports = router;
module.exports.processSuccessfulPayment = processSuccessfulPayment;
module.exports.releaseAbandonedReservations = releaseAbandonedReservations;