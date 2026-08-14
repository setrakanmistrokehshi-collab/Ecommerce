'use strict';

const { BrevoClient } = require('@getbrevo/brevo');
const sgMail = require('@sendgrid/mail');
const geoip = require('geoip-lite');
const DeviceDetector = require('device-detector-js');
const crypto = require('crypto');
const cron = require('node-cron');
const logger = require('./logger');

// ── CONFIGURATION ──────────────────────────────────────────────────
const config = {
  PRIORITY: {
    CRITICAL: 1,    // Must send - password resets, order confirmations
    IMPORTANT: 2,   // Should send - shipping updates, welcome emails
    NORMAL: 3,      // Nice to have - login alerts, promotions
    LOW: 4,         // Optional - newsletters, marketing
  },
  DAILY_LIMITS: {
    TOTAL: 100,
    CRITICAL_RESERVE: 20,
  },
  LOGIN_ALERT: {
    BATCH_SIZE: 5,
    KNOWN_DEVICES_TTL: 30,
    MIN_TIME_BETWEEN: 3600,
  },
  OFF_PEAK: {
    HOURS: [22, 23, 0, 1, 2, 3, 4, 5],
    BATCH_SIZE: 20,
  },
};

// ── PROVIDER SETUP ──────────────────────────────────────────────
let brevoClientInstance;
let sendgridConfigured = false;

function getBrevoClient() {
  if (brevoClientInstance) return brevoClientInstance;

  if (!process.env.BREVO_API_KEY) {
    logger.warn('⚠️ BREVO_API_KEY not set');
    return null;
  }

  brevoClientInstance = new BrevoClient({
    apiKey: process.env.BREVO_API_KEY,
    timeoutInSeconds: 30,
    maxRetries: 2,
  });

  return brevoClientInstance;
}

function getSendGridClient() {
  if (sendgridConfigured) return sgMail;

  if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    sendgridConfigured = true;
    logger.info('✅ SendGrid configured');
    return sgMail;
  }

  logger.warn('⚠️ SENDGRID_API_KEY not set');
  return null;
}

// ── EMAIL COUNTER & QUEUE ──────────────────────────────────────
let emailCount = {
  sentToday: 0,
  lastReset: new Date().toDateString(),
  criticalUsed: 0,
};

const emailQueue = {
  high: [],
  normal: [],
  low: [],
  isProcessing: false,
};

const deviceCache = new Map();
const loginAlertCache = new Map();

// ── COUNTER MANAGEMENT ──────────────────────────────────────────
function resetDailyCounter() {
  const today = new Date().toDateString();
  if (today !== emailCount.lastReset) {
    emailCount = {
      sentToday: 0,
      lastReset: today,
      criticalUsed: 0,
    };
    logger.info('🔄 Daily email counter reset');
  }
}

function canSendEmail(priority = config.PRIORITY.NORMAL) {
  resetDailyCounter();

  const totalLimit = config.DAILY_LIMITS.TOTAL;
  const criticalReserve = config.DAILY_LIMITS.CRITICAL_RESERVE;
  const available = totalLimit - emailCount.sentToday;

  // Critical emails always get through
  if (priority === config.PRIORITY.CRITICAL) {
    if (emailCount.sentToday >= totalLimit) {
      logger.warn(`⚠️ Daily limit reached, sending critical email (${emailCount.criticalUsed + 1}/${criticalReserve} reserve)`);
      return true;
    }
    return true;
  }

  // Reserve capacity for critical emails
  const reserveLeft = criticalReserve - emailCount.criticalUsed;
  const effectiveAvailable = available - reserveLeft;

  if (effectiveAvailable <= 0) {
    logger.warn(`⏭️ Skipping email - daily limit reached (${emailCount.sentToday}/${totalLimit})`);
    return false;
  }

  return true;
}

function isOffPeakHours() {
  const hour = new Date().getHours();
  return config.OFF_PEAK.HOURS.includes(hour);
}

// ── QUEUE SYSTEM ──────────────────────────────────────────────────
function queueEmail({ to, subject, html, priority, data }) {
  const queueItem = { to, subject, html, priority, data, timestamp: Date.now() };

  if (priority <= config.PRIORITY.IMPORTANT) {
    emailQueue.high.push(queueItem);
  } else if (priority === config.PRIORITY.NORMAL) {
    emailQueue.normal.push(queueItem);
  } else {
    emailQueue.low.push(queueItem);
  }

  logger.info(`📦 Email queued (priority ${priority}): ${subject}`);

  if (!emailQueue.isProcessing) {
    processQueue();
  }
}

