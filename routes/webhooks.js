'use strict';

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const mongoose = require('mongoose');
const cron = require('node-cron');
const { Redis } = require('ioredis');

const Order = require('../models/Order');
const Product = require('../models/Product');
const { processSuccessfulPayment } = require('./payments'); // same folder
const { sendPaymentRejectedEmail } = require("../utils/email"); // adjust path if this lives elsewhere
const logger = require('../utils/logger');

// ── Redis client ──────────────────────────────────────────────────

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
 
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false, // reject immediately instead of buffering while disconnected
  retryStrategy(times) {
    return Math.min(times * 200, 5000); // capped backoff, keeps retrying in the background
  },
});

redis.on('error', (err) => {
  logger.error('❌ Redis connection error', { error: err.message });
});

redis.on('ready', () => {
  logger.info('✅ Redis connected');
});

const router = express.Router();

// ── CONFIGURATION ────────────────────────────────────────────────
// NOTE: base URL differs by environment — this was wrong in the snippet
// you had ("https://monnify.com"). Sandbox and live are separate hosts.
const MONNIFY_BASE_URL =
  process.env.MONNIFY_BASE_URL ||
  (process.env.NODE_ENV === 'production'
    ? 'https://api.monnify.com'
    : 'https://sandbox.monnify.com');

const MONNIFY_API_KEY = process.env.MONNIFY_API_KEY;
const MONNIFY_SECRET_KEY = process.env.MONNIFY_SECRET_KEY;
const MONNIFY_CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE;

// Monnify's documented webhook source IP. Whitelisting this is one of
// their own recommended practices, alongside signature verification.
const MONNIFY_WEBHOOK_IP = process.env.MONNIFY_WEBHOOK_IP || '35.242.133.146';

const ENFORCE_SIGNATURE = process.env.NODE_ENV === 'production';
const ENFORCE_IP_WHITELIST = process.env.MONNIFY_ENFORCE_IP_WHITELIST !== 'false';

