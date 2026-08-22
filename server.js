"use strict";

// ── ENV MUST BE FIRST ─────────────────────────────────────────────
require("dotenv").config();

const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const { validateEnv } = require("./config/validateEnv");
try {
  validateEnv();
} catch (error) {
  console.error("Environment validation failed:", error.message);
  process.exit(1);
}

const express = require("express");
const mongoose = require("mongoose");
const helmet = require("helmet");
const cors = require("cors");
const compression = require("compression");
const morgan = require("morgan");
const path = require("path");
const hpp = require("hpp");
const mongoSanitize = require("express-mongo-sanitize");


const authRoutes = require("./routes/auth");
const cookieParser = require('cookie-parser');
const productRoutes = require("./routes/products");
const orderRoutes = require("./routes/orders");
const paymentRoutes = require("./routes/payments");
const webhookRoutes = require("./routes/webhooks");
const userRoutes = require("./routes/users");
const adminRoutes = require("./routes/admin");
const categoryRoutes = require("./routes/categories");
const settingRoutes = require("./routes/admin");
const googleAuthRoutes = require("./routes/googleAuth.route");
const { cacheGet, cacheSet, getRedisClient } = require('./config/redis');


const { errorHandler } = require("./middleware/errorHandler");
const {
  sanitizeInput,
  requestId,
  limitQueryString,
} = require("./middleware/sanitize");
const {
  globalLimiter,
  authLimiter,
  webhookLimiter,
  adminLoginLimiter,
  googleLimiter
} = require("./middleware/rateLimiter");
const logger = require("./utils/logger");
 
// ── APP INIT ──────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);
app.use(requestId);
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// ── SECURITY HEADERS ──────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
       scriptSrc: ["'self'"],
        frameSrc: ["'self'"],
        connectSrc: ["'self'",(process.env.BACKEND_URL ? [process.env.BACKEND_URL] : [])],
        imgSrc: ["'self'", "data:", "https:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    permissionsPolicy: { features: { geolocation: ["'none'"] } },
  })
); 
// CORS Configuration
const rawOrigins = [process.env.ALLOWED_ORIGINS, process.env.FRONTEND_URL]
  .filter(Boolean)
  .join(",");

if (!rawOrigins && process.env.NODE_ENV === "production") {
  throw new Error("ALLOWED_ORIGINS must be set in production");
}

const allowedOrigins = [
  ...(rawOrigins ? rawOrigins.split(",").map((o) => o.trim()).filter(Boolean) : []),
  "http://localhost:5173",
  "https://localhost",
  "capacitor://localhost",
  "http://localhost",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin))
        return callback(null, true);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Request-ID"],
  }),
);

app.use(compression());
app.use(limitQueryString(2048));

// ── BODY PARSERS (hpp must come AFTER these) ──────────────────────
app.use("/api/v1/webhooks/monnify", express.raw({ type: "application/json", limit: "150kb" }));
app.use("/api/v1/admin", express.json({ limit: "50kb" }));
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());


// FIX: hpp after body parsers so it can actually inspect req.body
app.use(hpp());
app.use(sanitizeInput);
app.use(mongoSanitize());

// ── LOGGING ───────────────────────────────────────────────────────
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms", {
    stream: { write: (msg) => logger.info(msg.trim()) },
    skip: (req) => req.path === "/health" || req.path === "/ready",
  }),
);

// ── RATE LIMITING ─────────────────────────────────────────────────
app.use("/api", globalLimiter);
app.use("/api/v1/auth/login", authLimiter);
app.use("/api/v1/auth/admin-login", adminLoginLimiter);
app.use("/api/v1/auth/register", authLimiter);
app.use("/api/v1/auth/forgot-password", authLimiter);
app.use("/api/v1/auth/reset-password", authLimiter);
app.use("/api/v1/webhooks", webhookLimiter);

// ── HEALTH CHECKS ─────────────────────────────────────────────────
app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    timestamp: new Date(),
    uptime: process.uptime(),
    env: process.env.NODE_ENV,
  }),
);

app.get("/ready", async (req, res) => {
  try {
    await mongoose.connection.db.admin().ping();
    res.json({ ready: true, db: "connected" });
  } catch {
    res.status(503).json({ ready: false, error: "Database not connected" });
  }
});
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to the API',
    version: '2.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      ready: '/ready',
      //redis: '/health/redis',
    },
    timestamp: new Date().toISOString(),
  });
});


// ✅ ADD REDIS HEALTH CHECK ENDPOINT

async function checkRedis() {
  try {
    await cacheSet('health:check', { ok: true }, 10);
    const val = await cacheGet('health:check');
    if (val?.ok) {
      logger.info('Redis cache: connected and working');
    } else {
      logger.warn('Redis cache: connected but read failed');
    }
  } catch (err) {
    logger.error('Redis cache: NOT connected —', err.message);
    logger.warn('Products will load from MongoDB on every request until Redis is fixed');
  }
}

checkRedis();


// ── API ROUTES ────────────────────────────────────────────────────

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/products", productRoutes);
app.use("/api/v1/orders", orderRoutes);
app.use("/api/v1/payments", paymentRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/settings", settingRoutes);
app.use("/api/v1/webhooks", webhookRoutes);
app.use("/api/v1/categories", categoryRoutes);
 app.use("/api/v1/auth", googleAuthRoutes)
// ── API 404 ───────────────────────────────────────────────────────
app.use("/api", (req, res) => {
  res
    .status(404)
    .json({
      success: false,
      error: `Route ${req.method} ${req.originalUrl} not found`,
    });
});

// ── ERROR HANDLER (must be last) ──────────────────────────────────
app.use(errorHandler);

// ── DATABASE ──────────────────────────────────────────────────────
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info("✅ MongoDB connected");
  } catch (err) {
    // Log full error object — err.message alone can be empty for some mongoose errors
    logger.error("❌ MongoDB connection failed:", err);
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
    logger.info("DB connection closed");
    process.exit(0);
  };
  if (server) {
    server.close(cleanup);
  } else {
    cleanup();
  }
  // Force exit if cleanup hangs
  setTimeout(() => {
    logger.error("Forced shutdown after 30s");
    process.exit(1);
  }, 30_000).unref();
}

// ── BOOT ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  server = app.listen(PORT, () => {
    logger.info(`🚀 Server running on port ${PORT} [${process.env.NODE_ENV}]`);
  });

  server.timeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  // FIX: unhandledRejection = unknown state → exit immediately, don't drain
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection:", reason);
    process.exit(1);
  });

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception (terminating):", err);
    process.exit(1);
  });
});

module.exports = app;