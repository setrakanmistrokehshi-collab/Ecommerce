'use strict';
const { BrevoClient } = require("@getbrevo/brevo");

const client = new BrevoClient({ apiKey: process.env.BREVO_API_KEY });

const SENDER = {
  email: process.env.BREVO_SENDER_EMAIL,
  name: process.env.BREVO_SENDER_NAME,
};

async function sendTransactionalEmail({ to, subject, templateId, params, htmlContent, tags }) {
  const payload = {
    sender: SENDER,
    to: Array.isArray(to) ? to : [to],
    subject,
    ...(tags && { tags }),
    ...(templateId ? { templateId, params: params || {} } : { htmlContent }),
  };

  try {
    return await client.transactionalEmails.sendTransacEmail(payload);
  } catch (err) {
    console.error('Brevo send failed:', err?.body || err.message);
    throw err;
  }
}

module.exports = { sendTransactionalEmail, client };