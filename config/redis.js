// config/redis.js
'use strict';

const Redis = require('ioredis');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────
// IN-MEMORY FALLBACK CACHE
// ─────────────────────────────────────────────
class MemoryFallbackCache {
  constructor(options = {}) {
    this.cache = new Map();
    this.defaultTTL = options.defaultTTL || 300;
    this.maxSize = options.maxSize || 1000;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.enabled = true;
    this.redisAvailable = false;
    logger.info('📦 In-memory fallback cache initialized');
  }

  get(key) {
    if (!this.enabled) return null;
    
    const item = this.cache.get(key);
    if (!item) {
      this.misses++;
      return null;
    }

    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return item.value;
  }

  set(key, value, ttl = this.defaultTTL) {
    if (!this.enabled) return false;

    if (this.cache.size >= this.maxSize) {
      this.evictOldest();
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + (ttl * 1000),
      createdAt: Date.now(),
    });
    return true;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  has(key) {
    const item = this.cache.get(key);
    if (!item) return false;
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: this.hits + this.misses > 0 
        ? (this.hits / (this.hits + this.misses) * 100).toFixed(2) + '%'
        : '0%',
      redisAvailable: this.redisAvailable,
      mode: this.redisAvailable ? 'redis' : 'memory',
    };
  }

  evictOldest() {
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey) {
      this.cache.delete(oldestKey);
      this.evictions++;
    }
  }

  async getOrSet(key, fetchFn, ttl = this.defaultTTL) {
    const cached = this.get(key);
    if (cached !== null) return cached;

    try {
      const fresh = await fetchFn();
      if (fresh !== null && fresh !== undefined) {
        this.set(key, fresh, ttl);
      }
      return fresh;
    } catch (err) {
      logger.error(`MemoryCache: getOrSet failed for ${key}: ${err.message}`);
      throw err;
    }
  }

  mget(keys) {
    return keys.map(key => this.get(key));
  }

  mset(items, ttl = this.defaultTTL) {
    for (const [key, value] of Object.entries(items)) {
      this.set(key, value, ttl);
    }
    return true;
  }

  mdelete(keys) {
    for (const key of keys) {
      this.cache.delete(key);
    }
    return true;
  }

  keys() {
    return Array.from(this.cache.keys());
  }
}

// ─────────────────────────────────────────────
// SINGLETON STORAGE
// ─────────────────────────────────────────────
let cacheWrapper = null;
let bullWrapper = null;
let redisReady = false; // ← Renamed from isRedisReady
let memoryFallback = null;

// ─────────────────────────────────────────────
// CONFIGURATION HELPERS
// ─────────────────────────────────────────────
function isRedisConfigured() {
  return !!process.env.REDIS_URL;
}

function isTLS(url = '') {
  return url.startsWith('rediss://');
}

function getRedisConfig() {
  const url = process.env.REDIS_URL;
  
  if (!url) {
    return null;
  }

  return {
    url,
    isTLS: isTLS(url),
    options: {
      lazyConnect: true,
      connectTimeout: 10000,
      commandTimeout: 5000,
      enableOfflineQueue: false,
      keepAlive: 30000,
      family: 4,
      maxRetriesPerRequest: 3,
      
      ...(isTLS(url) && {
        tls: {
          rejectUnauthorized: process.env.NODE_ENV === 'production',
        },
      }),
      
      retryStrategy(times) {
        if (times > 10) {
          logger.error(`Redis: Max retry attempts (${times}) reached`);
          return null;
        }
        const delay = Math.min(times * 100, 3000);
        logger.warn(`Redis: Retry #${times} in ${delay}ms`);
        return delay;
      },
    },
  };
}

// ─────────────────────────────────────────────
// BASE OPTIONS
// ─────────────────────────────────────────────
function baseOptions(url) {
  return {
    lazyConnect: true,
    connectTimeout: 10_000,
    commandTimeout: 5_000,
    enableOfflineQueue: false,
    keepAlive: 30000,
    family: 4,

    ...(isTLS(url) && {
      tls: {
        rejectUnauthorized: process.env.NODE_ENV === 'production',
      },
    }),

    retryStrategy(times) {
      if (times > 10) return null;
      const delay = Math.min(times * 100, 3000);
      logger.warn(`Redis retry #${times} in ${delay}ms`);
      return delay;
    },
  };
}

