'use strict';

const express  = require('express');
const crypto   = require('crypto');
const argon2 = require('argon2');
const useragent = require('express-useragent'); 
const { SignJWT, jwtVerify } = require('jose');
const { body, validationResult } = require('express-validator');

const User        = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const { sendEmail }  = require('../utils/email');
const { AppError }   = require('../middleware/errorHandler');
const { protect, blockToken, restrictTo } = require('../middleware/auth');
const logger = require('../utils/logger');
const { STAFF_ROLES } = require('../config/permission');
const { adminLoginLimiter, googleAuthLimiter } = require('../middleware/rateLimiter');
const { sendLoginAlert } = require('../utils/email');
const { verifyPassword } = require('../utils/password');
const { verifyGoogleCredential } = require('../config/googleClient'); // NEW

const router = express.Router();

// ── JOSE SECRETS ─────────────────────────────────────────────────
const accessSecret  = new TextEncoder().encode(process.env.JWT_SECRET);
const refreshSecret = new TextEncoder().encode(process.env.JWT_REFRESH_SECRET);

// ── HELPERS ───────────────────────────────────────────────────────
function createDeviceFingerprint(req) {
  const data = [
    req.headers['user-agent'],
    req.headers['accept-language'],
    req.ip || req.connection.remoteAddress,
  ].join('|');
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ── TOKEN HELPERS ─────────────────────────────────────────────────
async function signAccessToken(user) {
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
    .setExpirationTime(process.env.JWT_EXPIRES_IN ?? '10m')
    .sign(accessSecret);
}

async function signRefreshToken(user, req, rotate = false) {
  let tokenVersion = user.tokenVersion || 0;
  const tokenId = crypto.randomBytes(64).toString('hex');
  
  if (rotate) {
    tokenVersion = (tokenVersion || 0) + 1;
    await User.findByIdAndUpdate(user._id, { 
      $inc: { tokenVersion: 1 } 
    });
  }
  
  const token = await new SignJWT({
    jti: tokenId,
    userId: String(user._id),
    tv: tokenVersion,
    deviceId: createDeviceFingerprint(req),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_REFRESH_EXPIRES_IN ?? '24h')
    .sign(refreshSecret);
  
  if (process.env.ENABLE_REFRESH_TOKEN_DB === 'true') {
    await RefreshToken.create({
      tokenId,
      userId: user._id,
      tokenVersion,
      token,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      deviceInfo: req.headers['user-agent'],
      ipAddress: req.ip,
    });
  }
  
  return token;
}

async function sendTokenResponse(user, req, res, statusCode = 200) {
  const accessToken = await signAccessToken(user, accessSecret);
  const refreshToken = await signRefreshToken(user, req, false);

  const permissions = typeof user.getEffectivePermissions === 'function'
    ? user.getEffectivePermissions()
    : [];

  res.status(statusCode).json({
    success: true,
    accessToken,
    refreshToken,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      permissions,
    },
  });
}

// ── REFRESH TOKEN ENDPOINT ──────────────────────────────────────
async function refreshAccessToken(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return next(new AppError('Refresh token required', 400));
    }

    let payload;
    try {
      const result = await jwtVerify(refreshToken, refreshSecret);
      payload = result.payload;
    } catch (err) {
      if (err.code === 'ERR_JWT_EXPIRED') {
        return next(new AppError('Refresh token expired', 401));
      }
      return next(new AppError('Invalid refresh token', 401));
    }

    const user = await User.findById(payload.userId).select('+tokenVersion');
    if (!user || !user.isActive) {
      return next(new AppError('User not found or inactive', 401));
    }

    if (payload.tv !== user.tokenVersion) {
      await User.findByIdAndUpdate(user._id, { 
        $inc: { tokenVersion: 1 }
      });
      return next(new AppError('Token revoked - please login again', 401));
    }

    const newAccessToken = await signAccessToken(user, accessSecret);
    const newRefreshToken = await signRefreshToken(user, req, true);

    res.json({
      success: true,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });

  } catch (err) {
    next(err);
  }
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

const googleAuthRules = [
  body('credential').notEmpty().withMessage('Google credential is required'),
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
      subject:  'Verify your email',
      template: 'welcome',
      data:     { name, verifyUrl },
    });

    logger.info(`New user registered: ${email} [IP: ${req.ip}]`);
    return sendTokenResponse(user, req, res, 201);
  } catch (err) {
    next(err);
  }
});

