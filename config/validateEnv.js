'use strict';

/**
 * Validates required environment variables at startup.
 * Fails fast in production; warns in development.
 */
function validateEnv() {
  const REQUIRED = [
    'MONGODB_URI',
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    //'NOMBA_CLIENT_ID',
    //'NOMBA_WEBHOOK_SECRET',
    //'NOMBA_ACCOUNT_ID',
    //'NOMBA_BASE_URL',
    //'EMAIL_HOST',
    'EMAIL_USER',
    'EMAIL_PASS',
    'EMAIL_FROM_ADDRESS',
    'BASE_URL',
    'ALLOWED_ORIGINS',
    
  ];

  const PROD_REQUIRED = [
    'NOMBA_WEBHOOK_SECRET',
  ];

  const missing = REQUIRED.filter((key) => !process.env[key]);

  if (process.env.NODE_ENV === 'production') {
    const missingProd = PROD_REQUIRED.filter((key) => !process.env[key]);
    missing.push(...missingProd);
  }

  if (missing.length > 0) {
    const msg = `Missing required environment variables:\n  ${missing.join('\n  ')}`;
    if (process.env.NODE_ENV === 'production') {
      console.error(`[FATAL] ${msg}`);
      process.exit(1);
    } else {
      console.warn(`[WARN] ${msg}\n  Some features may not work in development.`);
    }
  }

  // Warn about weak secrets
  const weakSecrets = ['JWT_SECRET', 'JWT_REFRESH_SECRET'].filter(
    (key) => process.env[key] && process.env[key].length < 32
  );
  if (weakSecrets.length) {
    console.warn(`[WARN] Weak secrets detected (should be 64+ chars): ${weakSecrets.join(', ')}`);
  }
}

module.exports = { validateEnv };
