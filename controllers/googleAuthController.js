// controllers/googleAuthController.js
//
// This controller closes that gap by doing verification + user
// resolution + session-cookie issuance in ONE request/response cycle,
// and the cookie is configured to actually survive a cross-origin
// redirect back to the frontend (SameSite=None; Secure — mandatory
// when frontend and backend are different domains).

import { SignJWT } from 'jose';
import { verifyGoogleCredential } from '../config/googleClient.js';
import User from '../models/User.js'; // adjust path to your actual model

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET);
const ACCESS_TOKEN_TTL = '15m';
const COOKIE_NAME = 'vc_session';

const isProd = process.env.NODE_ENV === 'production';

export async function googleAuthController(req, res) {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Missing Google credential.' });
    }

    // 1. Verify the ID token with Google (server-side, no round trip needed)
    const payload = await verifyGoogleCredential(credential);
    const { sub: googleId, email, name, picture } = payload;

    // 2. Find or create the user — adjust field names to match your schema
    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        email,
        name,
        avatar: picture,
        googleId,
        authProvider: 'google',
        // No password hash needed for OAuth-only accounts.
        // If your schema requires a password field, make it optional
        // or conditional on authProvider !== 'local'.
      });
    } else if (!user.googleId) {
      // Existing email/password user linking their Google account
      user.googleId = googleId;
      await user.save();
    }

    // 3. Issue YOUR app's own JWT (jose — matches the rest of your stack)
    const token = await new SignJWT({
      sub: user._id.toString(),
      email: user.email,
      role: user.role ?? 'user',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(ACCESS_TOKEN_TTL)
      .sign(JWT_SECRET);

    // 4. Set the cookie in the SAME response — this is the step that
    //    was previously silently failing.
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,          // must be true in prod (Render is https)
      sameSite: isProd ? 'none' : 'lax', // 'none' required cross-origin (Vercel -> Render)
      maxAge: 15 * 60 * 1000,
      path: '/',
    });

    return res.status(200).json({
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        role: user.role ?? 'user',
      },
    });
  } catch (err) {
    console.error('[googleAuthController]', err.message);
    return res.status(401).json({ error: 'Google authentication failed.' });
  }
}