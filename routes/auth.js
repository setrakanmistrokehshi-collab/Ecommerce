'use strict';

const express  = require('express');
const crypto   = require('crypto');
const { SignJWT, jwtVerify } = require('jose');
const { body, validationResult } = require('express-validator');


const User        = require('../models/User');
const { sendEmail }  = require('../utils/email');
const { AppError }   = require('../middleware/errorHandler');
const { protect, blockToken } = require('../middleware/auth');
const logger      = require('../utils/logger');
const { STAFF_ROLES } = require('../config/permission');
const { adminLoginLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// ── JOSE SECRETS ─────────────────────────────────────────────────
// TextEncoder is global in Node 18+ — no need to import from 'util'
const accessSecret  = new TextEncoder().encode(process.env.JWT_SECRET);
const refreshSecret = new TextEncoder().encode(process.env.JWT_REFRESH_SECRET);

// ── TOKEN HELPERS ─────────────────────────────────────────────────

async function signAccessToken(user, accessSecret) {

  const permissions = typeof user.getEffectivePermissions === 'function'
    ? user.getEffectivePermissions()
    : [];
  return new SignJWT({
    userId: String(user._id),
    role:   user.role, 
     permissions,         
    tv:     user.tokenVersion || 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_EXPIRES_IN ?? '15m') // FIX #3: safe fallback
    .sign(accessSecret);
}

async function signRefreshToken(user) {
  return new SignJWT({
    userId: String(user._id),
    tv:     user.tokenVersion || 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_REFRESH_EXPIRES_IN ?? '7d') // FIX #3: safe fallback
    .sign(refreshSecret);
}

// ── RESPONSE HELPER ───────────────────────────────────────────────

async function sendTokenResponse(user, res, statusCode = 200) {
  const accessToken  = await signAccessToken(user, accessSecret);
  const refreshToken = await signRefreshToken(user);


  const permissions = typeof user.getEffectivePermissions === 'function'
    ? user.getEffectivePermissions()
    : [];

  res.status(statusCode).json({
    success: true,
    accessToken,
    refreshToken,
    user: {
      id:    user._id,
      name:  user.name,
      email: user.email,
      role:  user.role,
       permissions,  
    },
  });
}

// ── VALIDATION ────────────────────────────────────────────────────

const registerRules = [
  body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 60 }),
  body('email').isEmail().normalizeEmail(),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain uppercase, lowercase, and a number'),
  body('phone').optional().isMobilePhone('en-NG'),
];

const loginRules = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
];

const resetPasswordRules = [
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain uppercase, lowercase, and a number'),
  body('token').notEmpty().withMessage('Reset token is required'),
];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  next();
}

// ── REGISTER ──────────────────────────────────────────────────────

router.post('/register', registerRules, validate, async (req, res, next) => {
  try {
    const { name, email, password, phone } = req.body;

    const existing = await User.findOne({ email });
    if (existing) return next(new AppError('Email already in use', 409));

    const verificationToken = crypto.randomBytes(64).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(verificationToken).digest('hex');

    const user = await User.create({
      name,
      email,
      password,
      phone,
      emailVerificationToken:   hashedToken,
      emailVerificationExpires: Date.now() + 24 * 60 * 60 * 1000,
    });

    const verifyUrl = `${process.env.BASE_URL}/api/v1/auth/verify-email/${verificationToken}`;

    await sendEmail({
      to:       email,
      subject:  'Verify your email ',
      template: 'welcome',
      data:     { name, verifyUrl },
    });

    logger.info(`New user registered: ${email} [IP: ${req.ip}]`);
    return sendTokenResponse(user, res, 201);
  } catch (err) {
    next(err);
  }
});

// ── LOGIN ─────────────────────────────────────────────────────────

router.post('/login', loginRules, validate, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select(
      '+password +loginAttempts +lockUntil +tokenVersion +role +permissions'
    );

    if (!user) return next(new AppError('Invalid credentials', 401));

    // 🔒 LOCK CHECK
    if (user.lockUntil && user.lockUntil > Date.now()) {
      return next(new AppError('Account temporarily locked. Try again later.', 423));
    }
const isAdminLogin = user.role === 'admin';

if (isAdminLogin) {
  const ADMIN_MAX_ATTEMPTS = 3;

  if (user.loginAttempts >= ADMIN_MAX_ATTEMPTS) {
    return next(new AppError('Admin account locked due to suspicious activity', 423));
  }
}

    if (!user.isActive) {
      return next(new AppError('Account has been disabled', 403));
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      return next(new AppError('Invalid credentials', 401));
    }

    // reset login attempts
    await User.findByIdAndUpdate(user._id, {
      $set: { loginAttempts: 0, lastLogin: new Date(), lastLoginIp: req.ip },
      $unset: { lockUntil: 1 }
    });

    logger.info(`Login: ${email} [IP: ${req.ip}]`);
    

    return sendTokenResponse(user, res, 200);
  } catch (err) {
    next(err);
  }
});


/**
 * POST /api/v1/auth/admin-login
 *
 * Dedicated login endpoint for the admin dashboard.
 * Same credential check as /login, but:
 *   - Stricter rate limit (5 attempts / 15 min vs 10 for regular login)
 *   - Hard-blocks any account that isn't a staff role, even with correct password
 *   - Logs every attempt (success and rejected-non-staff) for security monitoring
 */
