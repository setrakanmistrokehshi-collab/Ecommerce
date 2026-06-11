'use strict';

const express = require('express');
const crypto = require('crypto');
const { SignJWT, jwtVerify } = require('jose');
const { TextEncoder } = require('util');
const { body, validationResult } = require('express-validator');

const User = require('../models/User');
const { sendEmail } = require('../utils/email');
const { AppError } = require('../middleware/errorHandler');
const { protect, blockToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// ── JOSE SECRETS ────────────────────────────────────────────────
const accessSecret = new TextEncoder().encode(process.env.JWT_SECRET);
const refreshSecret = new TextEncoder().encode(process.env.JWT_REFRESH_SECRET);

// ── TOKEN HELPERS ───────────────────────────────────────────────
async function signAccessToken(user) {
  return await new SignJWT({
    userId: String(user._id),
    tv: user.tokenVersion || 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_EXPIRES_IN || '5m')
    .sign(accessSecret);
}

async function signRefreshToken(user) {
  return await new SignJWT({
    userId: String(user._id),
    tv: user.tokenVersion || 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_REFRESH_EXPIRES_IN || '1d')
    .sign(refreshSecret);
}

// ── RESPONSE HELPER ─────────────────────────────────────────────
async function sendTokenResponse(user, res, statusCode = 200) {
  const accessToken = await signAccessToken(user);
  const refreshToken = await signRefreshToken(user);

  res.status(statusCode).json({
    success: true,
    accessToken,
    refreshToken,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
}

// ── VALIDATION ──────────────────────────────────────────────────
const registerRules = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 60 }),
  body('email').isEmail().normalizeEmail(),
  body('password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
  body('phone').optional().isMobilePhone('en-NG'),
];

const loginRules = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  next();
}

// ── REGISTER ─────────────────────────────────────────────────────
router.post('/register', registerRules, validate, async (req, res, next) => {
  try {
    const { name, email, password, phone } = req.body;

    const existing = await User.findOne({ email });
    if (existing) return next(new AppError('Email already exists', 409));

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(verificationToken).digest('hex');

    const user = await User.create({
      name,
      email,
      password,
      phone,
      emailVerificationToken: hashedToken,
      emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000,
    });

    const verifyUrl = `${process.env.BASE_URL}/api/v1/auth/verify-email/${verificationToken}`;

    await sendEmail({
      to: email,
      subject: 'Verify your email',
      template: 'welcome',
      data: { name, verifyUrl },
    });

    logger.info(`New user: ${email} [IP: ${req.ip}]`);

    return await sendTokenResponse(user, res, 201);
  } catch (err) {
    next(err);
  }
});

// ── LOGIN ───────────────────────────────────────────────────────
router.post('/login', loginRules, validate, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select(
      '+password +loginAttempts +lockUntil +tokenVersion'
    );

    if (!user) return next(new AppError('Invalid credentials', 401));
    if (user.isLocked) return next(new AppError('Account locked', 423));
    if (!user.isActive) return next(new AppError('Account disabled', 403));

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      return next(new AppError('Invalid credentials', 401));
    }

    await User.findByIdAndUpdate(user._id, {
      $set: { loginAttempts: 0, lastLogin: new Date(), lastLoginIp: req.ip },
      $unset: { lockUntil: 1 },
    });

    user.tokenVersion = user.tokenVersion || 0;

    logger.info(`Login: ${email} [IP: ${req.ip}]`);

    return await sendTokenResponse(user, res);
  } catch (err) {
    next(err);
  }
});

// ── REFRESH TOKEN ───────────────────────────────────────────────
router.post('/refresh-token', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return next(new AppError('Refresh token required', 401));

    let payload;
    try {
      const result = await jwtVerify(
        refreshToken,
        refreshSecret
      );
      payload = result.payload;
    } catch {
      return next(new AppError('Invalid refresh token', 401));
    }

    const user = await User.findById(payload.userId).select('+tokenVersion');
    if (!user || !user.isActive) return next(new AppError('User not found', 401));

    if (user.tokenVersion !== payload.tv) {
      return next(new AppError('Session expired', 401));
    }

    const accessToken = await signAccessToken(user);
    const newRefreshToken = await signRefreshToken(user);

    res.json({
      success: true,
      accessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// ── VERIFY EMAIL ────────────────────────────────────────────────
router.get('/verify-email/:token', async (req, res, next) => {
  try {
    const hashed = crypto.createHash('sha256').update(req.params.token).digest('hex');

    const user = await User.findOne({
      emailVerificationToken: hashed,
      emailVerificationExpires: { $gt: Date.now() },
    });

    if (!user) return next(new AppError('Invalid token', 400));

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;

    await user.save({ validateBeforeSave: false });

    res.redirect(`${process.env.BASE_URL}/?verified=true`);
  } catch (err) {
    next(err);
  }
});

// ── FORGOT PASSWORD ─────────────────────────────────────────────
router.post('/forgot-password', async (req, res, next) => {
  try {
    const user = await User.findOne({ email: req.body.email });

    if (!user) {
      return res.json({ success: true });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashed = crypto.createHash('sha256').update(resetToken).digest('hex');

    user.passwordResetToken = hashed;
    user.passwordResetExpires = Date.now() + 10 * 60 * 1000;

    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.BASE_URL}/reset-password?token=${resetToken}`;

    await sendEmail({
      to: user.email,
      subject: 'Password reset',
      template: 'passwordReset',
      data: { name: user.name, resetUrl },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── RESET PASSWORD ─────────────────────────────────────────────
router.post('/reset-password', async (req, res, next) => {
  try {
    const hashed = crypto.createHash('sha256').update(req.body.token).digest('hex');

    const user = await User.findOne({
      passwordResetToken: hashed,
      passwordResetExpires: { $gt: Date.now() },
    }).select('+tokenVersion');

    if (!user) return next(new AppError('Invalid token', 400));

    user.password = req.body.password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.loginAttempts = 0;
    user.lockUntil = undefined;

    await user.save();

    await sendEmail({
      to: user.email,
      subject: 'Password changed',
      template: 'passwordChanged',
      data: { name: user.name },
    });

    return await sendTokenResponse(user, res);
  } catch (err) {
    next(err);
  }
});

// ── ME ──────────────────────────────────────────────────────────
router.get('/me', protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  res.json({ success: true, user: user.toSafeObject() });
});

// ── LOGOUT ──────────────────────────────────────────────────────
router.post('/logout', protect, async (req, res, next) => {
  try {
    const { payload } = await jwtVerify(req.token, accessSecret);

    const ttl = payload.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) await blockToken(req.token, ttl);

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── LOGOUT ALL ───────────────────────────────────────────────────
router.post('/logout-all', protect, async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      $inc: { tokenVersion: 1 },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;