// ─────────────────────────────────────────────
// GET OR CREATE MEMORY FALLBACK
// ─────────────────────────────────────────────
function getMemoryFallback() {
  if (!memoryFallback) {
    memoryFallback = new MemoryFallbackCache({
      defaultTTL: parseInt(process.env.CACHE_TTL) || 300,
      maxSize: parseInt(process.env.CACHE_MAX_SIZE) || 1000,
    });
  }
  return memoryFallback;
}

// ─────────────────────────────────────────────
// CLIENT FACTORY WITH FALLBACK
// ─────────────────────────────────────────────
function getRedisClient(label, extraOptions = {}) {
  // Check singletons FIRST
  if (label === 'Cache' && cacheWrapper) return cacheWrapper;
  if (label === 'BullMQ' && bullWrapper) return bullWrapper;

  const config = getRedisConfig();

  if (!config) {
    logger.warn(`Redis [${label}]: REDIS_URL not set — using memory fallback`);
    
    const fallbackWrapper = {
      client: null,
      ready: true,
      isReady: () => true,
      status: 'memory_fallback',
      isMemoryFallback: true,
    };
    
    if (label === 'Cache') cacheWrapper = fallbackWrapper;
    if (label === 'BullMQ') bullWrapper = fallbackWrapper;
    
    return fallbackWrapper;
  }

  // Track ready state properly
  let ready = false;

  const client = new Redis(config.url, {
    ...baseOptions(config.url),
    ...extraOptions,
  });

  const wrapper = {
    get client() {
      return client;
    },
    get ready() {
      return ready;
    },
    isReady: () => ready,
    get status() {
      return client.status;
    },
    isMemoryFallback: false,
  };

  // Store singleton IMMEDIATELY
  if (label === 'Cache') cacheWrapper = wrapper;
  if (label === 'BullMQ') bullWrapper = wrapper;

  // ── EVENTS ──
  client.on('connect', () => {
    logger.info(`✅ Redis [${label}] connected`);
  });

  client.on('ready', () => {
    ready = true;
    redisReady = true; // ← Updated
    if (memoryFallback) {
      memoryFallback.redisAvailable = true;
    }
    logger.info(`✅ Redis [${label}] ready for commands`);
  });

  client.on('error', (err) => {
    // Don't set ready = false on every error (only connection errors)
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
      ready = false;
      redisReady = false;
      if (memoryFallback) {
        memoryFallback.redisAvailable = false;
      }
      logger.warn(`⚠️ Redis [${label}] failed — falling back to memory cache`);
    }
    
    if (err.code === 'ECONNREFUSED') {
      logger.error(`Redis [${label}]: Connection refused. Is Redis running?`);
    } else if (err.code === 'ENOTFOUND') {
      logger.error(`Redis [${label}]: Host not found. Check REDIS_URL`);
    } else if (err.code === 'ETIMEDOUT') {
      logger.error(`Redis [${label}]: Connection timeout`);
    } else {
      logger.error(`Redis [${label}] error: ${err.message}`);
    }
  });

  client.on('close', () => {
    ready = false;
    redisReady = false;
    if (memoryFallback) {
      memoryFallback.redisAvailable = false;
    }
    logger.warn(`Redis [${label}] connection closed — using memory fallback`);
  });

  client.on('end', () => {
    ready = false;
    redisReady = false;
    if (memoryFallback) {
      memoryFallback.redisAvailable = false;
    }
    logger.error(`Redis [${label}] disconnected (max retries hit) — using memory fallback`);
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
});

const bullmq = getRedisClient('BullMQ', {
  maxRetriesPerRequest: 5,
  enableOfflineQueue: true,
});

// ─────────────────────────────────────────────
// PUBLIC CLIENT GETTERS
// ─────────────────────────────────────────────
function getCacheClient() {
  return cache?.client || null;
}

function getBullMQClient() {
  return bullmq?.client || null;
}

function getBullMQConnection() {
  return bullmq?.client || null;
}

// ─── FIXED: Only ONE isRedisReady function ───
function isRedisReady() {
  return cache?.isReady() || false;
}