async function processQueue() {
  if (emailQueue.isProcessing) return;

  emailQueue.isProcessing = true;

  try {
    const allQueued = [...emailQueue.high, ...emailQueue.normal, ...emailQueue.low];

    if (allQueued.length === 0) {
      emailQueue.isProcessing = false;
      return;
    }

    const isOffPeak = isOffPeakHours();
    const batchSize = isOffPeak ? config.OFF_PEAK.BATCH_SIZE : 5;
    const toSend = allQueued.slice(0, batchSize);

    for (const item of toSend) {
      try {
        if (canSendEmail(item.priority)) {
          await sendEmailWithProvider(item);
          removeFromQueue(item);
        } else {
          break;
        }
      } catch (error) {
        logger.error(`❌ Queue send failed: ${error.message}`);
      }
    }

    if (allQueued.length > 0) {
      setTimeout(processQueue, 5000);
    } else {
      emailQueue.isProcessing = false;
    }
  } catch (error) {
    logger.error(`❌ Queue processing error: ${error.message}`);
    emailQueue.isProcessing = false;
  }
}

function removeFromQueue(item) {
  const removeItem = (queue) => {
    const index = queue.findIndex(q =>
      q.to === item.to &&
      q.subject === item.subject &&
      q.timestamp === item.timestamp
    );
    if (index > -1) queue.splice(index, 1);
  };

  removeItem(emailQueue.high);
  removeItem(emailQueue.normal);
  removeItem(emailQueue.low);
}

// ── DEVICE DETECTION ─────────────────────────────────────────────
function getDeviceHash(userAgent, ip) {
  const string = `${userAgent}-${ip}`;
  return crypto.createHash('md5').update(string).digest('hex');
}

function isKnownDevice(userId, deviceHash) {
  const key = `device-${userId}`;
  if (!deviceCache.has(key)) return false;

  const devices = deviceCache.get(key);
  const device = devices.find(d => d.hash === deviceHash);

  if (!device) return false;

  const ttl = config.LOGIN_ALERT.KNOWN_DEVICES_TTL * 24 * 3600 * 1000;
  return (Date.now() - device.lastSeen) < ttl;
}

function addKnownDevice(userId, deviceHash, deviceInfo) {
  const key = `device-${userId}`;
  if (!deviceCache.has(key)) {
    deviceCache.set(key, []);
  }

  const devices = deviceCache.get(key);
  const existing = devices.find(d => d.hash === deviceHash);

  if (existing) {
    existing.lastSeen = Date.now();
  } else {
    devices.push({
      hash: deviceHash,
      ...deviceInfo,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
    });
  }

  deviceCache.set(key, devices);
}

// ── SMART LOGIN ALERT LOGIC ─────────────────────────────────────
function shouldSendLoginAlert(userId, ip, userAgent) {
  const deviceDetector = new DeviceDetector();
  const deviceInfo = deviceDetector.parse(userAgent);

  const geo = geoip.lookup(ip);
  const location = geo ? `${geo.city}, ${geo.country}` : 'Unknown';

  const deviceHash = getDeviceHash(userAgent, ip);
  const isKnown = isKnownDevice(userId, deviceHash);

  if (isKnown) {
    logger.info(`📱 Known device for user ${userId} - skipping login alert`);
    return { send: false, reason: 'Known device', deviceHash, location };
  }

  // Cooldown check
  const alertKey = `alert-${userId}`;
  const lastAlert = loginAlertCache.get(alertKey);
  const cooldown = config.LOGIN_ALERT.MIN_TIME_BETWEEN * 1000;

  if (lastAlert && (Date.now() - lastAlert) < cooldown) {
    logger.info(`⏰ Cooldown active for user ${userId} - skipping login alert`);
    return { send: false, reason: 'Cooldown active', deviceHash, location };
  }

  // Batch accumulation
  const batchKey = `batch-${userId}`;
  if (!loginAlertCache.has(batchKey)) {
    loginAlertCache.set(batchKey, {
      logins: [],
      firstSeen: Date.now(),
    });
  }

  const batch = loginAlertCache.get(batchKey);
  batch.logins.push({
    ip,
    userAgent,
    deviceInfo,
    location,
    time: Date.now()
  });

  const shouldBatch = batch.logins.length >= config.LOGIN_ALERT.BATCH_SIZE ||
                     (Date.now() - batch.firstSeen) > 3600000;

  if (shouldBatch) {
    loginAlertCache.delete(batchKey);
    return {
      send: true,
      reason: 'Batch ready',
      deviceHash,
      location,
      batch: batch.logins,
      isBatch: true,
    };
  }

  return {
    send: false,
    reason: 'Batching logins',
    deviceHash,
    location,
    batchCount: batch.logins.length,
  };
}

