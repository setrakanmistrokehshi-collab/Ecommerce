'use strict';

const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const EmailLog = require('../models/Emailog');
const { processSuccessfulPayment } = require('./payments'); // still fine — one-directional now
const { sendPaymentRejectedEmail } = require('../utils/email');
const logger = require('../utils/logger');

const { verifyTransaction, evaluatePaymentAmount } = require('../services/monnifyclient');

const { getCacheClient, isRedisReady } = require('../config/redis');


const router = express.Router();

function redis() {
  const client = getCacheClient();
  if (!client) {
    throw new Error('Redis client not available (REDIS_URL missing or still connecting)');
  }
  return client;
}

// ── CONFIGURATION ────────────────────────────────────────────────
const MONNIFY_SECRET_KEY = process.env.MONNIFY_SECRET_KEY;
const MONNIFY_WEBHOOK_IP = process.env.MONNIFY_WEBHOOK_IP || '35.242.133.146';
const ENFORCE_SIGNATURE = process.env.NODE_ENV === 'production';
const ENFORCE_IP_WHITELIST = process.env.MONNIFY_ENFORCE_IP_WHITELIST !== 'false';

// ── SIGNATURE VERIFICATION (unchanged) ────────────────────────────
function verifyMonnifySignature(rawBody, signature) {
  if (!signature || typeof signature !== 'string') return false;
  if (!MONNIFY_SECRET_KEY) {
    logger.error('❌ MONNIFY_SECRET_KEY not set — cannot verify webhook signature');
    return false;
  }
  if (!Buffer.isBuffer(rawBody)) {
    logger.error(
      'Webhook raw body is not a Buffer – ensure express.raw({ type: "application/json" }) is mounted on this route BEFORE any global express.json() middleware.'
    );
    return false;
  }

  const bodyString = rawBody.toString('utf8');
  const expected = crypto.createHash('sha512').update(MONNIFY_SECRET_KEY + bodyString).digest('hex');

  if (!/^[a-f0-9]{128}$/i.test(signature)) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

function isFromMonnifyIp(req) {
  const ip = (req.ip || '').replace('::ffff:', '');
  return ip === MONNIFY_WEBHOOK_IP;
}

// ── REDIS LOCK / IDEMPOTENCY HELPERS (unchanged, fail-safe) ──────
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

async function isEventProcessed(eventId) {
  if (!eventId) return false;
  try {
    if (!isRedisReady()) return false;
    const client = redis();
    if (!client) return false;
    return (await client.get(`webhook:processed:${eventId}`)) === '1';
  } catch (err) {
    logger.error(`⚠️ Redis isEventProcessed failed for ${eventId}`, {
      error: err.message,
    });
    return false;
  }
}

async function markEventProcessed(eventId, ttlSeconds = 86400) {
  if (!eventId) return;
  try {
    if (!isRedisReady()) return;
    const client = redis();
    if (!client) return;
    await client.set(`webhook:processed:${eventId}`, '1', 'EX', ttlSeconds);
  } catch (err) {
    logger.warn(`Redis markEventProcessed failed for ${eventId}`, {
      error: err.message,
    });
  }
}

// ── ORDER LOOKUP (unchanged) ──────────────────────────────────────
async function findOrderByReference(paymentReference) {
  if (!paymentReference) return null;
  const ref = String(paymentReference).trim();
  if (!ref) return null;
  const conditions = [{ monnifyReference: ref }];
  if (/^[a-f\d]{24}$/i.test(ref)) conditions.push({ _id: ref });
  return Order.findOne({ $or: conditions });
}

// ── WEBHOOK ENDPOINT ─────────────────────────────────────────────
router.post('/monnify', async (req, res) => {
  const rawBody = req.body;
  const signature = req.headers['monnify-signature'];

  if (ENFORCE_IP_WHITELIST && !isFromMonnifyIp(req)) {
    logger.error('Monnify webhook: request from non-whitelisted IP', { ip: req.ip });
    return res.status(401).json({ received: false, error: 'unauthorized origin' });
  }

  if (ENFORCE_SIGNATURE) {
    if (!verifyMonnifySignature(rawBody, signature)) {
      logger.error('Monnify webhook: signature verification FAILED', {
        ip: req.ip,
        hasSignatureHeader: !!signature,
      });
      return res.status(401).json({ received: false, error: 'invalid signature' });
    }
  } else if (signature && !verifyMonnifySignature(rawBody, signature)) {
    logger.warn('Monnify webhook: signature present but did not verify (non-production)');
  }

  let payload;
  try {
    payload = Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString('utf8')) : rawBody;
  } catch (err) {
    logger.error('Webhook: failed to parse JSON body', { error: err.message });
    return res.status(400).json({ received: false, error: 'invalid payload' });
  }

  const eventType = payload.eventType || payload.event;
  const eventData = payload.eventData || payload.data || {};
  const paymentReference = eventData.paymentReference;
  const transactionReference = eventData.transactionReference;

  const isRefundEvent = eventType === 'SUCCESSFUL_REFUND' || eventType === 'FAILED_REFUND';

  if (!paymentReference && !isRefundEvent) {
    logger.warn('Monnify webhook received without paymentReference', { eventType });
    return res.json({ received: true, warning: 'missing paymentReference' });
  }

  const eventId = transactionReference || `${eventType}:${paymentReference}`;
  if (await isEventProcessed(eventId)) {
    logger.info(`Webhook ${eventId} already processed — ignoring duplicate`);
    return res.json({ received: true, status: 'duplicate' });
  }

  const lockKey = `webhook:lock:${paymentReference || transactionReference}`;
  const locked = await acquireLock(lockKey, 60);
  if (!locked) {
    logger.warn(`Webhook: another instance already processing ${lockKey}`);
    return res.json({ received: true, status: 'already_processing' });
  }

  res.json({ received: true });

  setImmediate(async () => {
    try {
      logger.info(`Monnify webhook processing: ${eventType} | ref: ${paymentReference || transactionReference}`);

      if (isRefundEvent) {
        if (eventType === 'FAILED_REFUND') {
          const targetOrder = await Order.findOne({ transactionId: transactionReference });
          if (targetOrder) {
            targetOrder.addPaymentNote(`Refund failed: ${eventData.refundReason || 'unspecified'}`);
            await targetOrder.save();
          }
        } else {
          await handleReversal(transactionReference, {
            amountPaid: eventData.refundAmount ?? eventData.amountPaid,
          });
        }
        await markEventProcessed(eventId);
        return;
      }

      const order = await findOrderByReference(paymentReference);
      if (!order) {
        logger.error(`Order not found for paymentReference: ${paymentReference}`);
        return;
      }

      if (order.paymentStatus === 'completed') {
        logger.info(`Order ${order.orderNumber} already completed — ignoring`);
        return;
      }

      if (eventType === 'REJECTED_PAYMENT') {
        order.paymentStatus = 'rejected';
        order.addPaymentNote('Monnify rejected an over/under payment and returned funds to sender');
        await order.save();
        logger.warn(`Payment rejected by Monnify gateway for ${order.orderNumber}`);

        let receivedAmount;
        try {
          const verified = await verifyTransaction(paymentReference);
          receivedAmount = verified.amountPaid;
        } catch (err) {
          logger.warn(`Could not fetch verified amount for rejected-payment email on ${order.orderNumber}: ${err.message}`);
        }

        sendPaymentRejectedEmail(order, {
          expectedAmount: order.total / 100,
          receivedAmount,
        }).catch((err) =>
          logger.error(`Failed to send payment-rejected email for ${order.orderNumber}: ${err.message}`)
        );
        return;
      }

      if (eventType === 'FAILED_TRANSACTION' || eventType === 'FAILED_COLLECTION') {
        if (order.paymentStatus === 'pending') {
          order.paymentStatus = 'failed';
          order.addPaymentNote('Payment failed (Monnify)');
          await order.save();
        }
        return;
      }

      const verified = await verifyTransaction(paymentReference);

      const evaluation = evaluatePaymentAmount({
        expectedKobo: order.total,
        amountPaidNaira: verified.amountPaid,
      });

      if (evaluation.verdict === 'invalid') {
        order.paymentStatus = 'discrepancy';
        order.addPaymentNote(evaluation.reason);
        await order.save();
        logger.error(`Invalid amount for ${order.orderNumber}`, evaluation);
        return;
      }

      const mappedMethod = Order.mapPaymentMethod(verified.paymentMethod);

      switch (verified.paymentStatus) {
        case 'PAID':
        case 'OVERPAID': {
          if (evaluation.verdict === 'underpaid') {
            order.paymentStatus = 'discrepancy';
            order.addPaymentNote(
              `Status ${verified.paymentStatus} but verified amount (₦${verified.amountPaid}) is below expected`
            );
            await order.save();
            break;
          }

          order.transactionId = verified.transactionReference;
          order.paymentMethod = mappedMethod;
          order.paidAt = new Date();

          if (evaluation.verdict === 'overpaid') {
            order.overpaymentFlag = true;
            order.overpaidAmount = evaluation.excessKobo;
            order.addPaymentNote(
              `Overpaid by ₦${(evaluation.excessKobo / 100).toFixed(2)} — flagged for refund/credit review`
            );
            logger.warn(`Order ${order.orderNumber} overpaid by ${evaluation.excessKobo} kobo`);
          }

          await order.save();

          await processSuccessfulPayment(order, {
            transactionReference: verified.transactionReference,
            paymentMethod: mappedMethod,
            _verifiedAmountKobo: evaluation.paidKobo,
          });
          break;
        }

        case 'PARTIALLY_PAID': {
          order.paymentStatus = 'flagged_underpaid';
          order.addPaymentNote(
            `Underpaid by ₦${(evaluation.shortfallKobo / 100).toFixed(2)} — do not fulfil`
          );
          await order.save();
          logger.warn(`Order ${order.orderNumber} underpaid, shortfall ${evaluation.shortfallKobo} kobo`);
          break;
        }

        case 'PENDING':
          logger.info(`Order ${order.orderNumber} still PENDING on verification — no action`);
          break;

        case 'FAILED':
          if (order.paymentStatus === 'pending') {
            order.paymentStatus = 'failed';
            order.addPaymentNote('Payment failed (verified)');
            await order.save();
          }
          break;

        case 'EXPIRED':
          if (order.paymentStatus === 'pending') {
            order.paymentStatus = 'expired';
            order.addPaymentNote('Checkout session expired (verified)');
            await order.save();
          }
          break;

        case 'REVERSED':
          await handleReversal(transactionReference, verified);
          break;

        default:
          logger.info(`Unhandled verified paymentStatus: ${verified.paymentStatus}`, { paymentReference });
      }

      await markEventProcessed(eventId);
    } catch (err) {
      const sanitizedError = {
        message: err.message,
        code: err.code,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
      };
      logger.error('Monnify webhook processing error:', sanitizedError);
    } finally {
      await releaseLock(lockKey);
    }
  });
});

