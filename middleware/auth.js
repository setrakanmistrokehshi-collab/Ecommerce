'use strict';

const jwt = require('jose');
const crypto = require('crypto');
const User = require('../models/User');
const { AppError } = require('./errorHandler');
const { getRedisClient } = require('../config/redis');
const logger = require('../utils/logger');

const BLOCKLIST_PREFIX = 'token:blocked:';

// ── TOKEN BLOCKLIST (Redis-backed) ────────────────────────────────

async function blockToken(token, expiresInSeconds) {
  const redis = getRedisClient();
  if (redis) {
    try {
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      await redis.set(`${BLOCKLIST_PREFIX}${hash}`, '1', 'EX', expiresInSeconds + 60);
    } catch (err) {
      logger.warn('Could not block token in Redis:', err.message);
    }
  }
}

async function isTokenBlocked(token) {
  const redis = getRedisClient();
  if (!redis) return false;
  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const blocked = await redis.get(`${BLOCKLIST_PREFIX}${hash}`);
    return !!blocked;
  } catch {
    return false;
  }
}

// ── PROTECT MIDDLEWARE ────────────────────────────────────────────

async function protect(req, res, next) {
  try {
    let token;
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return next(new AppError('You are not logged in. Please log in to continue.', 401));

    // Check blocklist before verifying
    if (await isTokenBlocked(token)) {
      return next(new AppError('Token has been invalidated. Please log in again.', 401));
    }

    let decoded;
    try {
      decoded = await jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') return next(new AppError('Your session has expired. Please log in again.', 401));
      return next(new AppError('Invalid token', 401));
    }

    const user = await User.findById(decoded.userId).select('+tokenVersion');
    if (!user) return next(new AppError('User no longer exists', 401));
    if (!user.isActive) return next(new AppError('Your account has been deactivated', 403));

    // Token version check — all tokens invalidated on password change/logout-all
    if (typeof user.tokenVersion === 'number' && typeof decoded.tv === 'number') {
      if (decoded.tv !== user.tokenVersion) {
        return next(new AppError('Session invalidated. Please log in again.', 401));
      }
    }

    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    next(err);
  }
}

// ── OPTIONAL AUTH ─────────────────────────────────────────────────

async function optionalAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token && !(await isTokenBlocked(token))) {
      const decoded = await jwt.verify(token, process.env.JWT_SECRET);
      req.user = await User.findById(decoded.userId);
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
      return next(new AppError('You do not have permission to perform this action', 403));
    }
    next();
  };
}

// ── REQUIRE EMAIL VERIFIED ────────────────────────────────────────

async function requireVerified(req, res, next) {
  if (!req.user.isEmailVerified) {
    return next(new AppError('Please verify your email address to continue.', 403));
  }
  next();
}

module.exports = { protect, optionalAuth, restrictTo, requireVerified, blockToken, isTokenBlocked };
