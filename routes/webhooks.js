'use strict';

const express = require('express');
const crypto = require('crypto');
const Order = require('../models/Order');
const { processSuccessfulPayment } = require('./payments');
const logger = require('../utils/logger');

const router = express.Router();

function verifyNombaSignature(rawBody, signature) {
  if (!process.env.NOMBA_WEBHOOK_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('NOMBA_WEBHOOK_SECRET not set in production — rejecting webhook');
      return false;
    }
    logger.warn('NOMBA_WEBHOOK_SECRET not set — allowing in development');
    return true;
  }
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha512', process.env.NOMBA_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

router.post('/nomba', async (req, res) => {
  // Respond 200 immediately — Nomba retries on non-2xx
  res.json({ received: true });

  setImmediate(async () => {
    try {
      const rawBody  = req.body;
      const signature = req.headers['x-nomba-signature'] || req.headers['x-signature'];

      if (!verifyNombaSignature(rawBody, signature)) {
        logger.error('Nomba webhook: signature verification FAILED', { ip: req.ip });
        return;
      }

      const payload = JSON.parse(rawBody.toString());
      const { type, data } = payload;

      logger.info(`Nomba webhook: ${type}`, { reference: data?.orderReference });

      switch (type) {
        case 'checkout.success':
        case 'payment.successful': {
          const order = await Order.findOne({
            $or: [
              ...((/^[a-f\d]{24}$/i.test(data?.orderReference)) ? [{ _id: data.orderReference }] : []),
              { nombaReference: data?.orderReference },
            ]
          });
          if (!order) {
            logger.error(`Webhook: order not found for reference ${data?.orderReference}`);
            return;
          }
          await processSuccessfulPayment(order, data);
          break;
        }

        case 'checkout.failed':
        case 'payment.failed': {
          const order = await Order.findOne({
            $or: [
              ...((/^[a-f\d]{24}$/i.test(data?.orderReference)) ? [{ _id: data.orderReference }] : []),
              { nombaReference: data?.orderReference },
            ]
          });
          if (order && order.paymentStatus === 'pending') {
            order.paymentStatus = 'failed';
            order.addStatus('cancelled', `Payment failed: ${data?.failureReason || 'unknown'}`);
            await order.save();
            logger.info(`Payment failed: ${order.orderNumber}`);
          }
          break;
        }

        case 'refund.successful': {
          const order = await Order.findOne({ transactionId: data?.originalTransactionId });
          if (order) {
            order.paymentStatus = 'refunded';
            order.addStatus('refunded', `Refund processed: ₦${data?.amount}`);
            await order.save();
            logger.info(`Refund processed: ${order.orderNumber}`);
          }
          break;
        }

        default:
          logger.info(`Unhandled webhook type: ${type}`);
      }
    } catch (err) {
      logger.error('Webhook processing error:', { message: err.message, stack: err.stack });
    }
  });
});

module.exports = router;