// ── EMAIL TEMPLATES ─────────────────────────────────────────────
function buildTemplate(template, data) {
  const base = (content) => `
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Winners Health</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #1a1a2e; margin: 0; padding: 0; background-color: #f5f5f5; }
          .container { max-width: 600px; margin: 20px auto; padding: 20px; background: #ffffff; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
          .header { text-align: center; padding: 20px 0 15px; border-bottom: 2px solid #e8f0fe; }
          .header h1 { margin: 0; font-size: 28px; color: #2d7a3e; font-weight: 700; }
          .header p { margin: 5px 0 0; color: #666; font-size: 14px; }
          .content { padding: 25px 0; color: #333; }
          .content h1 { color: #2d7a3e; font-size: 24px; margin-top: 0; }
          .badge { display: inline-block; padding: 6px 16px; background: #2d7a3e; color: #ffffff; border-radius: 20px; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
          .btn { display: inline-block; padding: 12px 30px; background: #2d7a3e; color: #ffffff !important; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 15px 0; }
          .btn:hover { background: #1e5e2e; }
          .alert-box { background: #f8f9fa; padding: 15px; border-radius: 8px; border-left: 4px solid #2d7a3e; margin: 15px 0; }
          .divider { border: none; border-top: 1px solid #eee; margin: 20px 0; }
          .order-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
          .order-total { display: flex; justify-content: space-between; padding: 12px 0; font-size: 18px; font-weight: 700; color: #2d7a3e; }
          .device-info { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
          .device-tag { display: inline-block; padding: 4px 12px; background: #e8f0fe; border-radius: 15px; font-size: 13px; color: #1a1a2e; }
          .ip-address { font-family: 'Courier New', monospace; background: #f0f0f0; padding: 2px 8px; border-radius: 4px; }
          .footer { padding: 20px 0 10px; border-top: 1px solid #eee; text-align: center; font-size: 12px; color: #999; }
          .footer a { color: #2d7a3e; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🌿 Winners Health</h1>
            <p>Your trusted partner in health and wellness</p>
          </div>
          <div class="content">${content}</div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} Winners Health. All rights reserved.<br>
            <a href="${process.env.BASE_URL}/unsubscribe">Unsubscribe</a></p>
          </div>
        </div>
      </body>
    </html>
  `;

  switch (template) {
    case 'welcome':
      return base(`
        <h1>Welcome to Winners Health, ${data.name}!</h1>
        <p>We're thrilled to have you join thousands of Nigerians on a journey to better health.</p>
        <p>Please verify your email address to unlock your account:</p>
        <div style="text-align: center; padding: 15px 0;">
          <a href="${data.verifyUrl}" class="btn">Verify My Email</a>
        </div>
        <p style="font-size:13px;color:#8a8a8a;">This link expires in 24 hours. If you didn't create an account, ignore this email.</p>
        <hr class="divider">
        <p>As a welcome gift, use code <strong style="color:#2d6a4f;">WELCOME20</strong> for 20% off your first order.</p>
      `);

    case 'orderConfirmation':
      return base(`
        <div class="badge">✅ Order Confirmed</div>
        <h1 style="margin-top:16px;">Thank you, ${data.name}!</h1>
        <p>Your order <strong>#${data.orderNumber}</strong> has been confirmed and is being processed.</p>
        <hr class="divider">
        ${(data.items || []).map(item => `
          <div class="order-item">
            <span>${item.emoji || '📦'} ${item.name} × ${item.quantity}</span>
            <span>₦${(item.price * item.quantity).toLocaleString()}</span>
          </div>
        `).join('')}
        ${data.discount > 0 ? `<div class="order-item"><span>Discount</span><span style="color:#2d6a4f;">-₦${data.discount.toLocaleString()}</span></div>` : ''}
        <div class="order-item"><span>Shipping</span><span>${data.shipping === 0 ? 'FREE' : '₦' + data.shipping.toLocaleString()}</span></div>
        <div class="order-total"><span>Total Paid</span><span>₦${data.total.toLocaleString()}</span></div>
        <hr class="divider">
        <p><strong>Delivering to:</strong><br>${data.shippingAddress?.street}, ${data.shippingAddress?.city}, ${data.shippingAddress?.state}</p>
        <p>Expected delivery: <strong>3–5 business days</strong></p>
        <div style="text-align: center;">
          <a href="${process.env.BASE_URL}/orders/${data.orderNumber}" class="btn">Track My Order</a>
        </div>
      `);

    case 'passwordReset':
      return base(`
        <h1>Reset Your Password</h1>
        <p>Hi ${data.name}, we received a request to reset your Winners Health password.</p>
        <div style="text-align: center; padding: 15px 0;">
          <a href="${data.resetUrl}" class="btn">Reset Password</a>
        </div>
        <p style="font-size:13px;color:#8a8a8a;">This link expires in <strong>10 minutes</strong>. If you didn't request a reset, you can safely ignore this email.</p>
        <p style="font-size:13px;color:#8a8a8a;">For security, never share this link with anyone.</p>
      `);

    case 'passwordChanged':
      return base(`
        <h1>🔐 Password Changed</h1>
        <p>Hi ${data.name}, your Winners Health account password was successfully changed.</p>
        <p>If you did not make this change, <a href="${process.env.BASE_URL}/contact" style="color:#2d6a4f;">contact our support team immediately</a>.</p>
      `);

    case 'orderShipped':
      return base(`
        <div class="badge">🚚 Order Shipped</div>
        <h1 style="margin-top:16px;">Your order is on its way!</h1>
        <p>Hi ${data.name}, your order <strong>#${data.orderNumber}</strong> has been dispatched.</p>
        <p>Tracking number: <strong>${data.trackingNumber || 'Will be updated shortly'}</strong></p>
        <div style="text-align: center;">
          <a href="${process.env.BASE_URL}/orders/${data.orderNumber}" class="btn">Track My Order</a>
        </div>
      `);

    case 'loginAlert':
      return base(`
        <h1>🔐 ${data.isBatch ? `${data.batchCount || 0} New Logins Detected` : 'New Login Alert'}</h1>
        <p>Hi ${data.name},</p>
        ${data.isBatch ? `
          <p>We detected <strong>${data.batchCount || 0} new logins</strong> to your Winners Health account between ${data.batchStart || 'recently'} and now.</p>
        ` : `
          <p>We noticed a new login to your Winners Health account. If this was you, you can safely ignore this email.</p>
        `}
        <div class="alert-box">
          <strong style="color:#1a3a2a;">Login Details:</strong>
          <div style="margin-top: 10px;">
            <div class="device-info">
              <span class="device-tag">🌐 ${data.browser || 'Unknown Browser'}</span>
              <span class="device-tag">💻 ${data.os || 'Unknown OS'}</span>
              <span class="device-tag">📱 ${data.device || 'Unknown Device'}</span>
            </div>
            <p style="margin-top: 8px;">
              <span style="color:#6b7280;">IP Address:</span>
              <span class="ip-address">${data.ip || 'Unknown IP'}</span>
            </p>
            <p style="margin: 4px 0;">
              <span style="color:#6b7280;">Location:</span>
              <strong>${data.location || 'Unknown Location'}</strong>
            </p>
            <p style="margin: 4px 0;">
              <span style="color:#6b7280;">Time:</span>
              <strong>${data.time || new Date().toLocaleString()}</strong>
            </p>
          </div>
        </div>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:16px 0;">
          <strong style="color:#dc2626;">⚠️ If this wasn't you:</strong>
          <ul style="margin: 8px 0; padding-left: 20px; color: #5a5a5a; font-size: 14px; line-height: 1.8;">
            <li>Change your password immediately</li>
            <li>Contact our support team at <a href="mailto:support@winnershealth.com" style="color:#2d6a4f;">support@winnershealth.com</a></li>
            <li>Enable Two-Factor Authentication for extra security</li>
          </ul>
        </div>
        <hr class="divider">
        <p style="font-size:13px;color:#8a8a8a;">This is an automated security notification. Please do not reply to this email.</p>
      `);

    case 'suspiciousLogin':
      return base(`
        <h1>🚨 Suspicious Login Attempt</h1>
        <p>Hi ${data.name},</p>
        <p>We detected a login attempt from an unrecognized device or location. For your security, we've temporarily locked your account.</p>
        <div class="alert-box" style="border-left-color: #dc2626;">
          <strong style="color:#dc2626;">Suspicious Activity Detected:</strong>
          <div style="margin-top: 10px;">
            <div class="device-info">
              <span class="device-tag">🌐 ${data.browser || 'Unknown Browser'}</span>
              <span class="device-tag">💻 ${data.os || 'Unknown OS'}</span>
              <span class="device-tag">📱 ${data.device || 'Unknown Device'}</span>
            </div>
            <p style="margin-top: 8px;">
              <span style="color:#6b7280;">IP Address:</span>
              <span class="ip-address">${data.ip || 'Unknown IP'}</span>
            </p>
            <p style="margin: 4px 0;">
              <span style="color:#6b7280;">Location:</span>
              <strong>${data.location || 'Unknown Location'}</strong>
            </p>
            <p style="margin: 4px 0;">
              <span style="color:#6b7280;">Time:</span>
              <strong>${data.time || new Date().toLocaleString()}</strong>
            </p>
          </div>
        </div>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:16px 0;">
          <strong style="color:#dc2626;">⚠️ Action Required:</strong>
          <ul style="margin: 8px 0; padding-left: 20px; color: #5a5a5a; font-size: 14px; line-height: 1.8;">
            <li><strong>Immediately change your password</strong></li>
            <li>Review your recent activity in account settings</li>
            <li>Contact support if you need assistance</li>
          </ul>
        </div>
        <div style="text-align: center;">
          <a href="${process.env.BASE_URL}/reset-password" class="btn">Change Password Now</a>
        </div>
        <hr class="divider">
        <p style="font-size:13px;color:#8a8a8a;">If this was you, you can ignore this email and your account will remain secure.</p>
      `);

    case 'batchedLoginAlert': {
      const loginItems = (data.logins || []).map((login, index) => `
        <div style="background: #f8f9fa; padding: 12px; margin: 10px 0; border-radius: 6px; border-left: 3px solid #2d7a3e;">
          <strong>Login #${index + 1}</strong><br>
          📍 Location: ${login.location || 'Unknown'}<br>
          🌐 IP: ${login.ip || 'Unknown'}<br>
          🕐 Time: ${new Date(login.time).toLocaleString()}<br>
          📱 Device: ${login.deviceInfo?.device?.type || 'Unknown'}
        </div>
      `).join('');

      return base(`
        <h1>🔐 ${data.logins?.length || 0} New Logins Detected</h1>
        <p>Hi ${data.name},</p>
        <p>We detected <strong>${data.logins?.length || 0} new logins</strong> to your Winners Health account between ${new Date(data.batchStart || Date.now()).toLocaleString()} and ${new Date().toLocaleString()}.</p>
        ${loginItems}
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:16px 0;">
          <strong style="color:#dc2626;">⚠️ If any of these weren't you:</strong>
          <ul style="margin: 8px 0; padding-left: 20px; color: #5a5a5a; font-size: 14px; line-height: 1.8;">
            <li>Change your password immediately</li>
            <li>Contact our support team</li>
          </ul>
        </div>
        <hr class="divider">
        <p style="font-size:13px;color:#8a8a8a;">This is an automated security notification.</p>
      `);
    }

    default:
      return base(`
        <h1>Hello ${data.name || 'Valued Customer'}</h1>
        <p>${data.message || 'Thank you for being part of Winners Health.'}</p>
      `);
  }
}

