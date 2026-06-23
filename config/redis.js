'use strict';

const Redis  = require('ioredis');
const logger = require('../utils/logger');

const isTLS = (url = '') => url.startsWith('rediss://');

// ─────────────────────────────────────────────
// SINGLETON STORAGE (CRITICAL FIX)
// ─────────────────────────────────────────────
let cacheWrapper = null;
let bullWrapper  = null;

// ─────────────────────────────────────────────
// BASE OPTIONS
// ─────────────────────────────────────────────
function baseOptions(url) {
  return {
    lazyConnect: true,
    connectTimeout: 10_000,
    commandTimeout: 5_000,
    enableOfflineQueue: false,

    ...(isTLS(url) && {
      tls: {
        rejectUnauthorized: true,
      },
    }),

    retryStrategy(times) {
      if (times > 6) return null;
      const delay = Math.min(times * 300, 3000);
      logger.warn(`Redis retry #${times} in ${delay}ms`);
      return delay;
    },
  };
}

// ─────────────────────────────────────────────
// CLIENT FACTORY (FIXED)
// ─────────────────────────────────────────────
function getRedisClient(label, extraOptions = {}) {
  if (label === 'Cache' && cacheWrapper) return cacheWrapper;
  if (label === 'BullMQ' && bullWrapper) return bullWrapper;

  const url = process.env.REDIS_URL;

  if (!url) {
    logger.warn(`Redis [${label}]: REDIS_URL not set`);
    return {
      client: null,
      isReady: () => false,
      ready: false,
    };
  }

  let ready = false;

  const client = new Redis(url, {
    ...baseOptions(url),
    ...extraOptions,
  });

  const wrapper = {
    client,

    get ready() {
      return ready;
    },

    isReady: () => ready,
  };

  // ── STORE SINGLETON IMMEDIATELY (CRITICAL)
  if (label === 'Cache') cacheWrapper = wrapper;
  if (label === 'BullMQ') bullWrapper = wrapper;

  // ── EVENTS
  client.on('connect', () => {
    ready = true;
    logger.info(`✅ Redis [${label}] connected`);
  });

  client.on('ready', () => {
    ready = true;
  });

  client.on('error', (err) => {
    ready = false;
    logger.error(`Redis [${label}] error: ${err.message}`);
  });

  client.on('close', () => {
    ready = false;
    logger.warn(`Redis [${label}] connection closed`);
  });

  client.on('end', () => {
    ready = false;
    logger.error(`Redis [${label}] disconnected (max retries hit)`);
  });

  client.on('reconnecting', (delay) => {
    logger.warn(`Redis [${label}] reconnecting in ${delay}ms`);
  });
  return wrapper;
}

// ─────────────────────────────────────────────
// CLIENTS (SINGLETON)
// ─────────────────────────────────────────────
const cache = getRedisClient('Cache', {
  maxRetriesPerRequest: 3,
  db: 0,
});

const bullmq = getRedisClient('BullMQ', {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
  db: 0,
});

// ─────────────────────────────────────────────
// PUBLIC CLIENT GETTERS
// ─────────────────────────────────────────────
function getCacheClient()  { return cache.client; }
function getBullMQClient() { return bullmq.client; }
function isRedisReady()    { return cache.isReady(); }

function getBullMQConnection() {
  return bullmq.client || null;
}

// ─────────────────────────────────────────────
// CACHE HELPERS
// ─────────────────────────────────────────────
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

async function cacheSet(key, value, ttl = 300) {
  if (!cache.isReady()) return false;
  try {
    await cache.client.set(key, JSON.stringify(value), 'EX', ttl);
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
    logger.warn(`cacheDel: ${err.message}`);
  }
}

async function cacheGetOrSet(key, fetchFn, ttl = 300) {
  const cached = await cacheGet(key);
  if (cached !== null) return cached;

  const fresh = await fetchFn();
  if (fresh != null) await cacheSet(key, fresh, ttl);
  return fresh;
}

// ─────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────
async function closeRedis() {
  const tasks = [];

  if (cache.client) tasks.push(cache.client.quit());
  if (bullmq.client) tasks.push(bullmq.client.quit());

  await Promise.allSettled(tasks);

  logger.info('Redis connections closed');
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
module.exports = {
  getCacheClient,
  getBullMQClient,
  getBullMQConnection,
  isRedisReady,
  getRedisClient,

  cacheGet,
  cacheSet,
  cacheDel,
  cacheGetOrSet,

  closeRedis,
};