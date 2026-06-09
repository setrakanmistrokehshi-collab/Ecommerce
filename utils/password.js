'use strict';

const argon2 = require('argon2');

const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,        // 64 MB — benchmark on prod; target 50–100ms per verify
  timeCost: 3,
  parallelism: 1,
  secret: process.env.ARGON2_PEPPER
    ? Buffer.from(process.env.ARGON2_PEPPER)
    : undefined,
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