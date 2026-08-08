const brevo = require('@getbrevo/brevo');

const apiInstance = new brevo.TransactionalEmailsApi();
apiInstance.setApiKey(
  brevo.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

const SENDER = {
  email: process.env.BREVO_SENDER_EMAIL,
  name: process.env.BREVO_SENDER_NAME,
};

/**
 * Generic sender — everything below funnels through this.
 * Use templateId + params when you have a Brevo drag-and-drop template,
 * or htmlContent for one-off/static bodies.
 */
async function sendTransactionalEmail({ to, subject, templateId, params, htmlContent, tags }) {
  const email = new brevo.SendSmtpEmail();
  email.sender = SENDER;
  email.to = Array.isArray(to) ? to : [to];
  email.subject = subject;
  if (tags) email.tags = tags;

  if (templateId) {
    email.templateId = templateId;
    email.params = params || {};
  } else {
    email.htmlContent = htmlContent;
  }

  try {
    const result = await apiInstance.sendTransacEmail(email);
    return result;
  } catch (err) {
    console.error('Brevo send failed:', err?.response?.body || err.message);
    throw err;
  }
}

module.exports = { sendTransactionalEmail, apiInstance };