// ── SEND EMAIL WITH PROVIDER ──────────────────────────────────

async function sendEmailWithProvider({ to, subject, html, priority, data }) {
  const senderEmail = process.env.EMAIL_FROM_ADDRESS || process.env.SENDER_EMAIL;
  const senderName = process.env.EMAIL_FROM_NAME || process.env.SENDER_NAME || 'Winners Health';

  if (!senderEmail) {
    throw new Error('EMAIL_FROM_ADDRESS or SENDER_EMAIL must be set');
  }

  // Try Brevo first
  const brevoClient = getBrevoClient();
  if (brevoClient) {
    try {
      const result = await brevoClient.transactionalEmails.sendTransacEmail({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: to }],
        replyTo: { name: senderName, email: senderEmail },
        subject,
        htmlContent: html,
      });

      emailCount.sentToday++;
      if (priority === config.PRIORITY.CRITICAL) {
        emailCount.criticalUsed++;
      }

      logger.info(`✅ Email sent via Brevo (${emailCount.sentToday}/${config.DAILY_LIMITS.TOTAL}): ${subject} to ${to}`);
      return { success: true, provider: 'brevo', result };
    } catch (error) {
      logger.warn(`⚠️ Brevo failed, trying SendGrid: ${error.message}`);
    }
  }

  // Fallback to SendGrid
  const sendgrid = getSendGridClient();
  if (sendgrid) {
    try {
      const msg = {
        to,
        from: { email: senderEmail, name: senderName },
        subject,
        html,
      };

      const result = await sendgrid.send(msg);

      emailCount.sentToday++;
      if (priority === config.PRIORITY.CRITICAL) {
        emailCount.criticalUsed++;
      }

      logger.info(`✅ Email sent via SendGrid (${emailCount.sentToday}/${config.DAILY_LIMITS.TOTAL}): ${subject} to ${to}`);
      return { success: true, provider: 'sendgrid', result };
    } catch (error) {
      logger.error(`❌ SendGrid also failed: ${error.message}`);
      throw error;
    }
  }

  throw new Error('No email provider configured (Brevo or SendGrid)');
}

