'use strict';

const Brevo = require('@getbrevo/brevo');
const logger = require('./logger');

// ── BREVO CLIENT ──────────────────────────────────────────────────
let apiInstance;

function getClient() {
  if (apiInstance) return apiInstance;

  const defaultClient = Brevo.ApiClient.instance;
  defaultClient.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;

  apiInstance = new Brevo.TransactionalEmailsApi();
  return apiInstance;
}

// ── EMAIL TEMPLATES ───────────────────────────────────────────────
function buildTemplate(template, data) {
  const base = (content) => `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: 'DM Sans', Arial, sans-serif; background: #faf7f2; margin: 0; padding: 0; color: #1a1a1a; }
        .wrapper { max-width: 600px; margin: 0 auto; padding: 32px 16px; }
        .card { background: #ffffff; border-radius: 16px; padding: 40px; border: 1px solid #e2ddd4; }
        .logo { font-size: 24px; font-weight: 700; color: #1a3a2a; margin-bottom: 28px; }
        h1 { font-size: 26px; font-weight: 700; color: #1a3a2a; margin: 0 0 12px; }
        p { font-size: 15px; line-height: 1.7; color: #5a5a5a; margin: 0 0 16px; }
        .btn { display: inline-block; background: #2d6a4f; color: #ffffff !important; text-decoration: none; padding: 14px 32px; border-radius: 999px; font-size: 15px; font-weight: 600; margin: 16px 0; }
        .divider { border: none; border-top: 1px solid #e2ddd4; margin: 24px 0; }
        .order-item { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f0ebe0; font-size: 14px; }
        .order-total { display: flex; justify-content: space-between; padding: 14px 0 0; font-size: 16px; font-weight: 700; color: #1a3a2a; }
        .footer { text-align: center; font-size: 12px; color: #8a8a8a; margin-top: 24px; line-height: 1.8; }
        .badge { background: #d8f3dc; color: #2d6a4f; border-radius: 999px; padding: 4px 14px; font-size: 12px; font-weight: 600; display: inline-block; }
        .email-note { font-size: 12px; color: #8a8a8a; background: #f5f5f5; padding: 8px 12px; border-radius: 6px; margin-top: 12px; }
        .alert-box { background: #fff8f0; border-left: 4px solid #f59e0b; padding: 16px; margin: 16px 0; border-radius: 8px; }
        .device-info { display: flex; gap: 8px; flex-wrap: wrap; margin: 4px 0; }
        .device-tag { background: #f0f0f0; padding: 4px 12px; border-radius: 999px; font-size: 13px; }
        .ip-address { font-family: monospace; background: #f0f0f0; padding: 4px 12px; border-radius: 4px; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="card">
          <div class="logo">🌿 Winners Health</div>
          ${content}
          <div class="email-note">
            This email was sent from ${process.env.EMAIL_FROM_ADDRESS || 'Winners Health'}
          </div>
        </div>
        <div class="footer">
          © ${new Date().getFullYear()} Winners Health · Lagos, Nigeria<br>
          <a href="${process.env.BASE_URL}/unsubscribe" style="color:#8a8a8a;">Unsubscribe</a>
        </div>
      </div>
    </body>
    </html>
  `;

  const templates = {
    welcome: base(`
      <h1>Welcome to Winners Health, ${data.name}!</h1>
      <p>We're thrilled to have you join thousands of Nigerians on a journey to better health.</p>
      <p>Please verify your email address to unlock your account:</p>
      <a href="${data.verifyUrl}" class="btn">Verify My Email</a>
      <p style="font-size:13px;color:#8a8a8a;">This link expires in 24 hours. If you didn't create an account, ignore this email.</p>
      <hr class="divider">
      <p>As a welcome gift, use code <strong style="color:#2d6a4f;">WELCOME20</strong> for 20% off your first order.</p>
    `),

    orderConfirmation: base(`
      <div class="badge">✅ Order Confirmed</div>
      <h1 style="margin-top:16px;">Thank you, ${data.name}!</h1>
      <p>Your order <strong>#${data.orderNumber}</strong> has been confirmed and is being processed.</p>
      <hr class="divider">
      ${(data.items || []).map(item => `
        <div class="order-item">
          <span>${item.emoji || ''} ${item.name} × ${item.quantity}</span>
          <span>₦${(item.price * item.quantity).toLocaleString()}</span>
        </div>
      `).join('')}
      ${data.discount > 0
        ? `<div class="order-item"><span>Discount</span><span style="color:#2d6a4f;">-₦${data.discount.toLocaleString()}</span></div>`
        : ''}
      <div class="order-item">
        <span>Shipping</span>
        <span>${data.shipping === 0 ? 'FREE' : '₦' + data.shipping.toLocaleString()}</span>
      </div>
      <div class="order-total">
        <span>Total Paid</span>
        <span>₦${data.total.toLocaleString()}</span>
      </div>
      <hr class="divider">
      <p><strong>Delivering to:</strong><br>
        ${data.shippingAddress?.street}, ${data.shippingAddress?.city}, ${data.shippingAddress?.state}
      </p>
      <p>Expected delivery: <strong>3–5 business days</strong></p>
      <a href="${process.env.BASE_URL}/orders/${data.orderNumber}" class="btn">Track My Order</a>
    `),

    passwordReset: base(`
      <h1>Reset Your Password</h1>
      <p>Hi ${data.name}, we received a request to reset your Winners Health password.</p>
      <a href="${data.resetUrl}" class="btn">Reset Password</a>
      <p style="font-size:13px;color:#8a8a8a;">
        This link expires in <strong>10 minutes</strong>.
        If you didn't request a reset, you can safely ignore this email.
      </p>
      <p style="font-size:13px;color:#8a8a8a;">For security, never share this link with anyone.</p>
    `),

    passwordChanged: base(`
      <h1>🔐 Password Changed</h1>
      <p>Hi ${data.name}, your Winners Health account password was successfully changed.</p>
      <p>If you did not make this change, <a href="${process.env.BASE_URL}/contact" style="color:#2d6a4f;">contact our support team immediately</a>.</p>
    `),

    orderShipped: base(`
      <div class="badge">🚚 Order Shipped</div>
      <h1 style="margin-top:16px;">Your order is on its way!</h1>
      <p>Hi ${data.name}, your order <strong>#${data.orderNumber}</strong> has been dispatched.</p>
      <p>Tracking number: <strong>${data.trackingNumber || 'Will be updated shortly'}</strong></p>
      <a href="${process.env.BASE_URL}/orders/${data.orderNumber}" class="btn">Track My Order</a>
    `),

    lowStock: base(`
      <h1>⚠️ Low Stock Alert</h1>
      <p>The following product is running low and needs attention:</p>
      <div style="background:#fff8f0;border:1px solid #f0e0c8;border-radius:10px;padding:16px;margin:16px 0;">
        <strong style="font-size:16px;color:#1a3a2a;">${data.productName}</strong><br>
        <span style="color:#c8854a;font-size:14px;font-weight:600;">
          ${data.currentStock} units remaining
        </span>
        <span style="color:#8a8a8a;font-size:13px;">
          (threshold: ${data.threshold})
        </span>
      </div>
      <a href="${process.env.BASE_URL}/admin/products/${data.productId}" class="btn">Update Stock</a>
    `),

    // ✅ NEW: Login Alert Template
    loginAlert: base(`
      <h1>🔐 New Login Detected</h1>
      <p>Hi ${data.name},</p>
      <p>We noticed a new login to your Winners Health account. If this was you, you can safely ignore this email.</p>
      
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
      <p style="font-size:13px;color:#8a8a8a;">
        This is an automated security notification. Please do not reply to this email.
      </p>
    `),

    // ✅ NEW: Suspicious Login Alert (stricter warning)
    suspiciousLogin: base(`
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

      <a href="${process.env.BASE_URL}/reset-password" class="btn">Change Password Now</a>

      <hr class="divider">
      <p style="font-size:13px;color:#8a8a8a;">
        If this was you, you can ignore this email and your account will remain secure.
      </p>
    `),
  };

  return templates[template]
    || base(`<h1>Hello ${data.name || ''}</h1><p>${data.message || ''}</p>`);
}

