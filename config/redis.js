'use strict';

/**
 * config/redis.js
 *
 * Provides two separate Redis clients:
 *  1. Cache client  — for cacheGet/cacheSet/cacheDel helpers
 *  2. BullMQ client — dedicated connection BullMQ requires (maxRetriesPerRequest: null)
 *
 * Both gracefully degrade to null if REDIS_URL is unset or unreachable,
 * so the rest of the app keeps running without Redis.
 */

const Redis  = require('ioredis');
const logger = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isTLS = (url = '') => url.startsWith('rediss://');

/**
 * Shared base options. TLS is added when the URL scheme is rediss://.
 * `maxRetriesPerRequest` is intentionally absent here — callers set it.
 */
function baseOptions(url) {
  return {
    lazyConnect:        true,
    connectTimeout:     10_000,
    commandTimeout:     5_000,
    enableOfflineQueue: false,
    ...(isTLS(url) && {
      tls: {
        rejectUnauthorized: true, // set false only for self-signed certs in dev
      },
    }),
    retryStrategy(times) {
      if (times > 6) return null; // stop retrying — triggers 'close'
      const delay = Math.min(times * 300, 3000);
      logger.warn(`Redis: retry #${times} in ${delay}ms`);
      return delay;
    },
  };
}

// ─── Client Factory ───────────────────────────────────────────────────────────

/**
 * @param {string} label        - Log prefix ('Cache' | 'BullMQ')
 * @param {object} extraOptions - Merged on top of base options
 * @returns {{ client: Redis | null, isReady: () => boolean }}
 */
function getRedisClient(label, extraOptions = {}) {
  const url = process.env.REDIS_URL;

  if (!url) {
    logger.warn(`Redis [${label}]: REDIS_URL not set — running without Redis`);
    return { client: null, isReady: () => false };
  }

  let ready         = false;
  let retriesExhausted = false;

  const client = new Redis(url, {
    ...baseOptions(url),
    ...extraOptions,
  });

  client.on('connect', () => {
    ready            = true;
    retriesExhausted = false;
    logger.info(`✅ Redis [${label}] connected`);
  });

  client.on('ready', () => {
    ready = true;
    logger.info(`✅ Redis [${label}] ready`);
  });

  client.on('error', (err) => {
    // Only log first occurrence to avoid log spam during retry loops
    if (ready) logger.error(`Redis [${label}] error: ${err.message}`);
    ready = false;
  });

  client.on('close', () => {
    ready = false;
    if (retriesExhausted) {
      logger.error(`Redis [${label}] max retries exhausted — disabled until restart`);
    } else {
      logger.warn(`Redis [${label}] connection closed`);
    }
  });

  client.on('end', () => {
    // 'end' fires when retryStrategy returns null (max retries hit)
    retriesExhausted = true;
    ready            = false;
    logger.error(`Redis [${label}] permanently disconnected`);
  });

  client.on('reconnecting', (delay) => {
    logger.warn(`Redis [${label}] reconnecting in ${delay}ms...`);
  });

  // Kick off the initial connection (lazyConnect suppresses auto-connect)
  client.connect().catch((err) => {
    logger.warn(`Redis [${label}] initial connect failed: ${err.message} — continuing without Redis`);
  });

  return {
    client,
    isReady: () => ready,
  };
}

// ─── Cache Client (for cacheGet/cacheSet helpers) ─────────────────────────────

const cache = getRedisClient('Cache', {
  maxRetriesPerRequest: 3,
  db: 0,
});

// ─── BullMQ Client ────────────────────────────────────────────────────────────
// BullMQ requires maxRetriesPerRequest: null — it manages its own retries internally

const bullmq = getRedisClient('BullMQ', {
  maxRetriesPerRequest: null,
  enableOfflineQueue:   true, // BullMQ needs this true
  db: 0,
});

// ─── Public Getters ───────────────────────────────────────────────────────────

function getCacheClient()  { return cache.client;  }
function getBullMQClient() { return bullmq.client; }
function isRedisReady()    { return cache.isReady(); }

