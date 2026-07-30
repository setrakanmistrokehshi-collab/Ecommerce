// routes/authGoogleRoutes.js
//
// Mount in server.js as:
//   app.use('/api/v1/auth', require('./routes/authGoogleRoutes'));
// (same base as your existing authRoutes — NOT '/api/v1/auth/google',
// the router already defines that segment internally)

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const passport = require('../config/passport');
const { getRedisClient } = require('../config/redis');
const authRoutes = require('./auth'); // carries .signAccessToken / .signRefreshToken, see auth.js patch
const User = require('../models/User');
const logger = require('../utils/logger');

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL;
const EXCHANGE_PREFIX = 'oauth:exchange:';
const EXCHANGE_TTL_SECONDS = 60; // one minute to complete the redirect round-trip

const callbackLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const exchangeLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// Step 1 — kick off the Google consent screen
router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
    prompt: 'select_account',
  })
);

// Step 2 — Google redirects back here. We do NOT issue tokens directly in
// this response, because it's a browser redirect (no way to hand JSON back
// to your SPA's JS from here). Instead: mint a one-time code, redirect the
// browser to the frontend with just that code, and let the frontend swap it
// for tokens via a normal POST (step 3), matching your existing
// sendTokenResponse JSON shape exactly.
router.get(
  '/google/callback',
  callbackLimiter,
  (req, res, next) => {
    passport.authenticate('google', { session: false }, (err, user, info) => {
      if (err) {
        logger.error('Google OAuth error:', err);
        return res.redirect(`${FRONTEND_URL}/login?error=oauth_failed`);
      }
      if (!user) {
        const reason = info?.message || 'oauth_denied';
        return res.redirect(`${FRONTEND_URL}/login?error=${encodeURIComponent(reason)}`);
      }
      req.oauthUser = user;
      next();
    })(req, res, next);
  },
  async (req, res) => {
    try {
      const redis = getRedisClient();
      const code = crypto.randomBytes(64).toString('hex');

      if (redis) {
        await redis.set(
          `${EXCHANGE_PREFIX}${code}`,
          String(req.oauthUser._id),
          'EX',
          EXCHANGE_TTL_SECONDS
        );
      } else {
        // No Redis available — fail closed rather than silently issuing
        // tokens some other, less-audited way.
        logger.error('Google OAuth: Redis unavailable, cannot mint exchange code');
        return res.redirect(`${FRONTEND_URL}/login?error=server_error`);
      }

      const redirectUrl = new URL('/oauth/callback', FRONTEND_URL);
      redirectUrl.searchParams.set('code', code);
      return res.redirect(redirectUrl.toString());
    } catch (err) {
      logger.error('Google OAuth exchange-code error:', err);
      return res.redirect(`${FRONTEND_URL}/login?error=server_error`);
    }
  }
);

router.post('/google/exchange', exchangeLimiter, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, error: 'Code required' });
    }

    const redis = getRedisClient();
    if (!redis) {
      return res.status(503).json({ success: false, error: 'Service temporarily unavailable' });
    }

    const key = `${EXCHANGE_PREFIX}${code}`;
    // Atomic get-and-delete — GET+DEL as two separate calls is a race:
    // two near-simultaneous requests (StrictMode double-effect, a retried
    // fetch, a replayed code) could both read the value before either
    // deletes it, minting two token pairs from one code. GETDEL (Redis
    // >=6.2 / ioredis >=4.19) is a single atomic command, so only one
    // caller ever gets a non-null result.
    let userId;
    if (typeof redis.getdel === 'function') {
      userId = await redis.getdel(key);
    } else {
      // Fallback for older Redis/clients without GETDEL: MULTI/EXEC is
      // still atomic as a whole transaction (Redis is single-threaded),
      // so concurrent callers still can't both see the value.
      const results = await redis.multi().get(key).del(key).exec();
      userId = results?.[0]?.[1] ?? null;
    }
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Code expired or already used' });
    }

    const user = await User.findById(userId).select('+tokenVersion');
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, error: 'Account unavailable' });
    }

    const accessToken = await authRoutes.signAccessToken(user);
    const refreshToken = await authRoutes.signRefreshToken(user, req, false);

    const permissions =
      typeof user.getEffectivePermissions === 'function' ? user.getEffectivePermissions() : [];

    res.json({
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
  } catch (err) {
    next(err);
  }
});

module.exports = router;