// ── SEND FUNCTION ─────────────────────────────────────────────────
async function sendEmail({ to, subject, template, data, html }) {
  try {
    if (!process.env.BREVO_API_KEY) {
      throw new Error('BREVO_API_KEY is not set in environment variables');
    }

    const senderEmail = process.env.EMAIL_FROM_ADDRESS || 'your-verified-email@gmail.com';
    const senderName = process.env.EMAIL_FROM_NAME || 'Winners Health';

    if (!senderEmail || senderEmail === 'your-verified-email@gmail.com') {
      logger.warn('⚠️  Using default sender email. Please set EMAIL_FROM_ADDRESS in .env');
    }

    const client = getClient();
    const emailHtml = html || buildTemplate(template, data || {});

    const message = new Brevo.SendSmtpEmail();
    message.sender = {
      name: senderName,
      email: senderEmail,
    };
    message.to = [{ email: to }];
    message.subject = subject;
    message.htmlContent = emailHtml;
    
    message.replyTo = {
      email: senderEmail,
      name: senderName,
    };

    logger.info(`📧 Sending email to ${to}: "${subject}"`);

    const response = await client.sendTransacEmail(message);

    logger.info(`✅ Email sent to ${to}: "${subject}" [messageId: ${response.body?.messageId}]`);
    return response;

  } catch (err) {
    logger.error(`❌ Email failed to ${to}: ${err.message}`);
    
    if (err.response) {
      logger.error(`📋 Brevo API Error Response: ${JSON.stringify(err.response.body || err.response.text)}`);
      
      if (err.response.body?.message?.includes('sender')) {
        logger.error('⚠️  Sender email not verified. Please verify your email in Brevo Dashboard → Senders & Domains → Senders');
      }
      if (err.response.body?.message?.includes('API key')) {
        logger.error('⚠️  Invalid BREVO_API_KEY. Please check your API key in Brevo Dashboard → SMTP & API → API Keys');
      }
      if (err.response.body?.message?.includes('credits')) {
        logger.error('⚠️  Insufficient credits. Please check your Brevo plan and credit balance.');
      }
    }

    throw err;
  }
}

