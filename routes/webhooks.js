'use strict';

const express = require('express');
const crypto = require('crypto');
const Order = require('../models/Order');
const { processSuccessfulPayment } = require('./payments');
const logger = require('../utils/logger');

const router = express.Router();

// ── SIGNATURE VERIFICATION ────────────────────────────────────────
// Fails closed in ALL environments by default. The only way to skip
// verification is to explicitly set ALLOW_UNSIGNED_WEBHOOKS=true AND
// have NODE_ENV !== 'production'. Two separate switches means a
// missing/forgotten NODE_ENV can never silently disable verification.
const DEV_BYPASS_ENABLED =
  process.env.ALLOW_UNSIGNED_WEBHOOKS === 'true' && process.env.NODE_ENV !== 'production';

function verifyNombaSignature(rawBody, signature) {
  if (!process.env.NOMBA_WEBHOOK_SECRET) {
    if (DEV_BYPASS_ENABLED) {
      logger.warn('NOMBA_WEBHOOK_SECRET not set — ALLOW_UNSIGNED_WEBHOOKS=true (dev), accepting unsigned webhook');
      return true;
    }
    logger.error('NOMBA_WEBHOOK_SECRET not set — rejecting webhook');
    return false;
  }

  if (!signature || typeof signature !== 'string') return false;

  if (!Buffer.isBuffer(rawBody)) {
    logger.error(
      'Webhook raw body is not a Buffer — ensure express.raw({ type: "application/json" }) is mounted on this route BEFORE any global express.json() middleware'
    );
    return false;
  }

  const expected = crypto
    .createHmac('sha512', process.env.NOMBA_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  // Validate shape before timingSafeEqual (it throws on length mismatch
  // and on invalid hex Buffer.from() just truncates silently).
  if (!/^[a-f0-9]+$/i.test(signature) || signature.length !== expected.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

// ── ORDER LOOKUP HELPER ───────────────────────────────────────────
async function findOrderByReference(orderReference) {
  if (!orderReference) return null;
  return Order.findOne({
    $or: [
      ...((/^[a-f\d]{24}$/i.test(String(orderReference))) ? [{ _id: orderReference }] : []),
      { nombaReference: orderReference },
    ],
  });
}

// ── WEBHOOK ENDPOINT ───────────────────────────────────────────────
router.post('/nomba', async (req, res) => {
  const rawBody = req.body; // expects a Buffer from express.raw()
  const signature = req.headers['x-nomba-signature'] || req.headers['x-signature'];

  // Verify BEFORE acknowledging. HMAC is cheap and doesn't touch the
  // DB, so this doesn't meaningfully delay the response — and it
  // means we never ack a payload we couldn't authenticate.
  if (!verifyNombaSignature(rawBody, signature)) {
    logger.error('Nomba webhook: signature verification FAILED', {
      ip: req.ip,
      hasSignatureHeader: !!signature,
    });
    return res.status(401).json({ received: false, error: 'invalid signature' });
  }

  let payload;
  try {
    payload = Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString('utf8')) : rawBody;
  } catch (err) {
    logger.error('Nomba webhook: failed to parse JSON body', { message: err.message });
    return res.status(400).json({ received: false, error: 'invalid payload' });
  }

  // Acknowledge receipt now — Nomba retries on non-2xx, and the DB
  // work below shouldn't block that ack.
  res.json({ received: true });

  const { type, data } = payload;
  const orderReference = data?.orderReference;

  setImmediate(async () => {
    try {
      logger.info(`Nomba webhook: ${type}, { reference: orderReference }`);

      switch (type) {
        case 'checkout.success':
        case 'payment.successful': {
          const order = await findOrderByReference(orderReference);
          if (!order) {
            logger.error(`Webhook: order not found for reference ${orderReference}`, { type });
            return;
          }

          if (order.paymentStatus === 'completed') {
            logger.info(`Webhook: order ${order.orderNumber} already completed — ignoring duplicate`);
            return;
          }

          // Cross-check what Nomba says was paid against what we asked
          // for. NOTE: confirm the units Nomba sends in data.amount
          // (Naira vs kobo) match how order.total is stored.
          const paidAmount = Number(data?.amount);
          const paidCurrency = data?.currency;
          const amountOk = Number.isFinite(paidAmount) && paidAmount === order.total;
          const currencyOk = !paidCurrency || paidCurrency === 'NGN';

          if (!amountOk || !currencyOk) {
            logger.error(`Webhook: amount/currency mismatch for order ${order.orderNumber} — holding for manual review`, {
              expected: { total: order.total, currency: 'NGN' },
              received: { amount: data?.amount, currency: data?.currency },
            });
            // TODO: trigger an admin alert (email/Slack) here so a
            // mismatched payment doesn't just sit silently as 'pending'.
            return;
          }

          await processSuccessfulPayment(order, data);
          break;
        }

        case 'checkout.failed':
        case 'payment.failed': {
          const order = await findOrderByReference(orderReference);
          if (order && order.paymentStatus === 'pending') {
            order.paymentStatus = 'failed';
            order.addStatus('cancelled', `Payment failed: ${data?.failureReason || 'unknown'}`);
            await order.save();
            logger.info(`Payment failed: ${order.orderNumber}`);
          }
          break;
        }

        case 'refund.successful': {
          const originalTransactionId = data?.originalTransactionId;
          if (!originalTransactionId) {
            logger.error('Webhook: refund.successful missing originalTransactionId', { payload: data });
            return;
          }

          const order = await Order.findOne({ transactionId: originalTransactionId });
          if (!order) {
            logger.error(`Webhook: order not found for refund, transactionId ${originalTransactionId}`);
            return;
          }

          if (order.paymentStatus === 'refunded') {
            logger.info(`Webhook: order ${order.orderNumber} already refunded — ignoring duplicate`);
            return;
          }

          order.paymentStatus = 'refunded';
          order.addStatus('refunded', `Refund processed: ₦${data?.amount}`);
          await order.save();
          logger.info(`Refund processed: ${order.orderNumber}`);
          break;
        }

        default:
          logger.info(`Unhandled webhook type: ${type}`, { reference: orderReference });
      }
    } catch (err) {
      logger.error('Webhook processing error:', {
        type,
        reference: orderReference,
        message: err.message,
        stack: err.stack,
      });
    }
  });
});

module.exports = router;