'use strict';

const argon2 = require('argon2');

// Prefer explicit encoding and a length check on the pepper
const pepper = process.env.ARGON2_PEPPER;
if (process.env.NODE_ENV === 'production' && !pepper) {
  throw new Error('ARGON2_PEPPER is required in production');
}

const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  saltLength: 32,
  secret: pepper ? Buffer.from(pepper, 'utf8') : undefined,
};

async function hashPassword(plaintext) {
  if (!plaintext || plaintext.length > 1024) {
    throw new Error('Invalid password length');
  }
  return argon2.hash(plaintext, HASH_OPTIONS);
}

/**
 * Returns { valid: boolean, rehash: string|null }
 * Caller should persist rehash to DB if non-null (transparent parameter upgrade).
 */
async function verifyPassword(hash, plaintext) {
  const valid = await argon2.verify(hash, plaintext, {
    secret: HASH_OPTIONS.secret,
  });
  if (!valid) return { valid: false, rehash: null };

  const rehash = argon2.needsRehash(hash, HASH_OPTIONS)
    ? await argon2.hash(plaintext, HASH_OPTIONS)
    : null;

  return { valid: true, rehash };
}

module.exports = { hashPassword, verifyPassword };