// ── LOGIN ─────────────────────────────────────────────────────────
router.post('/login', useragent.express(), loginRules, validate, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select(
      '+password +loginAttempts +lockUntil +tokenVersion +role +permissions'
    );

    if (!user) return next(new AppError('Invalid credentials', 401));
     if (!user.password) {
      return next(new AppError('Invalid credentials', 401));
    }
 

    // Check if account is locked
    if (user.lockUntil && user.lockUntil > Date.now()) {
      return next(new AppError('Account temporarily locked. Try again later.', 423));
    }

    // Admin-specific checks
    const isAdminLogin = user.role === 'super_admin';
    if (isAdminLogin) {
      const ADMIN_MAX_ATTEMPTS = 3;
      if (user.loginAttempts >= ADMIN_MAX_ATTEMPTS) {
        return next(new AppError('Admin account locked due to suspicious activity', 423));
      }
    }

    if (!user.isActive) {
      return next(new AppError('Account has been disabled', 403));
    }

    // ✅ Verify password FIRST
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      return next(new AppError('Invalid credentials', 401));
    }

    // ✅ ONLY AFTER successful login - update user
    await User.findByIdAndUpdate(user._id, {
      $set: { loginAttempts: 0, lastLogin: new Date(), lastLoginIp: req.ip },
      $unset: { lockUntil: { $gte: Date.now() + 10 * 60 * 1000 } }
    });

    // ✅ Send login alert email (only for successful logins)
    try {
      const ua = req.useragent;
      
      await sendLoginAlert(
        user.email,
        user.name,
        {
          browser: ua?.browser || 'Unknown Browser',
          os: ua?.os || 'Unknown OS',
          device: ua?.platform || 'Unknown Device',
          ip: req.ip || req.connection.remoteAddress,
          location: req.geolocation?.city || 'Unknown Location',
          time: new Date().toLocaleString(),
        }
      );
      logger.info(`📧 Login alert sent to ${user.email}`);
    } catch (emailErr) {
      // Don't block login if email fails
      logger.warn('⚠️ Login alert email failed:', emailErr.message);
    }

    logger.info(`✅ Login successful: ${email} [IP: ${req.ip}]`);
    return sendTokenResponse(user, req, res, 200);
    
  } catch (err) {
    next(err);
  }
});

// ── GOOGLE LOGIN (Google Identity Services) ───────────────────────

router.post('/google', useragent.express(), googleAuthLimiter, googleAuthRules, validate, async (req, res, next) => {
  try {
    const { credential } = req.body;

    let payload;
    try {
      payload = await verifyGoogleCredential(credential);
    } catch (err) {
      logger.warn(`Google credential verification failed [IP: ${req.ip}]: ${err.message}`);
      return next(new AppError('Google sign-in failed. Please try again.', 401));
    }

    const { sub: googleId, email, name, picture } = payload;

    let user = await User.findOne({ email }).select(
      '+tokenVersion +role +permissions'
    );

    if (!user) {
      user = await User.create({
        name,
        email,
        googleId,
        authProvider: 'google',
        avatar: picture,
        isEmailVerified: true, 
        isActive: true,
      
      });
      logger.info(`New user via Google: ${email} [IP: ${req.ip}]`);
    } else {
      if (!user.isActive) {
        return next(new AppError('Account has been disabled', 403));
      }
      if (user.lockUntil && user.lockUntil > Date.now()) {
        return next(new AppError('Account temporarily locked. Try again later.', 423));
      }
      if (!user.googleId) {
        // Existing password account linking Google for the first time
        user.googleId = googleId;
        if (!user.isEmailVerified) user.isEmailVerified = true;
        await user.save({ validateBeforeSave: false });
      }
    }

    await User.findByIdAndUpdate(user._id, {
      $set: { lastLogin: new Date(), lastLoginIp: req.ip },
      $unset: { lockUntil: { $gte: Date.now() + 10 * 60 * 1000 }, loginAttempts: 3 },
    });

    // Same best-effort login alert as /login — don't block on failure
    try {
      const ua = req.useragent;
      await sendLoginAlert(user.email, user.name, {
        browser: ua?.browser || 'Unknown Browser',
        os: ua?.os || 'Unknown OS',
        device: ua?.platform || 'Unknown Device',
        ip: req.ip || req.connection.remoteAddress,
        location: req.geolocation?.city || 'Unknown Location',
        time: new Date().toLocaleString(),
      });
    } catch (emailErr) {
      logger.warn('⚠️ Login alert email failed:', emailErr.message);
    }

    logger.info(`✅ Google login successful: ${email} [IP: ${req.ip}]`);
    return sendTokenResponse(user, req, res, 200);
  } catch (err) {
    next(err);
  }
});

