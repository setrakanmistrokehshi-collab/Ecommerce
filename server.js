'use strict';

// ── ENV MUST BE FIRST ─────────────────────────────────────────────
require('dotenv').config();

const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const { validateEnv } = require('./config/validateEnv');
try {
  validateEnv();
} catch (error) {
  console.error('Environment validation failed:', error.message);
  process.exit(1);
}

const express       = require('express');
const mongoose      = require('mongoose');
const helmet        = require('helmet');
const cors          = require('cors');
const compression   = require('compression');
const morgan        = require('morgan');
const path          = require('path');
const hpp           = require('hpp');
const mongoSanitize = require('express-mongo-sanitize');

const authRoutes    = require('./routes/auth');
const productRoutes = require('./routes/products');
const orderRoutes   = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const webhookRoutes = require('./routes/webhooks');
const userRoutes    = require('./routes/users');
const adminRoutes   = require('./routes/admin');

const { errorHandler }                              = require('./middleware/errorHandler');
const { sanitizeInput, requestId, limitQueryString } = require('./middleware/sanitize');
const { globalLimiter, authLimiter, webhookLimiter } = require('./middleware/rateLimiter');
const logger = require('./utils/logger');

// ── APP INIT ──────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(requestId);

// ── SECURITY HEADERS ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", 'https://checkout.nomba.com'],
      frameSrc:   ["'self'", 'https://checkout.nomba.com'],
      connectSrc: ["'self'", 'https://api.nomba.com'],
      imgSrc:     ["'self'", 'data:', 'https:'],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
    },
  },
  hsts:             { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy:   { policy: 'strict-origin-when-cross-origin' },
  permissionsPolicy: { features: { geolocation: ["'none'"] } },
}));

// ── CORS ──────────────────────────────────────────────────────────
const rawOrigins = process.env.ALLOWED_ORIGINS;
if (!rawOrigins && process.env.NODE_ENV === 'production') {
  throw new Error('ALLOWED_ORIGINS must be set in production');
}
const allowedOrigins = (rawOrigins || 'http://localhost:5173')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
}));

app.use(compression());
app.use(limitQueryString(2048));

// ── BODY PARSERS (hpp must come AFTER these) ──────────────────────
app.use('/webhooks',      express.raw({ type: 'application/json', limit: '100kb' }));
app.use('/api/v1/admin',  express.json({ limit: '50kb' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// FIX: hpp after body parsers so it can actually inspect req.body
app.use(hpp());
app.use(sanitizeInput);
app.use(mongoSanitize());

// ── LOGGING ───────────────────────────────────────────────────────
app.use(morgan(':method :url :status :res[content-length] - :response-time ms', {
  stream: { write: (msg) => logger.info(msg.trim()) },
  skip:   (req) => req.path === '/health' || req.path === '/ready',
}));

// ── RATE LIMITING ─────────────────────────────────────────────────
app.use('/api',                             globalLimiter);
app.use('/api/v1/auth/login',               authLimiter);
app.use('/api/v1/auth/register',            authLimiter);
app.use('/api/v1/auth/forgot-password',     authLimiter);
app.use('/api/v1/auth/reset-password',      authLimiter);
app.use('/webhooks',                        webhookLimiter);

// Root route (API identity)
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Winners Health API',
    version: '1.0.0',
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV,
    database:
      mongoose.connection.readyState === 1
        ? 'connected'
        : 'disconnected',
  });
});
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/ready', async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping();
    res.json({ ready: true, db: 'connected' });
  } catch {
    res.status(503).json({ ready: false, error: 'Database not connected' });
  }
});


// ── API ROUTES ────────────────────────────────────────────────────

app.use('/api/v1/auth',     authRoutes);
app.use('/api/v1/users',    userRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/orders',   orderRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/admin',    adminRoutes);
app.use('/webhooks',        webhookRoutes);

// ── API 404 ───────────────────────────────────────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.originalUrl} not found` });
});


  

// ── ERROR HANDLER (must be last) ──────────────────────────────────
app.use(errorHandler);

// ── DATABASE ──────────────────────────────────────────────────────
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info('✅ MongoDB connected');
  } catch (error) {
    // Log full error object — error.message alone can be empty for some mongoose errors
    logger.error('❌ MongoDB connection failed:', error);
    process.exit(1);
  }
}

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────
// FIX: server may be undefined if shutdown triggered before DB connects
let server;

function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  const cleanup = async () => {
    await mongoose.connection.close();
    logger.info('DB connection closed');
    process.exit(0);
  };
  if (server) {
    server.close(cleanup);
  } else {
    cleanup();
  }
  // Force exit if cleanup hangs
  setTimeout(() => {
    logger.error('Forced shutdown after 30s');
    process.exit(1);
  }, 30_000).unref();
}

// ── BOOT ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  server = app.listen(PORT, () => {
    logger.info(`🚀 Server running on port ${PORT} || 'http://localhost:3000'}`);
  });

  server.timeout          = 30_000;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout   = 66_000;

  process.on('SIGTERM',             () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT',              () => gracefulShutdown('SIGINT'));

  // FIX: unhandledRejection = unknown state → exit immediately, don't drain
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
    process.exit(1);
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception (terminating):', error);
    process.exit(1);
  });
});

module.exports = app;