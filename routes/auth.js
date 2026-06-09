'use strict';

const express = require('express');
const crypto = require('crypto');
const jwt = require('jose');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { sendEmail } = require('../utils/email');
const { AppError } = require('../middleware/errorHandler');
const { protect, blockToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// ── TOKEN HELPERS ─────────────────────────────────────────────────

function signAccessToken(user) {
  return jwt.sign(
    { userId: user._id, tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '5m' }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    { userId: user._id, tv: user.tokenVersion || 0 },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '1d' }
  );
}

function sendTokenResponse(res, user, statusCode = 200) {
  const accessToken  = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  res.status(statusCode).json({
    success: true,
    accessToken,
    refreshToken,
    user: user.toSafeObject(),
  });
}

// ── VALIDATION RULES ──────────────────────────────────────────────
const registerRules = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 60 }),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain uppercase, lowercase, and a number'),
  body('phone').optional().isMobilePhone('en-NG').withMessage('Valid Nigerian phone required'),
];

const loginRules = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────
// POST /api/v1/auth/register
// ─────────────────────────────────────────────────────────────────
router.post('/register', registerRules, validate, async (req, res, next) => {
  try {
    const { name, email, password, phone } = req.body;

    const existing = await User.findOne({ email });
    if (existing) return next(new AppError('An account with this email already exists', 409));

    const verificationToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(verificationToken).digest('hex');

    const user = await User.create({
      name, email, password, phone,
      emailVerificationToken: hashedToken,
      emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000,
    });

    const verifyUrl = `${process.env.BASE_URL}/api/v1/auth/verify-email/${verificationToken}`;
    await sendEmail({ to: email, subject: 'Welcome to Winners Health — Verify Your Email', template: 'welcome', data: { name, verifyUrl } });

    logger.info(`New user registered: ${email} [IP: ${req.ip}]`);
    sendTokenResponse(res, user, 201);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/v1/auth/login
// ─────────────────────────────────────────────────────────────────
router.post('/login', loginRules, validate, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).select('+password +loginAttempts +lockUntil +tokenVersion');

    if (!user) return next(new AppError('Invalid email or password', 401));
    if (user.isLocked) return next(new AppError('Account temporarily locked due to too many failed login attempts. Try again in 2 hours.', 423));
    if (!user.isActive) return next(new AppError('Your account has been deactivated. Contact support.', 403));

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      return next(new AppError('Invalid email or password', 401));
    }

    await User.findByIdAndUpdate(user._id, {
      $set: { loginAttempts: 0, lastLogin: new Date(), lastLoginIp: req.ip },
      $unset: { lockUntil: 1 },
    });

    // Refresh tokenVersion field for signing
    user.tokenVersion = user.tokenVersion || 0;
    logger.info(`User logged in: ${email} [IP: ${req.ip}]`);
    sendTokenResponse(res, user);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/v1/auth/refresh-token
// ─────────────────────────────────────────────────────────────────
router.post('/refresh-token', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return next(new AppError('Refresh token required', 401));

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    } catch {
      return next(new AppError('Invalid or expired refresh token', 401));
    }

    const user = await User.findById(decoded.userId).select('+tokenVersion');
    if (!user || !user.isActive) return next(new AppError('Invalid token', 401));

    // Token version check
    if (typeof user.tokenVersion === 'number' && typeof decoded.tv === 'number') {
      if (decoded.tv !== user.tokenVersion) return next(new AppError('Session invalidated. Please log in again.', 401));
    }

    const newAccessToken  = signAccessToken(user);
    const newRefreshToken = signRefreshToken(user);

    res.json({ success: true, accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/v1/auth/verify-email/:token
// ─────────────────────────────────────────────────────────────────
router.get('/verify-email/:token', async (req, res, next) => {
  try {
    const hashedToken = crypto.createHash('sha256').update(req.params.token).digest('hex');
    const user = await User.findOne({
      emailVerificationToken: hashedToken,
      emailVerificationExpires: { $gt: Date.now() },
    });

    if (!user) return next(new AppError('Token is invalid or has expired', 400));

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save({ validateBeforeSave: false });

    logger.info(`Email verified: ${user.email}`);
    res.redirect(`${process.env.BASE_URL}/?verified=true`);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/v1/auth/forgot-password
// ─────────────────────────────────────────────────────────────────
router.post('/forgot-password', [body('email').isEmail().normalizeEmail()], validate, async (req, res, next) => {
  try {
    const user = await User.findOne({ email: req.body.email });
    // Always same response to prevent email enumeration
    if (!user) return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = Date.now() + 10 * 60 * 1000;
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.BASE_URL}/reset-password?token=${resetToken}`;
    await sendEmail({ to: user.email, subject: 'Winners Health Password Reset (expires in 10 minutes)', template: 'passwordReset', data: { name: user.name, resetUrl } });

    res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/v1/auth/reset-password
// ─────────────────────────────────────────────────────────────────
router.post('/reset-password', [
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
], validate, async (req, res, next) => {
  try {
    const hashedToken = crypto.createHash('sha256').update(req.body.token).digest('hex');
    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    }).select('+tokenVersion');

    if (!user) return next(new AppError('Token is invalid or has expired', 400));

    user.password = req.body.password; // pre-save hook increments tokenVersion
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.loginAttempts = 0;
    user.lockUntil = undefined;
    await user.save();

    await sendEmail({ to: user.email, subject: 'Winners Health — Your password has been changed', template: 'passwordChanged', data: { name: user.name } });

    logger.info(`Password reset for: ${user.email} [IP: ${req.ip}]`);
    sendTokenResponse(res, user);
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// GET /api/v1/auth/me
// ─────────────────────────────────────────────────────────────────
router.get('/me', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).populate('wishlist', 'name price emoji slug');
    res.json({ success: true, user: user.toSafeObject() });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/v1/auth/logout — invalidates current access token
// ─────────────────────────────────────────────────────────────────
router.post('/logout', protect, async (req, res, next) => {
  try {
    // Block the current access token until its natural expiry
    const decoded = jwt.decode(req.token);
    if (decoded?.exp) {
      const ttl = decoded.exp - Math.floor(Date.now() / 1000);
      if (ttl > 0) await blockToken(req.token, ttl);
    }
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────
// POST /api/v1/auth/logout-all — invalidates ALL sessions
// ─────────────────────────────────────────────────────────────────
router.post('/logout-all', protect, async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { $inc: { tokenVersion: 1 } });
    res.json({ success: true, message: 'All sessions invalidated successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
