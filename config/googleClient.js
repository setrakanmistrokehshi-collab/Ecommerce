'use strict';

const { OAuth2Client } = require('google-auth-library');

if (!process.env.GOOGLE_CLIENT_ID) {
  throw new Error('GOOGLE_CLIENT_ID is not set — GIS verification will fail.');
}

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verifies a GIS credential (ID token JWT) sent from the frontend.
 * Throws if invalid/expired/wrong audience/unverified email.
 * @param {string} credential
 * @returns {Promise<import('google-auth-library').TokenPayload>}
 */
async function verifyGoogleCredential(credential) {
  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();

  if (!payload) {
    throw new Error('Empty payload from Google token verification.');
  }
  if (!payload.email_verified) {
    throw new Error('Google account email is not verified.');
  }

  return payload; // { sub, email, email_verified, name, picture, ... }
}

module.exports = { verifyGoogleCredential };