// ── MAIN SEND FUNCTION ─────────────────────────────────────────
async function sendEmail({ to, subject, template, data, html, priority = config.PRIORITY.NORMAL }) {
  resetDailyCounter();

  // Build HTML if template provided
  let emailHtml = html;
  if (!emailHtml && template) {
    emailHtml = buildTemplate(template, data || {});
  } else if (!emailHtml) {
    emailHtml = buildTemplate('default', data || {});
  }

  // Check if we can send now
  if (!canSendEmail(priority)) {
    queueEmail({ to, subject, html: emailHtml, priority, data });
    return {
      success: true,
      queued: true,
      message: `Email queued for later (${emailQueue.high.length + emailQueue.normal.length + emailQueue.low.length} in queue)`
    };
  }

  return sendEmailWithProvider({ to, subject, html: emailHtml, priority, data });
}

// ── SMART LOGIN ALERT ──────────────────────────────────────────
async function sendLoginAlert(userId, email, name, ip, userAgent, loginData = {}) {
  const analysis = shouldSendLoginAlert(userId, ip, userAgent);

  if (!analysis.send) {
    if (analysis.deviceHash) {
      const deviceDetector = new DeviceDetector();
      const deviceInfo = deviceDetector.parse(userAgent);
      addKnownDevice(userId, analysis.deviceHash, {
        deviceInfo,
        ip,
        lastSeen: Date.now(),
      });
    }
    logger.info(`⏭️ Login alert skipped for ${email}: ${analysis.reason}`);
    return { sent: false, reason: analysis.reason };
  }

  // Update known devices
  if (analysis.deviceHash) {
    const deviceDetector = new DeviceDetector();
    const deviceInfo = deviceDetector.parse(userAgent);
    addKnownDevice(userId, analysis.deviceHash, {
      deviceInfo,
      ip,
      lastSeen: Date.now(),
    });
  }

  // Update alert cooldown
  loginAlertCache.set(`alert-${userId}`, Date.now());

  // Build data for template
  const deviceDetector = new DeviceDetector();
  const deviceInfo = deviceDetector.parse(userAgent);

  const templateData = {
    name,
    ip,
    location: analysis.location,
    browser: deviceInfo?.client?.name || 'Unknown Browser',
    os: deviceInfo?.os?.name || 'Unknown OS',
    device: deviceInfo?.device?.type || 'Unknown Device',
    time: new Date().toLocaleString(),
    isBatch: analysis.isBatch || false,
    batchCount: analysis.batch?.length || 0,
    batchStart: analysis.batch?.[0]?.time ? new Date(analysis.batch[0].time).toLocaleString() : null,
  };

  // If batch, use batched template
  const templateName = analysis.isBatch ? 'batchedLoginAlert' : 'loginAlert';

  if (analysis.isBatch) {
    templateData.logins = analysis.batch;
  }

  const subject = analysis.isBatch
    ? `🔐 ${analysis.batch?.length || 0} New Logins to Your Account`
    : '🔐 New Login to Your Account';

  return sendEmail({
    to: email,
    subject,
    template: templateName,
    data: templateData,
    priority: config.PRIORITY.NORMAL,
  });
}