function isUsingMemoryFallback() {
  return cache?.isMemoryFallback || false;
}

function getRedisStatus() {
  const memFallback = getMemoryFallback();
  const stats = memFallback.getStats();
  
  return {
    cache: {
      ready: cache?.isReady() || false,
      status: cache?.status || 'not_initialized',
      isMemoryFallback: cache?.isMemoryFallback || false,
    },
    bullmq: {
      ready: bullmq?.isReady() || false,
      status: bullmq?.status || 'not_initialized',
      isMemoryFallback: bullmq?.isMemoryFallback || false,
    },
    configured: isRedisConfigured(),
    memoryFallback: stats,
    mode: redisReady ? 'redis' : 'memory',
  };
}

// ─────────────────────────────────────────────
// CACHE HELPERS WITH FALLBACK
// ─────────────────────────────────────────────
async function cacheGet(key) {
  // Try Redis first
  if (cache && cache.isReady()) {
    try {
      const val = await cache.client.get(key);
      if (val !== null) {
        try {
          return JSON.parse(val);
        } catch (parseErr) {
          logger.warn(`cacheGet [${key}]: Failed to parse JSON: ${parseErr.message}`);
          return null;
        }
      }
    } catch (err) {
      logger.warn(`cacheGet [${key}]: Redis error: ${err.message} — using memory fallback`);
      // Fall through to memory cache
    }
  }

  // Fallback to memory cache
  const memFallback = getMemoryFallback();
  return memFallback.get(key);
}

async function cacheSet(key, value, ttl = 300) {
  let redisSuccess = false;

  // Try Redis first
  if (cache && cache.isReady()) {
    try {
      const serialized = JSON.stringify(value);
      await cache.client.set(key, serialized, 'EX', ttl);
      redisSuccess = true;
    } catch (err) {
      logger.warn(`cacheSet [${key}]: Redis error: ${err.message} — using memory fallback`);
    }
  }

  // Always store in memory fallback (for consistency)
  const memFallback = getMemoryFallback();
  memFallback.set(key, value, ttl);
  
  // Also store in Redis if it worked
  return redisSuccess;
}

async function cacheDel(...keys) {
  let redisSuccess = false;

  // Try Redis first
  if (cache && cache.isReady()) {
    try {
      await cache.client.del(...keys);
      redisSuccess = true;
    } catch (err) {
      logger.warn(`cacheDel: Redis error: ${err.message} — using memory fallback`);
    }
  }

  // Always delete from memory fallback
  const memFallback = getMemoryFallback();
  memFallback.mdelete(keys);
  
  return redisSuccess;
}

async function cacheGetOrSet(key, fetchFn, ttl = 300) {
  // Try Redis first
  if (cache && cache.isReady()) {
    try {
      const cached = await cacheGet(key);
      if (cached !== null) return cached;
    } catch (err) {
      logger.warn(`cacheGetOrSet [${key}]: Redis error: ${err.message} — using memory fallback`);
    }
  }

  // Try memory fallback
  const memFallback = getMemoryFallback();
  const memCached = memFallback.get(key);
  if (memCached !== null) {
    // If we have it in memory, also try to restore to Redis
    if (cache && cache.isReady()) {
      try {
        await cacheSet(key, memCached, ttl);
      } catch (err) {
        // Ignore Redis errors, memory is working
      }
    }
    return memCached;
  }

  // Fetch fresh data
  try {
    const fresh = await fetchFn();
    if (fresh !== null && fresh !== undefined) {
      // Store in both Redis and memory
      await cacheSet(key, fresh, ttl);
    }
    return fresh;
  } catch (err) {
    logger.error(`cacheGetOrSet [${key}]: Fetch failed: ${err.message}`);
    throw err;
  }
}