// ── REFUND / REVERSAL HANDLING (unchanged logic, now also called
// directly from the SUCCESSFUL_REFUND branch above) ──────────────
async function handleReversal(transactionReference, verified) {
  if (!transactionReference) {
    logger.error('Reversal event missing transactionReference');
    return;
  }

  const targetOrder = await Order.findOne({ transactionId: transactionReference });
  if (!targetOrder) {
    logger.error(`Order not found for reversal: transactionId=${transactionReference}`);
    return;
  }

  if (targetOrder.paymentStatus === 'refunded') {
    logger.info(`Order ${targetOrder.orderNumber} already refunded — ignoring duplicate`);
    return;
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    for (const item of targetOrder.items) {
      await Product.findByIdAndUpdate(
        item.product,
        { $inc: { stock: item.quantity, totalSold: -item.quantity } },
        { session }
      );
    }

    targetOrder.paymentStatus = 'refunded';
    targetOrder.addStatus(
      'refunded',
      `Refund/reversal processed: ₦${verified.amountPaid?.toLocaleString?.() ?? verified.amountPaid}`
    );
    await targetOrder.save({ session });

    await session.commitTransaction();
    logger.info(`✅ Refund/reversal processed for order ${targetOrder.orderNumber}`);
  } catch (err) {
    await session.abortTransaction();
    logger.error(`Refund transaction failed for ${targetOrder.orderNumber}`, { error: err.message });
    throw err;
  } finally {
    session.endSession();
  }
}