router.post('/admin-login', adminLoginLimiter, loginRules, validate, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select(
      '+password +loginAttempts +lockUntil +tokenVersion'
    );

    if (!user) return next(new AppError('Invalid credentials', 401));
    if (user.isLocked)  return next(new AppError('Account temporarily locked. Try again later.', 423));
    if (!user.isActive) return next(new AppError('Account has been disabled. Contact support.', 403));

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      logger.warn(`Failed admin login attempt: ${email} [IP: ${req.ip}]`);
      return next(new AppError('Invalid credentials', 401));
    }

    // ── ADMIN-ONLY GATE ──────────────────────────────────────────
    // Block regular customers from this endpoint entirely — even with
    // the correct password, a non-staff account cannot get a token here.
    if (!STAFF_ROLES.includes(user.role)) {
      logger.warn(`Non-staff login attempt on admin portal: ${email} [role: ${user.role}] [IP: ${req.ip}]`);
      return next(new AppError('This account does not have admin access', 403));
    }

    await User.findByIdAndUpdate(user._id, {
      $set:   { loginAttempts: 0, lastLogin: new Date(), lastLoginIp: req.ip },
      $unset: { lockUntil: 1 },
    });

    user.tokenVersion = user.tokenVersion || 0;

    logger.info(`Admin login: ${email} [role: ${user.role}] [IP: ${req.ip}]`);
    return sendTokenResponse(user, res, 200);
  } catch (err) {
    next(err);
  }
});


// ── REFRESH TOKEN ─────────────────────────────────────────────────

router.post('/refresh-token', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return next(new AppError('Refresh token required', 401));

    let payload;
    try {
      const result = await jwtVerify(refreshToken, refreshSecret);
      payload = result.payload;
    } catch {
      return next(new AppError('Invalid or expired refresh token', 401));
    }

    const user = await User.findById(payload.userId).select('+tokenVersion');
    if (!user || !user.isActive) return next(new AppError('User not found', 401));

    if (user.tokenVersion !== payload.tv) {
      return next(new AppError('Session expired. Please log in again.', 401));
    }

    const accessToken    = await signAccessToken(user);
    const newRefreshToken = await signRefreshToken(user);

    res.json({ success: true, accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    next(err);
  }
});

// ── VERIFY EMAIL ──────────────────────────────────────────────────

router.get('/verify-email/:token', async (req, res, next) => {
  try {
    const hashed = crypto.createHash('sha256').update(req.params.token).digest('hex');

    const user = await User.findOne({
      emailVerificationToken:   hashed,
      emailVerificationExpires: { $gt: Date.now() },
    });

    if (!user) return next(new AppError('Verification link is invalid or has expired', 400));

    user.isEmailVerified          = true;
    user.emailVerificationToken   = undefined;
    user.emailVerificationExpires = undefined;
    await user.save({ validateBeforeSave: false });

    res.redirect(`${process.env.BASE_URL}/?verified=true`);
  } catch (err) {
    next(err);
  }
});

// ── FORGOT PASSWORD ───────────────────────────────────────────────

router.post('/forgot-password', async (req, res, next) => {
  try {
    const user = await User.findOne({ email: req.body.email });

    // Always return success — prevents email enumeration
    if (!user) return res.json({ success: true });

    const resetToken = crypto.randomBytes(64).toString('hex');
    const hashed     = crypto.createHash('sha256').update(resetToken).digest('hex');

    user.passwordResetToken   = hashed;
    user.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.BASE_URL}/reset-password?token=${resetToken}`;

    await sendEmail({
      to:       user.email,
      subject:  'Reset your  password',
      template: 'passwordReset',
      data:     { name: user.name, resetUrl },
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── RESET PASSWORD ────────────────────────────────────────────────

router.post('/reset-password', resetPasswordRules, validate, async (req, res, next) => {
  try {
    const hashed = crypto.createHash('sha256').update(req.body.token).digest('hex');

    const user = await User.findOne({
      passwordResetToken:   hashed,
      passwordResetExpires: { $gt: Date.now() },
    }).select('+tokenVersion');

    if (!user) return next(new AppError('Reset link is invalid or has expired', 400));

    user.password             = req.body.password;
    user.passwordResetToken   = undefined;
    user.passwordResetExpires = undefined;
    user.loginAttempts        = 0;
    user.lockUntil            = Date.now() - 1; // unlock if it was locked

    // FIX #2: increment tokenVersion to invalidate ALL existing tokens
    user.tokenVersion = (user.tokenVersion || 0) + 1;

    await user.save();

    await sendEmail({
      to:       user.email,
      subject:  'Your winners health password was changed',
      template: 'passwordChanged',
      data:     { name: user.name },
    });

    return sendTokenResponse(user, res);
  } catch (err) {
    next(err);
  }
});

// ── ME ────────────────────────────────────────────────────────────

router.get('/me', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return next(new AppError('User not found', 404));

    // Use toSafeObject() if it exists on the model, otherwise fall back
    const data = typeof user.toSafeObject === 'function'
      ? user.toSafeObject()
      : { id: user._id, name: user.name, email: user.email, role: user.role };

    res.json({ success: true, user: data });
  } catch (err) {
    next(err);
  }
});

// ── LOGOUT ────────────────────────────────────────────────────────

router.post('/logout', protect, async (req, res, next) => {
  try {
    const { payload } = await jwtVerify(req.token, accessSecret);
    const ttl = payload.exp - Math.floor(Date.now() / 1000);
    if (ttl > 0) await blockToken(req.token, ttl);

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

// ── LOGOUT ALL DEVICES ────────────────────────────────────────────

router.post('/logout-all', protect, async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, {
      $inc: { tokenVersion: 1 },
    });
    res.json({ success: true, message: 'Logged out from all devices' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;