// ── HELPER: Send suspicious login alert ────────────────────────
async function sendSuspiciousLoginAlert(email, name, loginData) {
  return sendEmail({
    to: email,
    subject: '🚨 Suspicious Login Attempt on Your Winners Health Account',
    template: 'suspiciousLogin',
    data: {
      name,
      browser: loginData?.browser || 'Unknown Browser',
      os: loginData?.os || 'Unknown OS',
      device: loginData?.device || 'Unknown Device',
      ip: loginData?.ip || 'Unknown IP',
      location: loginData?.location || 'Unknown Location',
      time: loginData?.time || new Date().toLocaleString(),
    },
    priority: config.PRIORITY.IMPORTANT,
  });
}

// ── TEST FUNCTION ──────────────────────────────────────────────
async function testEmail() {
  const testEmailAddress = process.env.TEST_EMAIL || process.env.EMAIL_FROM_ADDRESS || process.env.SENDER_EMAIL;

  if (!testEmailAddress) {
    throw new Error('TEST_EMAIL, EMAIL_FROM_ADDRESS, or SENDER_EMAIL must be set');
  }

  logger.info('📧 Testing email configuration...');
  logger.info(`📧 Sender: ${process.env.EMAIL_FROM_ADDRESS || process.env.SENDER_EMAIL || 'Not set'}`);
  logger.info(`📧 Brevo API Key: ${process.env.BREVO_API_KEY ? '✅ Set' : '❌ Not set'}`);
  logger.info(`📧 SendGrid API Key: ${process.env.SENDGRID_API_KEY ? '✅ Set' : '❌ Not set'}`);
  logger.info(`📧 Test recipient: ${testEmailAddress}`);

  return sendEmail({
    to: testEmailAddress,
    subject: '✅ Email Test - Winners Health',
    template: 'passwordChanged',
    data: { name: 'Test User' },
    priority: config.PRIORITY.CRITICAL,
  });
}