// ── BACKGROUND RECONCILIATION (unchanged, still imports from the
// shared service rather than defining its own copies) ────────────
async function syncStuckPayments() {
  const staleCutoff = new Date(Date.now() - 5 * 60 * 1000);

  const pendingOrders = await Order.find({
    paymentStatus: 'pending',
    createdAt: { $lt: staleCutoff },
    monnifyReference: { $exists: true, $ne: null },
  }).limit(100);

  if (pendingOrders.length === 0) return;

  logger.info(`🔄 Reconciliation: checking ${pendingOrders.length} stuck pending order(s)`);

  for (const order of pendingOrders) {
    const lockKey = `webhook:lock:${order.monnifyReference}`;
    const locked = await acquireLock(lockKey, 60);
    if (!locked) continue;

    try {
      const verified = await verifyTransaction(order.monnifyReference);
      const evaluation = evaluatePaymentAmount({
        expectedKobo: order.total,
        amountPaidNaira: verified.amountPaid,
      });

      if (
        (verified.paymentStatus === 'PAID' || verified.paymentStatus === 'OVERPAID') &&
        evaluation.verdict !== 'underpaid' &&
        evaluation.verdict !== 'invalid'
      ) {
        const mappedMethod = Order.mapPaymentMethod(verified.paymentMethod);
        order.transactionId = verified.transactionReference;
        order.paymentMethod = mappedMethod;
        order.paidAt = new Date();

        if (evaluation.verdict === 'overpaid') {
          order.overpaymentFlag = true;
          order.overpaidAmount = evaluation.excessKobo;
          order.addPaymentNote(
            `Overpaid by ₦${(evaluation.excessKobo / 100).toFixed(2)} (recovered via reconciliation) — flagged for refund/credit review`
          );
        }
        await order.save();

        await processSuccessfulPayment(order, {
          transactionReference: verified.transactionReference,
          paymentMethod: mappedMethod,
          _verifiedAmountKobo: evaluation.paidKobo,
        });
        logger.info(`🎉 Recovered stuck payment: ${order.orderNumber}`);
      } else if (verified.paymentStatus === 'PARTIALLY_PAID' || evaluation.verdict === 'underpaid') {
        order.paymentStatus = 'flagged_underpaid';
        order.addPaymentNote('Recovered via reconciliation sync — underpaid');
        await order.save();
        logger.warn(`⚠️ Reconciliation found underpayment for ${order.orderNumber}`);
      } else if (verified.paymentStatus === 'FAILED') {
        order.paymentStatus = 'failed';
        order.addPaymentNote('Payment failed (reconciliation)');
        await order.save();
      } else if (verified.paymentStatus === 'EXPIRED') {
        order.paymentStatus = 'expired';
        order.addPaymentNote('Payment expired (reconciliation)');
        await order.save();
      }
    } catch (error) {
      logger.error(`🚨 Reconciliation error for ${order.orderNumber}`, { error: error.message });
    } finally {
      await releaseLock(lockKey);
    }
  }
}

const cron = require('node-cron');
cron.schedule('*/5 * * * *', () => {
  syncStuckPayments().catch((err) => logger.error('Reconciliation cron crashed', { error: err.message }));
});

const { releaseAbandonedReservations } = require('./payments');
cron.schedule('*/3 * * * *', () => {
  releaseAbandonedReservations().catch((err) =>
    logger.error('Abandoned-order cleanup cron crashed', { error: err.message })
  );
});

// ── BREVO EMAIL WEBHOOK — now with User/EmailLog actually imported ─
router.post('/brevo', express.json(), async (req, res) => {
  const { event, email, ['message-id']: messageId, tag, tags } = req.body;

  await EmailLog.create({
    event,
    recipient: email,
    messageId,
    tags: tags || [],
    receivedAt: new Date(),
  });

  if (event === 'hardBounce' || event === 'blocked') {
    await User.updateOne({ email }, { emailDeliverable: false });
  }

  res.sendStatus(200);
});

module.exports = router;