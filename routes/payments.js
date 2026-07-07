'use strict';

const express = require('express');
const axios = require('axios');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const { Redis } = require('ioredis');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const PromoCode = require('../models/PromoCode'); // we'll define this schema
const { protect, optionalAuth } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { sendEmail } = require('../utils/email');
const { paymentLimiter, statusLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const router = express.Router();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// ── NOMBA API CLIENT WITH RETRY ──────────────────────────────────
let nombaTokenCache = { token: null, expiresAt: 0 };
let nombaTokenPromise = null;

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

async function nombaRequest(method, endpoint, data = {}, retries = 2) {
  const token = await getNombaToken();
  const url = `${process.env.NOMBA_BASE_URL}${endpoint}`;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await axios({
        method,
        url,
        data,
        headers: {
          Authorization: `Bearer ${token}`,
          accountId: process.env.NOMBA_ACCOUNT_ID,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });
    } catch (err) {
      if (attempt > retries) throw err;
      const delay = 1000 * Math.pow(2, attempt - 1);
      logger.warn(`Nomba request retry ${attempt} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
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

  // Check usage limits
  if (promo.maxUses && promo.usedCount >= promo.maxUses) return null;
  if (promo.perUserLimit) {
    const userUsage = await Order.countDocuments({
      user: userId,
      promoCode: promo.code,
      paymentStatus: 'completed',
    });
    if (userUsage >= promo.perUserLimit) return null;
  }

  // First‑order only check
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
async function processSuccessfulPayment(order, nombaData = {}) {
  // 1. Distributed lock per order to prevent concurrent calls
  const lockKey = `payment:process:${order._id}`;
  const locked = await acquireLock(lockKey, 60);
  if (!locked) {
    logger.warn(`Payment processing already running for ${order.orderNumber}`);
    return;
  }

  try {
    // 2. Double-check status
    if (order.paymentStatus === 'completed') {
      logger.info(`Order ${order.orderNumber} already completed — skipping`);
      return;
    }

    // 3. Amount normalisation (webhook already does this, but status poll may call directly)
    let paidKobo = nombaData._normalizedAmountKobo;
    if (paidKobo === undefined && nombaData.amount !== undefined) {
      const normalized = normalizeNombaAmount(nombaData.amount);
      if (!normalized.valid) {
        logger.error(`Invalid amount format for ${order.orderNumber}`);
        order.paymentStatus = 'payment_discrepancy';
        await order.save();
        return;
      }
      paidKobo = normalized.kobo;
    }

    // 4. Validate amount if we have it
    if (paidKobo !== undefined) {
      if (Math.abs(paidKobo - order.total) > 1) {
        logger.error(`Amount mismatch for ${order.orderNumber}`, {
          expected: order.total,
          received: paidKobo,
        });
        order.paymentStatus = 'payment_discrepancy';
        await order.save();
        return;
      }
    }

    if (nombaData.currency && nombaData.currency !== 'NGN') {
      logger.error(`Currency mismatch for ${order.orderNumber}`);
      order.paymentStatus = 'payment_discrepancy';
      await order.save();
      return;
    }

    // 5. ⭐ ATOMIC UPDATE using MongoDB Transaction ⭐
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 5a. Update order status
      order.paymentStatus = 'completed';
      order.transactionId = nombaData.transactionId || nombaData.reference || order.transactionId;
      order.paidAt = new Date();
      order.addStatus('paid', 'Payment confirmed');
      await order.save({ session });

      // 5b. Decrement stock & release reservations atomically
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
              reserved: -item.quantity, // release reservation
            },
          },
          { session, new: true }
        );

        if (!result) {
          // Oversold within the transaction — release the dangling reservation
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

      // 5c. Increment promo code usage if applicable
      if (order.promoCode) {
        await PromoCode.findOneAndUpdate(
          { code: order.promoCode },
          { $inc: { usedCount: 1 } },
          { session }
        );
      }

      // 5d. Commit transaction
      await session.commitTransaction();

      // 5e. Log stock issues after commit (don't rollback for oversell, just alert)
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

    // 6. Send confirmation email (async, non‑blocking)
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
router.post('/checkout', optionalAuth, paymentLimiter, [
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
  // Guest token: required for guest checkout, prevents email pollution
  body('guestToken').optional({ checkFalsy: true }).isString().isLength({ min: 32 }),
], async (req, res, next) => {
  const reservations = [];
  let order = null;

  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { items, customer, shippingAddress, promoCode, guestToken } = req.body;

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

    // ── 2. Reserve stock atomically ──────────────────────────────
    for (const item of validatedItems) {
      const result = await Product.findOneAndUpdate(
        {
          _id: item.product,
          $expr: { $gte: [{ $subtract: ['$stock', '$reserved'] }, item.quantity] },
        },
        { $inc: { reserved: item.quantity } },
        { new: true }
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
      // Guest checkout: require a valid guest token OR create one now
      // For production: your frontend generates a secure guest token (JWT/UUID)
      // and stores it in session/localStorage.
      if (!guestToken) {
        await releaseReservations(reservations);
        return next(new AppError('Guest token required for guest checkout', 400));
      }
      // Verify guest token (simplified: check if it exists in Redis/DB)
      const tokenData = await redis.get(`guest:token:${guestToken}`);
      if (!tokenData) {
        await releaseReservations(reservations);
        return next(new AppError('Invalid or expired guest session', 401));
      }
      // Create or fetch guest user tied to this token
      const guestEmail = customer.email.toLowerCase();
      // Use token as unique identifier to avoid email pollution
      let guestUser = await User.findOne({ guestToken: guestToken });
      if (!guestUser) {
        // Create new guest user
        const crypto = require('crypto');
        const tempPassword = crypto.randomBytes(32).toString('hex');
        guestUser = await User.create({
          name: customer.name || 'Guest',
          email: guestEmail,
          password: tempPassword,
          isGuest: true,
          guestToken: guestToken, // store token for future lookups
          isEmailVerified: false,
          isActive: true,
        });
        logger.info(`Guest user created with token: ${guestToken.slice(0, 8)}`);
      } else {
        // Update email if changed
        if (guestUser.email !== guestEmail) {
          guestUser.email = guestEmail;
          await guestUser.save();
        }
      }
      userId = guestUser._id;
      isGuest = true;
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

    // ── 7. Initiate Nomba checkout ────────────────────────────────
    let checkoutUrl;
    try {
      const nombaRes = await nombaRequest('POST', '/checkout/orders', {
        orderReference: order._id.toString(),
        customerId: customer.email,
        callbackUrl: `${process.env.BASE_URL}/webhooks/nomba`,
        customer: {
          email: customer.email,
          name: customer.name,
          phoneNumber: customer.phone,
        },
        order: {
          orderReference: order._id.toString(),
          customerId: customer.email,
          callbackUrl: `${process.env.BASE_URL}/webhooks/nomba`,
          amount: toNaira(total).toFixed(2),
          currency: 'NGN',
          description: `VitaCore Order #${order.orderNumber}`,
        },
      });
      checkoutUrl = nombaRes.data?.data?.checkoutLink;
      order.nombaReference = nombaRes.data?.data?.orderReference;
      await order.save();
    } catch (nombaErr) {
      // Cleanup: delete order + release reservations
      await Promise.allSettled([
        Order.findByIdAndDelete(order._id),
        releaseReservations(reservations),
      ]);
      logger.error('Nomba checkout failed:', nombaErr.message);
      return next(new AppError('Payment gateway unavailable. Please try again.', 503));
    }

    res.status(201).json({
      success: true,
      orderId: order._id,
      orderNumber: order.orderNumber,
      checkoutUrl,
      total: toNaira(total),
      // Return guest token to frontend for future requests
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
        { nombaReference: ref },
        { orderNumber: ref },
      ],
    });
    if (!order) return next(new AppError('Order not found', 404));

    if (order.user.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return next(new AppError('Not authorized', 403));
    }

    // If still pending, poll Nomba but with a lock
    if (order.paymentStatus === 'pending') {
      const lockKey = `status:poll:${order._id}`;
      const locked = await acquireLock(lockKey, 10);
      if (locked) {
        try {
          const nombaRes = await nombaRequest('GET', `/checkout/orders/${order._id}`);
          if (nombaRes.data?.data?.status === 'successful') {
            await processSuccessfulPayment(order, nombaRes.data.data);
          }
        } catch (err) {
          logger.warn('Nomba status poll failed:', err.message);
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
  const EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
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

// ── NOMBA AMOUNT NORMALISER ──────────────────────────────────────
function normalizeNombaAmount(raw) {
  if (raw === undefined || raw === null) return { valid: false, kobo: 0 };
  const num = Number(raw);
  if (!Number.isFinite(num)) return { valid: false, kobo: 0 };
  // If > 1000 → Kobo; else → Naira
  return { valid: true, kobo: num > 1000 ? Math.round(num) : Math.round(num * 100) };
}

// ── EXPORTS ────────────────────────────────────────────────────────
module.exports = router;
module.exports.processSuccessfulPayment = processSuccessfulPayment;
module.exports.releaseAbandonedReservations = releaseAbandonedReservations;