// ─────────────────────────────────────────────
// CONNECTION TEST
// ─────────────────────────────────────────────
async function testRedisConnection() {
  const config = getRedisConfig();
  
  if (!config) {
    return {
      success: false,
      error: 'REDIS_URL not configured',
      isMock: true,
      message: 'Redis is not configured. Using memory fallback.',
      fallback: true,
    };
  }

  const testClient = new Redis(config.url, {
    connectTimeout: 5000,
    commandTimeout: 3000,
    retryStrategy: () => null,
    ...(config.isTLS && {
      tls: {
        rejectUnauthorized: process.env.NODE_ENV === 'production',
      },
    }),
  });

  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        testClient.disconnect();
        reject(new Error('Connection timeout'));
      }, 5000);

      testClient.on('connect', () => {
        clearTimeout(timeout);
        resolve('connected');
      });

      testClient.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      testClient.once('ready', async () => {
        try {
          const pong = await testClient.ping();
          clearTimeout(timeout);
          resolve(pong);
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });

    await testClient.quit();

    return {
      success: result === 'PONG',
      message: result,
      isMock: false,
      fallback: false,
    };
  } catch (err) {
    await testClient.quit().catch(() => {});
    return {
      success: false,
      error: err.message,
      isMock: false,
      fallback: true,
      message: 'Redis unavailable — using memory fallback',
    };
  }
}

// ─────────────────────────────────────────────
// REDIS HEALTH CHECK
// ─────────────────────────────────────────────
async function redisHealthCheck() {
  const memFallback = getMemoryFallback();
  const stats = memFallback.getStats();
  
  const result = {
    configured: isRedisConfigured(),
    mode: redisReady ? 'redis' : 'memory',
    cache: {
      connected: false,
      status: 'disconnected',
    },
    bullmq: {
      connected: false,
      status: 'disconnected',
    },
    memoryFallback: stats,
  };

  if (!isRedisConfigured()) {
    result.cache.status = 'not_configured';
    result.bullmq.status = 'not_configured';
    result.mode = 'memory';
    return result;
  }

  try {
    if (cache?.isReady()) {
      await cache.client.ping();
      result.cache.connected = true;
      result.cache.status = 'connected';
    } else {
      result.cache.status = cache?.status || 'fallback_mode';
    }
  } catch (err) {
    result.cache.status = `error: ${err.message}`;
  }

  try {
    if (bullmq?.isReady()) {
      await bullmq.client.ping();
      result.bullmq.connected = true;
      result.bullmq.status = 'connected';
    } else {
      result.bullmq.status = bullmq?.status || 'fallback_mode';
    }
  } catch (err) {
    result.bullmq.status = `error: ${err.message}`;
  }

  return result;
}

// ─────────────────────────────────────────────
// CACHE STATS
// ─────────────────────────────────────────────
function getCacheStats() {
  const memFallback = getMemoryFallback();
  return memFallback.getStats();
}

async function cacheClear() {
  const memFallback = getMemoryFallback();
  memFallback.clear();
  
  if (cache && cache.isReady()) {
    try {
      await cache.client.flushdb();
    } catch (err) {
      logger.warn('cacheClear: Redis flush failed — memory cache cleared');
    }
  }
}

// ─────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────
async function closeRedis() {
  const tasks = [];

  if (cache?.client) {
    try {
      tasks.push(cache.client.quit());
      logger.info('Cache Redis: quit called');
    } catch (err) {
      logger.warn('Cache Redis quit error:', err.message);
    }
  }

  if (bullmq?.client) {
    try {
      tasks.push(bullmq.client.quit());
      logger.info('BullMQ Redis: quit called');
    } catch (err) {
      logger.warn('BullMQ Redis quit error:', err.message);
    }
  }

  if (tasks.length) {
    await Promise.allSettled(tasks);
    logger.info('✅ Redis connections closed');
  } else {
    logger.info('No Redis connections to close');
  }

  cacheWrapper = null;
  bullWrapper = null;
  redisReady = false;
  
  if (memoryFallback) {
    memoryFallback.redisAvailable = false;
  }
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
module.exports = {
  // Client getters
  getCacheClient,
  getBullMQClient,
  getBullMQConnection,
  getRedisClient,
  getRedisStatus,
  
  // State checks
  isRedisReady, // ← Now only ONE function
  isRedisConfigured,
  isUsingMemoryFallback,
  
  // Cache operations
  cacheGet,
  cacheSet,
  cacheDel,
  cacheGetOrSet,
  cacheClear,
  getCacheStats,
  
  // Health & testing
  testRedisConnection,
  redisHealthCheck,
  
  // Cleanup
  closeRedis,
};