'use strict';

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis'); // ← add this
const { getRedisClient } = require('../config/redis');
const logger = require('../utils/logger');

function createLimiter({
  windowMs,
  limit,
  message,
  skipSuccessfulRequests = false,
  keyGenerator,
}) {
  const options = {
    windowMs,
    limit,                          // renamed from max
    standardHeaders: 'draft-8',     // upgraded from true
    legacyHeaders: false,
    ipv6Subnet: 56,                 // new: prevent IPv6 bypass
    skipSuccessfulRequests,
    message: { success: false, error: message },
    handler: (req, res, _next, options) => {
      logger.warn(`Rate limit exceeded: ${req.ip} on ${req.path}`);
      res.status(429).json(options.message);
    },
  };

  if (keyGenerator) options.keyGenerator = keyGenerator;

  try {
    const redisClient = getRedisClient();
    if (redisClient?.status === 'ready') {
      options.store = new RedisStore({       // ← actually assign the store
        sendCommand: (...args) => redisClient.call(...args),
      });
    }
  } catch (err) {
    logger.warn('rate-limit-redis not available — using in-memory rate limiter');
  }

  return rateLimit(options);
}
// ── PRESET LIMITERS ───────────────────────────────────────────────

/** General API limiter */
const globalLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: parseInt(process.env.RATE_LIMIT_MAX) || 200,
  message: 'Too many requests. Please try again later.',
});

/** Strict limiter for auth endpoints */
const authLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  message: 'Too many auth attempts. Try again in 15 minutes.',
  skipSuccessfulRequests: true, // Only failed attempts count
});

/** Payment endpoint limiter */
const paymentLimiter = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  limit: 5,
  message: 'Too many payment requests. Please wait a moment.',
});

/** Review submission limiter */
const reviewLimiter = createLimiter({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  limit: 10,
  message: 'Review limit reached for today.',
  keyGenerator: (req) => `${req.ip}:${req.user?._id || 'anon'}`,
});

/** Webhook — very permissive, signature verification handles auth */
const webhookLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 100,
  message: 'Webhook rate limit exceeded.',
});

module.exports = { globalLimiter, authLimiter, paymentLimiter, reviewLimiter, webhookLimiter };
