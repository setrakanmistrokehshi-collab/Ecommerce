'use strict';

const argon2 = require('argon2');

const pepper = process.env.ARGON2_PEPPER;
if (process.env.NODE_ENV === 'production' && !pepper) {
  throw new Error('ARGON2_PEPPER is required in production');
}

/**
 * Prefer base64 for binary peppers; fall back to UTF-8 for simple string peppers.
 */
function loadPepper(raw) {
  if (!raw) return undefined;
  try {
    const buf = Buffer.from(raw, 'base64');
    // Heuristic: if the decoded length is reasonable and the original looked like base64, use it
    if (buf.length >= 16 && /^[A-Za-z0-9+/=]+$/.test(raw)) {
      return buf;
    }
  } catch {
    // fall through
  }
  return Buffer.from(raw, 'utf8');
}

const HASH_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 65536,   // 64 MiB
  timeCost: 3,
  parallelism: 1,
  saltLength: 32,      // 32 bytes
  secret: loadPepper(pepper),
});

function isValidPassword(plaintext) {
  return typeof plaintext === 'string'
    && plaintext.length > 0
    && plaintext.length <= 1024;
}

/**
 * @param {string} plaintext
 * @returns {Promise<string>}
 */
async function hashPassword(plaintext) {
  if (!isValidPassword(plaintext)) {
    throw new Error('Invalid password length');
  }
  return argon2.hash(plaintext, HASH_OPTIONS);
}

/**
 * Returns { valid: boolean, rehash: string|null }
 * Caller must persist rehash when non-null (transparent parameter upgrade).
 *
 * @param {string} hash
 * @param {string} plaintext
 * @returns {Promise<{ valid: boolean, rehash: string|null }>}
 */
async function verifyPassword(hash, plaintext) {
  if (!isValidPassword(plaintext)) {
    return { valid: false, rehash: null };
  }

  let valid = false;
  try {
    valid = await argon2.verify(hash, plaintext, {
      secret: HASH_OPTIONS.secret,
    });
  } catch {
    // Malformed / unexpected hash → authentication failure.
    // Never surface the exception to the caller.
    return { valid: false, rehash: null };
  }

  if (!valid) {
    return { valid: false, rehash: null };
  }

  const rehash = argon2.needsRehash(hash, HASH_OPTIONS)
    ? await argon2.hash(plaintext, HASH_OPTIONS)
    : null;

  return { valid: true, rehash };
}

module.exports = {
  hashPassword,
  verifyPassword,
  HASH_OPTIONS, 
};