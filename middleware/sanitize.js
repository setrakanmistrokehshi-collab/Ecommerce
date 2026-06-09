'use strict';

/**
 * Recursively sanitize a value to prevent NoSQL injection and XSS.
 * - Strips MongoDB operator keys ($, .) from object keys
 * - Trims strings
 * - Does NOT strip HTML (handled by express-validator's escape() per field)
 */
function sanitizeValue(val, depth = 0) {
  if (depth > 10) return val; // guard against deep nesting
  if (typeof val === 'string') return val.trim();
  if (Array.isArray(val)) return val.map((v) => sanitizeValue(v, depth + 1));
  if (val !== null && typeof val === 'object') {
    const clean = {};
    for (const key of Object.keys(val)) {
      // Block MongoDB operator injection
      if (key.startsWith('$') || key.includes('.')) continue;
      clean[key] = sanitizeValue(val[key], depth + 1);
    }
    return clean;
  }
  return val;
}

/**
 * Middleware: sanitize req.body, req.query, req.params
 */
function sanitizeInput(req, res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizeValue(req.query);
  }
  // Note: req.params are already decoded by Express; sanitize strings only
  if (req.params && typeof req.params === 'object') {
    for (const key of Object.keys(req.params)) {
      if (typeof req.params[key] === 'string') {
        req.params[key] = req.params[key].trim();
      }
    }
  }
  next();
}

/**
 * Middleware: add X-Request-ID to every request for tracing
 */
function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || require('crypto').randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  next();
}

/**
 * Middleware: block requests with oversized query strings
 */
function limitQueryString(maxLength = 2048) {
  return (req, res, next) => {
    const qs = req.originalUrl.split('?')[1] || '';
    if (qs.length > maxLength) {
      return res.status(414).json({ success: false, error: 'Query string too long' });
    }
    next();
  };
}

module.exports = { sanitizeInput, requestId, limitQueryString };
