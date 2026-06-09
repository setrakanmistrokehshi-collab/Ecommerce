'use strict';

const Redis  = require('ioredis');
const logger = require('../utils/logger');

let client      = null;
let isConnected = false;

function getRedisClient() {
  if (client) return client;

  if (!process.env.REDIS_URL) {
    logger.warn('REDIS_URL not set — Redis disabled (falling back to memory)');
    return null;
  }

  client = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue:   false,   // don't queue; callers handle null
    lazyConnect:          true,
    connectTimeout:       10000,
    retryStrategy: (times) => {
      if (times > 5) {
        logger.error('Redis: max retries reached — disabling Redis');
        return null;               // stop retrying; 'close' will null client
      }
      return Math.min(times * 200, 2000);
    },
  });

  client.on('connect', () => {
    isConnected = true;
    logger.info('✅ Redis connected');
  });

  client.on('error', (err) => {
    if (isConnected) logger.error('Redis error:', err.message);
    isConnected = false;
  });

  client.on('close', () => {
    isConnected = false;
    client      = null;            // authoritative null — enables reconnect attempt next call
    logger.warn('Redis connection closed');
  });

  client.connect().catch((err) => {
    logger.warn('Redis connect failed — running without cache:', err.message);
    client = null;
  });

  return client;
}

async function cacheGet(key) {
  const c = getRedisClient();
  if (!c || !isConnected) return null;
  try {
    const val = await c.get(key);
    return val ? JSON.parse(val) : null;
  } catch (err) {
    logger.warn(`Cache get error [${key}]:`, err.message);
    return null;
  }
}

async function cacheSet(key, value, ttlSeconds = 300) {
  const c = getRedisClient();
  if (!c || !isConnected) return;
  try {
    await c.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn(`Cache set error [${key}]:`, err.message);
  }
}

async function cacheDel(key) {
  const c = getRedisClient();
  if (!c || !isConnected) return;
  try {
    await c.del(key);
  } catch (err) {
    logger.warn(`Cache del error [${key}]:`, err.message);
  }
}

async function cacheDelPattern(pattern) {
  const c = getRedisClient();
  if (!c || !isConnected) return;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await c.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length) await c.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    logger.warn(`Cache del pattern error [${pattern}]:`, err.message);
  }
}

module.exports = { getRedisClient, cacheGet, cacheSet, cacheDel, cacheDelPattern };