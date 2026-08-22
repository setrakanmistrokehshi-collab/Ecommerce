'use strict';

const logger = require('../utils/logger');

// ── CUSTOM ERROR CLASS ────────────────────────────────────────────
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── ERROR HANDLER MIDDLEWARE ──────────────────────────────────────
function errorHandler(err, req, res, next) {
  let { statusCode = 500, message, isOperational } = err;

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    statusCode = 422;
    const messages = Object.values(err.errors).map(e => e.message);
    message = messages.join('. ');
    isOperational = true;
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    statusCode = 409;
    if (err.message?.includes('unique_pending_payment_per_user')) {
      message = 'You already have a payment in progress. Please complete or cancel it before starting a new order.';
    } else {
      const field = Object.keys(err.keyValue || {})[0] || 'Field';
      message = `${field.charAt(0).toUpperCase() + field.slice(1)} already in use`;
    }

    isOperational = true;
  }

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    statusCode = 400;
    message = `Invalid ${err.path}: ${err.value}`;
    isOperational = true;
  }

  // JWT errors (handled in auth middleware, but just in case)
  if (err.name === 'JwtError') { statusCode = 401; message = 'Invalid token'; isOperational = true; }
  if (err.name === 'TokenExpiredError') { statusCode = 401; message = 'Token expired'; isOperational = true; }

  // Log non-operational (unexpected) errors with full stack
  if (!isOperational) {
    logger.error(`UNEXPECTED ERROR: ${err.message}`, {
      stack: err.stack,
      url: req.originalUrl,
      method: req.method,
      ip: req.ip,
    });
  }

  // Never leak internal details to client
  const response = {
    success: false,
    message: isOperational ? message : 'Something went wrong. Please try again.',
  };

  // Include stack trace only in development
  if (process.env.NODE_ENV === 'development' && !isOperational) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

module.exports = { AppError, errorHandler };