// ── GET STATS ──────────────────────────────────────────────────
function getEmailStats() {
  resetDailyCounter();
  return {
    sentToday: emailCount.sentToday,
    limit: config.DAILY_LIMITS.TOTAL,
    remaining: config.DAILY_LIMITS.TOTAL - emailCount.sentToday,
    criticalUsed: emailCount.criticalUsed,
    criticalReserve: config.DAILY_LIMITS.CRITICAL_RESERVE,
    queued: emailQueue.high.length + emailQueue.normal.length + emailQueue.low.length,
    providers: {
      brevo: !!getBrevoClient(),
      sendgrid: !!getSendGridClient(),
    },
  };
}

// ── CRON JOBS ──────────────────────────────────────────────────
// Process queue every 20 minutes
cron.schedule('*/20 * * * *', () => {
  logger.info('🔄 Running scheduled queue processing...');
  if (!emailQueue.isProcessing) {
    processQueue();
  }
});

// Reset batch cache every hour
cron.schedule('0 * * * *', () => {
  const now = Date.now();
  for (const [key, value] of loginAlertCache) {
    if (key.startsWith('batch-') && (now - value.firstSeen) > 3600000) {
      if (value.logins.length > 0) {
        // Send batch alert for any pending logins
        logger.info(`📦 Sending batch alert for ${value.logins.length} pending logins`);
        // Note: This would need user data - consider storing userId in batch
      }
      loginAlertCache.delete(key);
    }
  }
});

// ── EXPORTS ────────────────────────────────────────────────────
module.exports = {
  sendEmail,
  testEmail,
  sendLoginAlert,
  sendSuspiciousLoginAlert,
  getEmailStats,
  config,
  PRIORITY: config.PRIORITY,
};