// ── ADMIN LOGIN ─────────────────────────────────────────────────
router.post('/admin-login', useragent.express(), adminLoginLimiter, loginRules, validate, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select(
      '+password +loginAttempts +lockUntil +tokenVersion +extraPermissions +revokedPermissions'
    );

    if (!user) return next(new AppError('Invalid credentials', 401));
     if (!user.password) {
      return next(new AppError('Invalid credentials', 401));
    }
 
    if (user.isLocked) return next(new AppError('Account temporarily locked. Try again later.', 423));
    if (!user.isActive) return next(new AppError('Account has been disabled. Contact support.', 403));

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      await user.incLoginAttempts();
      logger.warn(`Failed admin login attempt: ${email} [IP: ${req.ip}]`);
      return next(new AppError('Invalid credentials', 401));
    }

    if (!STAFF_ROLES.includes(user.role)) {
      logger.warn(`Non-staff login attempt on admin portal: ${email} [role: ${user.role}] [IP: ${req.ip}]`);
      return next(new AppError('This account does not have admin access', 403));
    }

    await User.findByIdAndUpdate(user._id, {
      $set: { loginAttempts: 0, lastLogin: new Date(), lastLoginIp: req.ip },
      $unset: { lockUntil: { $gte: Date.now() + 10 * 60 * 1000 } },
    });

    user.tokenVersion = user.tokenVersion || 0;
    logger.info(`Admin-login: ${email} [role: ${user.role}] [IP: ${req.ip}]`);
    return sendTokenResponse(user, req, res, 200);
  } catch (err) {
    next(err);
  }
});

// ── REFRESH TOKEN ─────────────────────────────────────────────────
router.post('/refresh-token', refreshAccessToken);

// ── VERIFY EMAIL ──────────────────────────────────────────────────
router.get('/verify-email/:token', async (req, res, next) => {
  try {
    const hashed = crypto.createHash('sha256').update(req.params.token).digest('hex');

    const user = await User.findOne({
      emailVerificationToken: hashed,
      emailVerificationExpires: { $gt: Date.now() },
    });

    if (!user) return next(new AppError('Verification link is invalid or has expired', 400));

    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
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

    if (!user) return res.json({ success: true });

    const resetToken = crypto.randomBytes(64).toString('hex');
    const hashed = crypto.createHash('sha256').update(resetToken).digest('hex');

    user.passwordResetToken = hashed;
    user.passwordResetExpires = Date.now() + 10 * 60 * 1000;
    await user.save({ validateBeforeSave: false });

    const resetUrl = `${process.env.BASE_URL}/reset-password?token=${resetToken}`;

    await sendEmail({
      to: user.email,
      subject: 'Reset your password',
      template: 'passwordReset',
      data: { name: user.name, resetUrl },
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
    }).select('+tokenVersion +password');

    if (!user) {
      return next(new AppError('Reset link is invalid or has expired', 400));
    }

   const isSamePassword = await argon2.verify(user.password, req.body.password);
    if (isSamePassword) {
      return next(new AppError('New password must be different from your current password', 400));
    }

    user.password             = req.body.password;
    user.passwordResetToken   = undefined;
    user.passwordResetExpires = undefined;
    user.loginAttempts        = 0;
    user.lockUntil            = undefined;
    user.tokenVersion         = (user.tokenVersion || 0) + 1;

    await user.save();

    sendEmail({
      to:       user.email,
      subject:  'Your password was changed',
      template: 'passwordChanged',
      data:     { name: user.name },
    }).catch(err => console.error('[password-reset] confirmation email failed:', err));

    return sendTokenResponse(user, req, res, 200);
  } catch (err) {
    next(err);
  }
});

// ── CHANGE PASSWORD (Admin) ──────────────────────────────────────
router.put('/admin/settings/password', 
  protect, 
   restrictTo('super_admin', 'product_manager', 'order_manager', 'support_agent'),
  async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        return next(new AppError('Current password and new password are required', 400));
      }
      
      if (newPassword.length < 8) {
        return next(new AppError('New password must be at least 8 characters', 400));
      }
      
      const user = await User.findById(req.user._id).select('+password +tokenVersion');
      
      if (!user) {
        return next(new AppError('User not found', 404));
      }
      
      const isMatch = await user.comparePassword(currentPassword);
      if (!isMatch) {
        return next(new AppError('Current password is incorrect', 401));
      }
      const { valid: isSamePassword } = await verifyPassword(user.password, req.body.password);
      if (isSamePassword) {
        return next(new AppError('New password must be different from your current password', 400));
      }
      
      user.password = newPassword;
      user.tokenVersion = (user.tokenVersion || 0) + 1;
      await user.save();
      
      sendEmail({
        to: user.email,
        subject: 'Your admin password was changed',
        template: 'passwordChanged',
        data: { name: user.name },
      }).catch(err => console.error('[password-change] email failed:', err));
      
      res.json({
        success: true,
        message: 'Password changed successfully. Please login again.'
      });
      
    } catch (err) {
      next(err);
    }
  }
);

// ── ME ────────────────────────────────────────────────────────────
router.get('/me', protect, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return next(new AppError('User not found', 404));

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


router.signAccessToken = signAccessToken;
router.signRefreshToken = signRefreshToken;

module.exports = router;