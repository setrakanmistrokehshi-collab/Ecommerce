'use strict';

const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Redis } = require('ioredis');

const Order = require('../models/Order');
const Product = require('../models/Product');
const { processSuccessfulPayment } = require('./payments'); // same folder
const logger = require('../utils/logger');

// ── Redis client ──────────────────────────────────────────────────
// Reuse an existing client if you have one, or initialise here.
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

const router = express.Router();

// ── CONFIGURATION ──────────────────────────────────────────────────
// Signature bypass is ONLY allowed in development with an explicit flag.
// Production never bypasses, regardless of environment variables.
const DEV_BYPASS_ENABLED =
  process.env.NODE_ENV === 'development' &&
  process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true';

// ── SIGNATURE VERIFICATION ────────────────────────────────────────
function verifyNombaSignature(rawBody, signature) {
  // If secret is missing, reject unless dev bypass is on
  if (!process.env.NOMBA_WEBHOOK_SECRET) {
    if (DEV_BYPASS_ENABLED) {
      logger.warn('⚠️  NOMBA_WEBHOOK_SECRET not set — dev bypass accepting unsigned webhook');
      return true;
    }
    logger.error('❌ NOMBA_WEBHOOK_SECRET not set — rejecting webhook');
    return false;
  }

  if (!signature || typeof signature !== 'string') return false;

  // Raw body MUST be a Buffer – this ensures express.raw() is mounted correctly
  if (!Buffer.isBuffer(rawBody)) {
    logger.error(
      'Webhook raw body is not a Buffer – ensure express.raw({ type: "application/json" }) is mounted BEFORE any global express.json() middleware on this route.'
    );
    return false;
  }

  // Compute expected HMAC-SHA512 signature
  const expected = crypto
    .createHmac('sha512', process.env.NOMBA_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  // Validate shape before timingSafeEqual (prevents length mismatch errors)
  if (!/^[a-f0-9]{128}$/i.test(signature)) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

// ── REDIS LOCK HELPERS ────────────────────────────────────────────
async function acquireLock(key, ttlSeconds = 30) {
  const result = await redis.set(key, 'locked', 'NX', 'EX', ttlSeconds);
  return result === 'OK';
}

async function releaseLock(key) {
  await redis.del(key).catch(() => {}); // ignore errors on release
}

// ── IDEMPOTENCY HELPERS ──────────────────────────────────────────
async function isEventProcessed(eventId) {
  if (!eventId) return false;
  const key = `webhook:processed:${eventId}`;
  const exists = await redis.get(key);
  return exists === '1';
}

async function markEventProcessed(eventId, ttlSeconds = 86400) {
  if (!eventId) return;
  await redis.set(`webhook:processed:${eventId}`, '1', 'EX', ttlSeconds);
}

// ── ORDER LOOKUP ──────────────────────────────────────────────────
async function findOrderByReference(orderReference) {
  if (!orderReference) return null;
  const ref = String(orderReference).trim();
  if (!ref) return null;

  const conditions = [{ nombaReference: ref }];
  // If it looks like a MongoDB ObjectId, also search by _id
  if (/^[a-f\d]{24}$/i.test(ref)) {
    conditions.push({ _id: ref });
  }
  return Order.findOne({ $or: conditions });
}

// ── NOMBA AMOUNT NORMALISER ──────────────────────────────────────
// Nomba may send amount as Naira string ("1000.50") OR Kobo integer (100050).
// This function auto-detects which one it is.
function normalizeNombaAmount(raw) {
  if (raw === undefined || raw === null) {
    return { valid: false, kobo: 0 };
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) return { valid: false, kobo: 0 };

  // Heuristic: if number > 1000, treat as Kobo (since ₦10 is minimum viable order)
  // Otherwise treat as Naira and convert to Kobo.
  if (num > 1000) {
    return { valid: true, kobo: Math.round(num) };
  } else {
    return { valid: true, kobo: Math.round(num * 100) };
  }
}

// ── WEBHOOK ENDPOINT ──────────────────────────────────────────────
router.post('/nomba', async (req, res) => {
  const rawBody = req.body; // must be a Buffer from express.raw()
  const signature = req.headers['x-nomba-signature'] || req.headers['x-signature'];

  // ── 1. Verify signature (cheap, no DB) ─────────────────────────
  if (!verifyNombaSignature(rawBody, signature)) {
    logger.error('Nomba webhook: signature verification FAILED', {
      ip: req.ip,
      hasSignatureHeader: !!signature,
    });
    return res.status(401).json({ received: false, error: 'invalid signature' });
  }

  // ── 2. Parse JSON payload ──────────────────────────────────────
  let payload;
  try {
    payload = Buffer.isBuffer(rawBody)
      ? JSON.parse(rawBody.toString('utf8'))
      : rawBody;
  } catch (err) {
    logger.error('Webhook: failed to parse JSON body', { error: err.message });
    return res.status(400).json({ received: false, error: 'invalid payload' });
  }

  const { type, data, eventId } = payload;
  const orderReference = data?.orderReference;

  if (!orderReference) {
    logger.warn('Webhook received without orderReference', { type, eventId });
    // Still return 200 to avoid Nomba retrying, but log the issue.
    return res.json({ received: true, warning: 'missing orderReference' });
  }

  // ── 3. Idempotency check (reject duplicates immediately) ──────
  if (eventId) {
    const alreadyProcessed = await isEventProcessed(eventId);
    if (alreadyProcessed) {
      logger.info(`Webhook ${eventId} already processed — ignoring duplicate`);
      return res.json({ received: true, status: 'duplicate' });
    }
  }

  // ── 4. Acquire distributed lock per order ──────────────────────
  const lockKey = `webhook:lock:${orderReference}`;
  const locked = await acquireLock(lockKey, 60); // 60 seconds max processing time
  if (!locked) {
    logger.warn(`Webhook: another instance is already processing order ${orderReference}`);
    return res.json({ received: true, status: 'already_processing' });
  }

  // ── 5. Acknowledge Nomba immediately (non-blocking) ────────────
  res.json({ received: true });

  // ── 6. Process asynchronously with lock held ───────────────────
  setImmediate(async () => {
    try {
      logger.info(`Webhook processing: ${type} | reference: ${orderReference} | event: ${eventId || 'N/A'}`);

      // ── 6a. Find the order ──────────────────────────────────────
      const order = await findOrderByReference(orderReference);
      if (!order) {
        logger.error(`Order not found for reference: ${orderReference}`);
        return;
      }

      // ── 6b. Handle event types ──────────────────────────────────
      switch (type) {
        // ── SUCCESS EVENTS ──────────────────────────────────────
        case 'checkout.success':
        case 'payment.successful': {
          // Extra safety: re-check status inside the lock
          if (order.paymentStatus === 'completed') {
            logger.info(`Order ${order.orderNumber} already completed — ignoring`);
            break;
          }

          // Normalise Nomba amount (auto-detects Kobo vs Naira)
          const normalized = normalizeNombaAmount(data?.amount);
          if (!normalized.valid) {
            logger.error(`Amount normalisation failed for ${order.orderNumber}`, {
              raw: data?.amount,
            });
            order.paymentStatus = 'payment_discrepancy';
            order.addStatus('payment_discrepancy', `Invalid amount format: ${data?.amount}`);
            await order.save();
            break;
          }

          const paidKobo = normalized.kobo;
          const paidCurrency = data?.currency || 'NGN';

          // Strict amount + currency check (±1 kobo tolerance for rounding)
          const amountOk = Math.abs(paidKobo - order.total) <= 1;
          const currencyOk = paidCurrency === 'NGN';

          if (!amountOk || !currencyOk) {
            logger.error(`Amount/currency mismatch for ${order.orderNumber}`, {
              expectedKobo: order.total,
              receivedKobo: paidKobo,
              currency: paidCurrency,
            });
            order.paymentStatus = 'payment_discrepancy';
            order.addStatus(
              'payment_discrepancy',
              `Amount mismatch: expected ${order.total}k, got ${paidKobo}k (${paidCurrency})`
            );
            await order.save();
            // TODO: Trigger admin alert (Slack / PagerDuty / email)
            break;
          }

          // ✅ All checks passed — process payment with transaction
          await processSuccessfulPayment(order, {
            ...data,
            _normalizedAmountKobo: paidKobo, // pass normalised value to avoid re-computation
          });
          break;
        }

        // ── FAILURE EVENTS ──────────────────────────────────────
        case 'checkout.failed':
        case 'payment.failed': {
          if (order.paymentStatus === 'pending') {
            order.paymentStatus = 'failed';
            order.addStatus('cancelled', `Payment failed: ${data?.failureReason || 'unknown'}`);
            await order.save();
            logger.info(`Payment failed for order ${order.orderNumber}`);
          } else {
            logger.info(`Order ${order.orderNumber} status is ${order.paymentStatus} — ignoring failure event`);
          }
          break;
        }

        // ── REFUND / REVERSAL EVENTS ────────────────────────────
        case 'refund.successful':
        case 'payment_reversal':
        case 'reversal.successful': {
          const originalTx = data?.originalTransactionId || data?.transactionId;
          if (!originalTx) {
            logger.error('Refund/reversal event missing original transaction ID', { type, data });
            break;
          }

          // Find the original order by its transaction ID
          const targetOrder = await Order.findOne({ transactionId: originalTx });
          if (!targetOrder) {
            logger.error(`Order not found for reversal: originalTx=${originalTx}`);
            break;
          }

          if (targetOrder.paymentStatus === 'refunded') {
            logger.info(`Order ${targetOrder.orderNumber} already refunded — ignoring duplicate`);
            break;
          }

          // ⭐ Use MongoDB transaction to roll back stock atomically ⭐
          const session = await mongoose.startSession();
          session.startTransaction();

          try {
            // Restore stock for all items (refund = return inventory)
            for (const item of targetOrder.items) {
              await Product.findByIdAndUpdate(
                item.product,
                {
                  $inc: {
                    stock: item.quantity,
                    totalSold: -item.quantity, // revert sales count
                  },
                },
                { session }
              );
            }

            // Update order status
            targetOrder.paymentStatus = 'refunded';
            targetOrder.addStatus(
              'refunded',
              `Refund processed: ${data?.amount ? '₦' + data.amount : 'full refund'}`
            );
            await targetOrder.save({ session });

            await session.commitTransaction();
            logger.info(`✅ Refund/reversal processed for order ${targetOrder.orderNumber}`);
          } catch (err) {
            await session.abortTransaction();
            logger.error(`Refund transaction failed for ${targetOrder.orderNumber}`, {
              error: err.message,
            });
            throw err; // re-throw so the outer catch logs it
          } finally {
            session.endSession();
          }
          break;
        }

        // ── UNHANDLED EVENTS ────────────────────────────────────
        default: {
          logger.info(`Unhandled webhook type: ${type}`, {
            reference: orderReference,
            eventId,
          });
          // Optionally store unknown events in a separate collection for inspection
          // await UnknownWebhook.create({ type, data, eventId, receivedAt: new Date() });
        }
      }

      // ── 7. Mark event as processed (idempotency) ──────────────
      if (eventId) {
        await markEventProcessed(eventId);
      }
    } catch (err) {
      // Sanitise error before logging (avoid leaking secrets)
      const sanitizedError = {
        message: err.message,
        code: err.code,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
      };
      logger.error('Webhook processing error:', sanitizedError);
    } finally {
      // ── 8. Always release the lock ──────────────────────────────
      await releaseLock(lockKey);
    }
  });
  
});
// routes/webhooks.js
router.post('/webhooks/brevo', express.json(), async (req, res) => {
  const { event, email, ['message-id']: messageId, tag, tags } = req.body;

  await EmailLog.create({
    event,          // 'delivered', 'hardBounce', 'blocked', etc.
    recipient: email,
    messageId,
    tags: tags || [],
    receivedAt: new Date(),
  });

  if (event === 'hardBounce' || event === 'blocked') {
    // flag the customer record — bad address, don't retry blindly
    await User.updateOne({ email }, { emailDeliverable: false });
  }

  res.sendStatus(200); // always 200 quickly — Brevo retries on non-2xx
});

module.exports = router;