// ── HELPER: Send login alert ──────────────────────────────────────
async function sendLoginAlert(email, name, loginData) {
  return sendEmail({
    to: email,
    subject: '🔐 New Login to Your Winners Health Account',
    template: 'loginAlert',
    data: {
      name: name,
      browser: loginData?.browser || 'Unknown Browser',
      os: loginData?.os || 'Unknown OS',
      device: loginData?.device || 'Unknown Device',
      ip: loginData?.ip || 'Unknown IP',
      location: loginData?.location || 'Unknown Location',
      time: loginData?.time || new Date().toLocaleString(),
    },
  });
}

// ── HELPER: Send suspicious login alert ──────────────────────────
async function sendSuspiciousLoginAlert(email, name, loginData) {
  return sendEmail({
    to: email,
    subject: '🚨 Suspicious Login Attempt on Your Winners Health Account',
    template: 'suspiciousLogin',
    data: {
      name: name,
      browser: loginData?.browser || 'Unknown Browser',
      os: loginData?.os || 'Unknown OS',
      device: loginData?.device || 'Unknown Device',
      ip: loginData?.ip || 'Unknown IP',
      location: loginData?.location || 'Unknown Location',
      time: loginData?.time || new Date().toLocaleString(),
    },
  });
}

// ── HELPER: Test email function ──────────────────────────────────
async function testEmail() {
  console.log('📧 Testing Brevo email configuration...');
  console.log(`📧 Sender: ${process.env.EMAIL_FROM_ADDRESS || 'Not set'}`);
  console.log(`📧 API Key: ${process.env.BREVO_API_KEY ? '✅ Set' : '❌ Not set'}`);
  
  try {
    const result = await sendEmail({
      to: process.env.TEST_EMAIL || 'your-email@gmail.com',
      subject: '✅ Brevo Test Email',
      template: 'passwordChanged',
      data: { name: 'Test User' },
    });
    console.log('✅ Test email sent successfully!');
    console.log('📧 Message ID:', result.body?.messageId);
    return result;
  } catch (err) {
    console.error('❌ Test email failed:', err.message);
    throw err;
  }
}

module.exports = { 
  sendEmail, 
  testEmail,
  sendLoginAlert,
  sendSuspiciousLoginAlert,
};