/**
 * Returns a BullMQ-compatible connection object.
 * Pass this as `connection` when creating Queue / Worker / QueueScheduler.
 */
function getBullMQConnection() {
  if (!bullmq.client) return null;
  return bullmq.client; // ioredis instance is a valid BullMQ connection
}

// ─── Cache Helpers ────────────────────────────────────────────────────────────

async function cacheGet(key) {
  if (!cache.isReady()) return null;
  try {
    const val = await cache.client.get(key);
    return val ? JSON.parse(val) : null;
  } catch (err) {
    logger.warn(`cacheGet [${key}]: ${err.message}`);
    return null;
  }
}

async function cacheSet(key, value, ttlSeconds = 300) {
  if (!cache.isReady()) return false;
  try {
    await cache.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    return true;
  } catch (err) {
    logger.warn(`cacheSet [${key}]: ${err.message}`);
    return false;
  }
}

async function cacheDel(...keys) {
  if (!cache.isReady() || !keys.length) return;
  try {
    await cache.client.del(...keys);
  } catch (err) {
    logger.warn(`cacheDel [${keys}]: ${err.message}`);
  }
}

/**
 * Delete all keys matching a glob pattern.
 * Uses SCAN so it won't block Redis on large keyspaces.
 */
async function cacheDelPattern(pattern) {
  if (!cache.isReady()) return;
  try {
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await cache.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length) {
        await cache.client.del(...keys);
        deleted += keys.length;
      }
    } while (cursor !== '0');
    if (deleted) logger.info(`cacheDelPattern [${pattern}]: removed ${deleted} key(s)`);
  } catch (err) {
    logger.warn(`cacheDelPattern [${pattern}]: ${err.message}`);
  }
}

/**
 * Returns cached value if it exists, otherwise calls fetchFn(),
 * stores the result, and returns it.
 *
 * @example
 * const products = await cacheGetOrSet('products:all', () => Product.find(), 300);
 */
async function cacheGetOrSet(key, fetchFn, ttlSeconds = 300) {
  const cached = await cacheGet(key);
  if (cached !== null) return cached;

  const fresh = await fetchFn();
  if (fresh !== undefined && fresh !== null) {
    await cacheSet(key, fresh, ttlSeconds);
  }
  return fresh;
}

/**
 * Get multiple keys in one round-trip.
 * Returns an object: { [key]: value | null }
 */
async function cacheMGet(keys) {
  if (!cache.isReady() || !keys.length) {
    return Object.fromEntries(keys.map((k) => [k, null]));
  }
  try {
    const values = await cache.client.mget(...keys);
    return Object.fromEntries(
      keys.map((k, i) => [k, values[i] ? JSON.parse(values[i]) : null])
    );
  } catch (err) {
    logger.warn(`cacheMGet: ${err.message}`);
    return Object.fromEntries(keys.map((k) => [k, null]));
  }
}

/**
 * Set multiple keys in one round-trip using a pipeline.
 * @param {Array<{ key: string, value: any, ttl?: number }>} entries
 */
async function cacheMSet(entries, defaultTtl = 300) {
  if (!cache.isReady() || !entries.length) return;
  try {
    const pipeline = cache.client.pipeline();
    for (const { key, value, ttl } of entries) {
      pipeline.set(key, JSON.stringify(value), 'EX', ttl ?? defaultTtl);
    }
    await pipeline.exec();
  } catch (err) {
    logger.warn(`cacheMSet: ${err.message}`);
  }
}

/**
 * Graceful shutdown — call this in your SIGTERM/SIGINT handler.
 */
async function closeRedis() {
  const tasks = [];
  if (cache.client)  tasks.push(cache.client.quit());
  if (bullmq.client) tasks.push(bullmq.client.quit());
  await Promise.allSettled(tasks);
  logger.info('Redis connections closed');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Clients
  getCacheClient,
  getBullMQClient,
  getBullMQConnection,
  isRedisReady,
  getRedisClient,

  // Cache helpers
  cacheGet,
  cacheSet,
  cacheDel,
  cacheDelPattern,
  cacheGetOrSet,
  cacheMGet,
  cacheMSet,

  // Lifecycle
  closeRedis,
};