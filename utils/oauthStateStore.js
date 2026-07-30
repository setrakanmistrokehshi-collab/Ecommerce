// utils/oauthStateStore.js
//
// passport-oauth2's `state: true` option uses a session-backed store by
// default (lib/state/session.js), which needs `req.session` regardless of
// the `session:` flag passed to `authenticate()` — that's a separate,
// unrelated setting controlling whether passport calls req.login() after
// success. Since this app has no express-session (correctly — everything
// else here is stateless JWT), we give the strategy its own store instead:
// a short-lived, httpOnly cookie carrying the random CSRF nonce.
//
// Needs `cookie-parser` mounted in server.js so `req.cookies` is populated.

const crypto = require('crypto');

const COOKIE_NAME = 'g_oauth_state';
const MAX_AGE_MS = 5 * 60 * 1000; // 

class CookieStateStore {

  store(req, callback) {
    const state = crypto.randomBytes(64).toString('hex');
    req.res.cookie(COOKIE_NAME, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', 
      maxAge: MAX_AGE_MS,
      path: '/api/v1/auth/google',
    });
    callback(null, state);
  }
  // Google sent back against what's in the cookie.
  verify(req, providedState, callback) {
    const cookieState = req.cookies?.[COOKIE_NAME];
    req.res.clearCookie(COOKIE_NAME, { path: '/api/v1/auth/google' });

    if (!cookieState || cookieState !== providedState) {
      return callback(null, false, { message: 'Invalid or expired OAuth state' });
    }
    callback(null, true);
  }
}
module.exports = CookieStateStore;