// ── ACCESS TOKEN (cached — tokens are valid ~1hr, don't re-auth every call) ─
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getMonnifyAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  try {
    const credentials = Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET_KEY}`).toString('base64');
    const response = await axios.post(
      `${MONNIFY_BASE_URL}/api/v1/auth/login`,
      {},
      { headers: { Authorization: `Basic ${credentials}` }, timeout: 15000 }
    );

    const { accessToken, expiresIn } = response.data.responseBody;
    cachedToken = accessToken;
    // Refresh a little early (90s buffer) rather than exactly on expiry.
    cachedTokenExpiry = Date.now() + (Math.max(expiresIn - 90, 30) * 1000);
    return cachedToken;
  } catch (error) {
    logger.error('❌ Failed to fetch Monnify access token', { error: error.message });
    cachedToken = null;
    cachedTokenExpiry = 0;
    return null;
  }
}

// ── SIGNATURE VERIFICATION ──────────────────────────────────────

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
  const expected = crypto
    .createHash('sha512')
    .update(MONNIFY_SECRET_KEY + bodyString)
    .digest('hex');

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

// ── REDIS LOCK / IDEMPOTENCY HELPERS ────────────────────────────
// All four fail SAFE if Redis is unreachable rather than throwing
// uncaught and killing webhook processing:
async function acquireLock(key, ttlSeconds = 30) {
  try {
    const result = await redis.set(key, 'locked', 'NX', 'EX', ttlSeconds);
    return result === 'OK';
  } catch (err) {
    logger.error(`⚠️ Redis acquireLock failed for ${key} — proceeding without lock`, {
      error: err.message,
    });
    return true; // fail open
  }
}

async function releaseLock(key) {
  await redis.del(key).catch((err) =>
    logger.warn(`Redis releaseLock failed for ${key} (will expire via TTL)`, { error: err.message })
  );
}

async function isEventProcessed(eventId) {
  if (!eventId) return false;
  try {
    return (await redis.get(`webhook:processed:${eventId}`)) === '1';
  } catch (err) {
    logger.error(`⚠️ Redis isEventProcessed failed for ${eventId} — assuming not processed`, {
      error: err.message,
    });
    return false; // fail open — rely on the MongoDB-level guard instead
  }
}

async function markEventProcessed(eventId, ttlSeconds = 86400) {
  if (!eventId) return;
  await redis.set(`webhook:processed:${eventId}`, '1', 'EX', ttlSeconds).catch((err) =>
    logger.warn(`Redis markEventProcessed failed for ${eventId}`, { error: err.message })
  );
}

// ── ORDER LOOKUP ─────────────────────────────────────────────────
// order.monnifyReference matches Order.js — renamed from nombaReference.
async function findOrderByReference(paymentReference) {
  if (!paymentReference) return null;
  const ref = String(paymentReference).trim();
  if (!ref) return null;

  const conditions = [{ monnifyReference: ref }];
  if (/^[a-f\d]{24}$/i.test(ref)) {
    conditions.push({ _id: ref });
  }
  return Order.findOne({ $or: conditions });
}

// ── SERVER-SIDE VERIFICATION (authoritative — never trust the webhook body) ─
async function verifyTransaction(paymentReference) {
  const accessToken = await getMonnifyAccessToken();
  if (!accessToken) {
    throw new Error('Could not obtain Monnify access token for verification');
  }

  const response = await axios.get(
    `${MONNIFY_BASE_URL}/api/v2/merchant/transactions/query`,
    {
      params: { paymentReference },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    }
  );

  const body = response.data.responseBody;
  return {
    paymentStatus: body.paymentStatus, // PAID | PARTIALLY_PAID | PENDING | OVERPAID | FAILED | REVERSED | EXPIRED
    amountPaid: Number(body.amountPaid || 0), // Naira, decimal — NOT kobo
    totalPayable: Number(body.totalPayable || 0),
    settlementAmount: Number(body.settlementAmount || 0),
    paymentMethod: body.paymentMethod,
    transactionReference: body.transactionReference,
    paymentSourceInformation: body.paymentSourceInformation,
  };
}

// ── OVERPAYMENT / UNDERPAYMENT GUARD ────────────────────────────
// This is the function that decides whether an amount actually satisfies
// an order. Called against the *verified* amount from verifyTransaction(),
// never against the raw webhook payload.
//
// order.total is assumed stored in kobo (matches the rest of this codebase).
// Monnify reports amountPaid in Naira as a decimal, so it's converted here.
//
// Returns one of: 'exact' | 'overpaid' | 'underpaid' | 'invalid'
function evaluatePaymentAmount({ expectedKobo, amountPaidNaira }) {
  if (!Number.isFinite(expectedKobo) || expectedKobo <= 0) {
    return { verdict: 'invalid', reason: 'Invalid expected amount on order' };
  }

  const paidKobo = Math.round(Number(amountPaidNaira) * 100);
  if (!Number.isFinite(paidKobo)) {
    return { verdict: 'invalid', reason: `Unparseable amountPaid: ${amountPaidNaira}` };
  }
  const diff = paidKobo - expectedKobo;
  if (Math.abs(diff) <= 1) {
    return { verdict: 'exact', paidKobo, expectedKobo, diffKobo: 0 };
  }
  if (diff < 0) {
    return { verdict: 'underpaid', paidKobo, expectedKobo, shortfallKobo: -diff };
  }
  return { verdict: 'overpaid', paidKobo, expectedKobo, excessKobo: diff };
}

// ── WEBHOOK ENDPOINT ─────────────────────────────────────────────
router.post('/monnify', async (req, res) => {
  const rawBody = req.body; // must be a Buffer
  const signature = req.headers['monnify-signature'];

  if (ENFORCE_IP_WHITELIST && !isFromMonnifyIp(req)) {
    logger.error('Monnify webhook: request from non-whitelisted IP', { ip: req.ip });
    return res.status(401).json({ received: false, error: 'unauthorized origin' });
  }

  // ── 2. Signature verification ───────────────────────────────────
  // Required in production. Sandbox never sends this header, so we skip
  // strictly on signature there — verifyTransaction() below is the real
  // gate in that case.
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

  // ── 3. Parse payload ─────────────────────────────────────────────
  let payload;
  try {
    payload = Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString('utf8')) : rawBody;
  } catch (err) {
    logger.error('Webhook: failed to parse JSON body', { error: err.message });
    return res.status(400).json({ received: false, error: 'invalid payload' });
  }

  // across versions before (see their changelog).
  const eventType = payload.eventType || payload.event;
  const eventData = payload.eventData || payload.data || {};
  const paymentReference = eventData.paymentReference;
  const transactionReference = eventData.transactionReference;

  if (!paymentReference) {
    logger.warn('Monnify webhook received without paymentReference', { eventType });
    return res.json({ received: true, warning: 'missing paymentReference' });
  }

  // ── 4. Idempotency ────────────────────────────────────────────────
  const eventId = transactionReference || `${eventType}:${paymentReference}`;
  if (await isEventProcessed(eventId)) {
    logger.info(`Webhook ${eventId} already processed — ignoring duplicate`);
    return res.json({ received: true, status: 'duplicate' });
  }

  // ── 5. Distributed lock per order ───────────────────────────────
  const lockKey = `webhook:lock:${paymentReference}`;
  const locked = await acquireLock(lockKey, 60);
  if (!locked) {
    logger.warn(`Webhook: another instance already processing ${paymentReference}`);
    return res.json({ received: true, status: 'already_processing' });
  }

  // ── 6. Acknowledge immediately — Monnify retries every 5 min up to
  // 12 times if it doesn't get a prompt 200. ──────────────────────
  res.json({ received: true });

  setImmediate(async () => {
    try {
      logger.info(`Monnify webhook processing: ${eventType} | ref: ${paymentReference}`);

      const order = await findOrderByReference(paymentReference);
      if (!order) {
        logger.error(`Order not found for paymentReference: ${paymentReference}`);
        return;
      }

      if (order.paymentStatus === 'completed') {
        logger.info(`Order ${order.orderNumber} already completed — ignoring`);
        return;
      }

      // ── Explicit REJECTED_PAYMENT: Monnify already returned the funds.
      if (eventType === 'REJECTED_PAYMENT') {
        order.paymentStatus = 'rejected'; // valid enum value on Order.js
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
            // TODO: trigger refund-of-excess or wallet-credit workflow here.
            logger.warn(`Order ${order.orderNumber} overpaid by ${evaluation.excessKobo} kobo`);
          }

          await order.save(); // persist paymentMethod/overpayment fields before fulfilment runs

          await processSuccessfulPayment(order, {
            transactionReference: verified.transactionReference,
            paymentMethod: mappedMethod,
            _verifiedAmountKobo: evaluation.paidKobo,
          });
          break;
        }

        case 'PARTIALLY_PAID': {
          order.paymentStatus = 'flagged_underpaid'; // valid enum value, order stays unfulfilled
          order.addPaymentNote(
            `Underpaid by ₦${(evaluation.shortfallKobo / 100).toFixed(2)} — do not fulfil`
          );
          await order.save();
          logger.warn(`Order ${order.orderNumber} underpaid, shortfall ${evaluation.shortfallKobo} kobo`);
          // TODO: trigger customer notification requesting the balance,
          // or auto-refund the partial amount depending on your polic
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
          logger.info(`Unhandled verified paymentStatus: ${verified.paymentStatus}`, {
            paymentReference,
          });
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

// ── REFUND / REVERSAL HANDLING (same stock-rollback pattern as before) ─
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

    targetOrder.paymentStatus = 'refunded'; // valid on both paymentStatus AND status enums
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

// ── BACKGROUND RECONCILIATION ──
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
    if (!locked) continue; // a webhook is actively handling this one right now

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
        order.paymentStatus = 'expired'; // real enum value, shared with releaseAbandonedReservations()
        order.addPaymentNote('Payment expired (reconciliation)');
        await order.save();
      }
      // PENDING / REJECTED_PAYMENT etc. — leave as-is, next sync pass will re-check.
    } catch (error) {
      logger.error(`🚨 Reconciliation error for ${order.orderNumber}`, { error: error.message });
    } finally {
      await releaseLock(lockKey);
    }
  }
}

cron.schedule('*/5 * * * *', () => {
  syncStuckPayments().catch((err) =>
    logger.error('Reconciliation cron crashed', { error: err.message })
  );
});

// ── BREVO EMAIL WEBHOOK (unchanged) ──────────────────────────────
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
module.exports.verifyTransaction = verifyTransaction;
module.exports.evaluatePaymentAmount = evaluatePaymentAmount;