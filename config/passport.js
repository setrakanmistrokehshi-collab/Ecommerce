// config/passport.js

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL, // must match server.js mount path — see README
      scope: ['profile', 'email'],
      state: true,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const email = profile.emails?.[0]?.value?.toLowerCase();
        const emailVerified = profile.emails?.[0]?.verified ?? false;
        const displayName = profile.displayName;

        if (!email) {
          return done(null, false, { message: 'NO_EMAIL_FROM_GOOGLE' });
        }

        let user = await User.findOne({ googleId }).select('+tokenVersion');

        if (!user) {
          user = await User.findOne({ email }).select('+tokenVersion');

          if (user) {
            if (!emailVerified) {
              return done(null, false, { message: 'EMAIL_NOT_VERIFIED_BY_GOOGLE' });
            }
            user.googleId = googleId;
            user.authProviders = Array.from(
              new Set([...(user.authProviders || ['local']), 'google'])
            );
            user.isEmailVerified = true;
            await user.save({ validateBeforeSave: false });
          } else {
            user = await User.create({
              email,
              name: displayName,
              googleId,
              authProviders: ['google'],
              isEmailVerified: emailVerified,
              // no `password` — schema must make it conditional, see User model patch
            });
          }
        }

        // Same checks your local login path already applies
        if (!user.isActive) {
          return done(null, false, { message: 'ACCOUNT_DISABLED' });
        }
        if (user.lockUntil && user.lockUntil > Date.now()) {
          return done(null, false, { message: 'ACCOUNT_LOCKED' });
        }

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);

module.exports = passport;