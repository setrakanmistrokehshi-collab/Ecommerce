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
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="card">
          <div class="logo">🌿 Winners Health</div>
          ${content}
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
      <h1>Welcome to VitaCore, ${data.name}!</h1>
      <p>We're thrilled to have you join thousands of Nigerians on a journey to better health.</p>
      <p>Please verify your email address to unlock your account:</p>
      <a href="${data.verifyUrl}" class="btn">Verify My Email</a>
      <p style="font-size:13px;color:#8a8a8a;">This link expires in 24 hours. If you didn't create an account, ignore this email.</p>
      <hr class="divider">
      <p>As a welcome gift, use code <strong style="color:#2d6a4f;">WELCOME20</strong> for 20% off your first order.</p>
    `),

    orderConfirmation: base(`
      <div class="badge">Order Confirmed</div>
      <h1 style="margin-top:16px;">Thank you, ${data.name}!</h1>
      <p>Your order <strong>#${data.orderNumber}</strong> has been confirmed and is being processed.</p>
      <hr class="divider">
      ${(data.items || []).map(item => `
        <div class="order-item">
          <span>${item.name} × ${item.quantity}</span>
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
      <h1>Password Changed</h1>
      <p>Hi ${data.name}, your Winners Health account password was successfully changed.</p>
      <p>If you did not make this change, <a href="${process.env.BASE_URL}/contact" style="color:#2d6a4f;">contact our support team immediately</a>.</p>
    `),

    orderShipped: base(`
      <div class="badge">Order Shipped</div>
      <h1 style="margin-top:16px;">Your order is on its way!</h1>
      <p>Hi ${data.name}, your order <strong>#${data.orderNumber}</strong> has been dispatched.</p>
      <p>Tracking number: <strong>${data.trackingNumber || 'Will be updated shortly'}</strong></p>
      <a href="${process.env.BASE_URL}/orders/${data.orderNumber}" class="btn">Track My Order</a>
    `),

    lowStock: base(`
      <h1>Low Stock Alert</h1>
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
  };

  return templates[template]
    || base(`<h1>Hello ${data.name || ''}</h1><p>${data.message || ''}</p>`);
}

// ── SEND FUNCTION ─────────────────────────────────────────────────
async function sendEmail({ to, subject, template, data, html }) {
  try {
    const client   = getClient();
    const emailHtml = html || buildTemplate(template, data || {});

    const message = new Brevo.SendSmtpEmail();
    message.sender  = {
      name:  process.env.EMAIL_FROM_NAME    || 'Winners Health',
      email: process.env.EMAIL_FROM_ADDRESS || 'no-reply@winnershealth.ng',
    };
    message.to      = [{ email: to }];
    message.subject = subject;
    message.htmlContent = emailHtml;

    const response = await client.sendTransacEmail(message);

    logger.info(`Email sent to ${to}: "${subject}" [messageId: ${response.body?.messageId}]`);
    return response;
  } catch (err) {
    logger.error(`Email failed to ${to}: ${err.message}`);
    throw err;
  }
}

module.exports = { sendEmail };