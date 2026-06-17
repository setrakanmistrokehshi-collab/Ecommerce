'use strict';

const { jwtVerify } = require('jose');        // FIX #1: destructure the actual function
const crypto  = require('crypto');
const User    = require('../models/User');
const { AppError }      = require('./errorHandler');
const { getRedisClient } = require('../config/redis');
const logger  = require('../utils/logger');

// FIX #2: encode secret once at module load — jose requires Uint8Array, not a plain string
const SECRET = new TextEncoder().encode(process.env.JWT_SECRET);

const BLOCKLIST_PREFIX = 'token:blocked:';

// ── TOKEN BLOCKLIST (Redis-backed) ────────────────────────────────

async function blockToken(token, expiresInSeconds) {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await redis.set(`${BLOCKLIST_PREFIX}${hash}`, '1', 'EX', expiresInSeconds + 60);
  } catch (err) {
    logger.warn('Could not block token in Redis:', err.message);
  }
}

async function isTokenBlocked(token) {
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    const hash    = crypto.createHash('sha256').update(token).digest('hex');
    const blocked = await redis.get(`${BLOCKLIST_PREFIX}${hash}`);
    return !!blocked;
  } catch {
    return false;
  }
}

// ── PROTECT MIDDLEWARE ────────────────────────────────────────────

async function protect(req, res, next) {
  try {
    // Extract token from Authorization header
    const raw = req.headers.authorization;
    if (!raw?.startsWith('Bearer ')) {
      return next(new AppError('You are not logged in. Please log in to continue.', 401));
    }
    const token = raw.split(' ')[1];

    // Check blocklist before verifying signature
    if (await isTokenBlocked(token)) {
      return next(new AppError('Token has been invalidated. Please log in again.', 401));
    }

    // FIX #1 + #2: correct jose verification
    let payload;
    try {
      const result = await jwtVerify(token, SECRET);
      payload = result.payload;
    } catch (err) {
      // FIX #3: jose uses err.code, not err.name
      if (err.code === 'ERR_JWT_EXPIRED') {
        return next(new AppError('Your session has expired. Please log in again.', 401));
      }
      return next(new AppError('Invalid token. Please log in again.', 401));
    }

    // FIX #4: support both `userId` and `id` in payload (defensive)
    const userId = payload.userId ?? payload.id ?? payload.sub;
    if (!userId) {
      return next(new AppError('Invalid token payload. Please log in again.', 401));
    }

    const user = await User.findById(userId).select('+tokenVersion');
    if (!user)           return next(new AppError('User no longer exists.', 401));
    if (!user.isActive)  return next(new AppError('Your account has been deactivated.', 403));

    // Token version check — invalidates all tokens on password change / logout-all
    if (typeof user.tokenVersion === 'number' && typeof payload.tv === 'number') {
      if (payload.tv !== user.tokenVersion) {
        return next(new AppError('Session invalidated. Please log in again.', 401));
      }
    }

    req.user  = user;
    req.token = token;
    next();
  } catch (err) {
    next(err);
  }
}

// ── OPTIONAL AUTH ─────────────────────────────────────────────────
// Populates req.user if a valid token is present — does not block if missing.

async function optionalAuth(req, res, next) {
  try {
    const raw = req.headers.authorization;
    if (!raw?.startsWith('Bearer ')) return next();

    const token = raw.split(' ')[1];
    if (await isTokenBlocked(token)) return next();

    // FIX #1 + #2: correct jose usage
    const { payload } = await jwtVerify(token, SECRET);
    const userId = payload.userId ?? payload.id ?? payload.sub;
    if (userId) {
      req.user = await User.findById(userId);
    }
  } catch {
    // Silently ignore — guest access continues
  }
  next();
}

// ── RESTRICT TO ROLES ─────────────────────────────────────────────

function restrictTo(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError('You do not have permission to perform this action.', 403));
    }
    next();
  };
}

// ── REQUIRE EMAIL VERIFIED ────────────────────────────────────────
// FIX: removed unnecessary async

function requireVerified(req, res, next) {
  if (!req.user?.isEmailVerified) {
    return next(new AppError('Please verify your email address to continue.', 403));
  }
  next();
}

module.exports = {
  protect,
  optionalAuth,
  restrictTo,
  requireVerified,
  blockToken,
  isTokenBlocked,
};