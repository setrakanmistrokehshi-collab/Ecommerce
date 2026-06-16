'use strict';

const rateLimit       = require('express-rate-limit');
const { RedisStore }  = require('rate-limit-redis');
const { getRedisClient } = require('../config/redis');
const logger  = require('../utils/logger');

/**
 * FIX #1: renamed from `rateLimit` to `createLimiter`
 * so it no longer shadows the express-rate-limit import.
 */
function createLimiter({
  windowMs,
  limit,
  message,
  skipSuccessfulRequests = false,
  keyGenerator,
  handler,  // FIX #5: now destructured so callers can override
}) {
  const options = {
    windowMs,
    limit,
    standardHeaders:        'draft-8',
    legacyHeaders:          false,
    ipv6Subnet:             56,
    skipSuccessfulRequests,
    message: { success: false, error: message },
    handler: handler ?? ((req, res, _next, opts) => {
      logger.warn(`Rate limit exceeded: ${req.ip} on ${req.path}`);
      res.status(429).json(opts.message);
    }),
  };

  if (keyGenerator) options.keyGenerator = keyGenerator;

  try {
    const redisClient = getRedisClient();
    if (redisClient?.status === 'ready') {
      options.store = new RedisStore({
        sendCommand: (...args) => redisClient.call(...args),
      });
    }
  } catch (err) {
    logger.warn('rate-limit-redis not available — using in-memory rate limiter');
  }

  return rateLimit(options); // FIX #1: now correctly calls express-rate-limit
}

// ── PRESET LIMITERS ───────────────────────────────────────────────

/** General API limiter */
const globalLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit:    parseInt(process.env.RATE_LIMIT_MAX, 10) || 200, // FIX #6: radix added
  message:  'Too many requests. Please try again later.',
});

/** Strict limiter for auth endpoints */
const authLimiter = createLimiter({
  windowMs:               15 * 60 * 1000,
  limit:                  parseInt(process.env.AUTH_RATE_LIMIT_MAX, 10) || 10, // FIX #6
  message:                'Too many auth attempts. Try again in 15 minutes.',
  skipSuccessfulRequests: true,
});

/** Payment endpoint limiter */
const paymentLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit:    5,
  handler: (req, res) => {
    res.status(429).json({ success: false, error: 'Too many payment requests. Please wait a moment.' });
  },
});

/** Review submission limiter */
const reviewLimiter = createLimiter({
  windowMs:     24 * 60 * 60 * 1000,
  limit:        10,
  message:      'Review limit reached for today.',
  keyGenerator: (req) => `${req.ip}:${req.user?._id || 'anon'}`,
});

/** Webhook — permissive, signature verification handles auth */
const webhookLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit:    100,
  message:  'Webhook rate limit exceeded.',
});

/** Status / health-check endpoints */
const statusLimiter = createLimiter({  // FIX #2: was `rateLimiter` (ReferenceError)
  windowMs: 60 * 1000,
  limit:    30,                        // FIX #4: was `max` (ignored), now `limit`
  handler: (req, res) => {
    res.status(429).json({ success: false, error: 'Too many requests. Please wait a moment.' });
  },
});

module.exports = {
  globalLimiter,
  authLimiter,
  paymentLimiter,
  reviewLimiter,
  webhookLimiter,
  statusLimiter,
};