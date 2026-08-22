'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

// ── CONFIGURATION (same source of truth webhooks.js was using) ───────────
const MONNIFY_BASE_URL =
  process.env.MONNIFY_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? 'https://api.monnify.com' : 'https://sandbox.monnify.com');

const MONNIFY_API_KEY = process.env.MONNIFY_API_KEY;
const MONNIFY_SECRET_KEY = process.env.MONNIFY_SECRET_KEY;
const MONNIFY_CONTRACT_CODE = process.env.MONNIFY_CONTRACT_CODE;

// ── ACCESS TOKEN (cached — unchanged from your webhooks.js) ──────────────
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getMonnifyAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  try {
    const credentials = Buffer.from(`${MONNIFY_API_KEY}:${MONNIFY_SECRET_KEY}`).toString('base64');
    logger.info('monnifyclient: requesting access token', { baseUrl: MONNIFY_BASE_URL });
    const response = await axios.post(
      `${MONNIFY_BASE_URL}/api/v1/auth/login`,
      {},
      { headers: { Authorization: `Basic ${credentials}` }, timeout: 15000 }
    );
    logger.info('monnifyclient: access token request completed');

    const { accessToken, expiresIn } = response.data.responseBody;
    cachedToken = accessToken;
    cachedTokenExpiry = Date.now() + Math.max(expiresIn - 90, 30) * 1000;
    return cachedToken;
  } catch (error) {
    logger.error('❌ Failed to fetch Monnify access token', { error: error.message });
    cachedToken = null;
    cachedTokenExpiry = 0;
    throw error; // let the caller decide how to fail — swallowing this in
                 // initializeTransaction would silently break checkout
  }
}

// ── INITIALIZE TRANSACTION (new — was missing entirely) ──────────────────
/**
 * @param {Object} params
 * @param {number} params.amount - Naira, decimal (NOT kobo). Server-computed.
 * @param {string} params.paymentReference - Unique per attempt.
 * @param {string} params.customerName
 * @param {string} params.customerEmail
 * @param {string} params.paymentDescription
 * @param {string} params.redirectUrl
 * @param {Object} [params.metaData]
 */
async function initializeTransaction({
  amount,
  paymentReference,
  customerName,
  customerEmail,
  paymentDescription,
  redirectUrl,
  metaData = {},
}) {
  if (!amount || !paymentReference || !customerEmail || !redirectUrl) {
    throw new Error('initializeTransaction: missing required fields');
  }

  const accessToken = await getMonnifyAccessToken();

  const payload = {
    amount,
    customerName: customerName || 'Customer',
    customerEmail,
    paymentReference,
    paymentDescription: paymentDescription || `Order ${paymentReference}`,
    currencyCode: 'NGN',
    contractCode: MONNIFY_CONTRACT_CODE,
    redirectUrl,
    metaData,
  };

  const response = await axios.post(
    `${MONNIFY_BASE_URL}/api/v1/merchant/transactions/init-transaction`,
    payload,
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }
  );

  const body = response.data.responseBody;
  if (!body?.checkoutUrl) {
    throw new Error(response.data.responseMessage || 'Monnify did not return a checkoutUrl');
  }

  // Per Monnify's own docs warning: confirm the response matches what was
  // sent, in case of a tampered proxy between us and Monnify.
  const returnedAmount = Number(body.amount);
  if (Number.isFinite(returnedAmount) && Math.abs(returnedAmount - amount) > 0.01) {
    logger.error('🚨 Monnify init-transaction returned a mismatched amount', {
      sent: amount,
      received: returnedAmount,
      paymentReference,
    });
    throw new Error('Amount mismatch on transaction initialization response — aborting');
  }

  return {
    checkoutUrl: body.checkoutUrl,
    transactionReference: body.transactionReference,
    paymentReference: body.paymentReference,
  };
}

// ── SERVER-SIDE VERIFICATION (unchanged from your webhooks.js) ───────────
// NOTE: double-check this path against your Postman collection / API
// reference before relying on it — see accompanying notes.
async function verifyTransaction(paymentReference) {
  const accessToken = await getMonnifyAccessToken();

  const response = await axios.get(`${MONNIFY_BASE_URL}/api/v2/merchant/transactions/query`, {
    params: { paymentReference },
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });

  const body = response.data.responseBody;
  return {
    paymentStatus: body.paymentStatus,
    amountPaid: Number(body.amountPaid || 0), // Naira, decimal — NOT kobo
    totalPayable: Number(body.totalPayable || 0),
    settlementAmount: Number(body.settlementAmount || 0),
    paymentMethod: body.paymentMethod,
    transactionReference: body.transactionReference,
    paymentSourceInformation: body.paymentSourceInformation,
  };
}

// ── OVERPAYMENT / UNDERPAYMENT GUARD (unchanged from your webhooks.js) ───
function evaluatePaymentAmount({ expectedKobo, amountPaidNaira }) {
  if (!Number.isFinite(expectedKobo) || expectedKobo <= 0) {
    return { verdict: 'invalid', reason: 'Invalid expected amount on order' };
  }

  const paidKobo = Math.round(Number(amountPaidNaira) * 100);
  if (!Number.isFinite(paidKobo)) {
    return { verdict: 'invalid', reason: `Unparseable amountPaid: ${amountPaidNaira}` };
  }

  const diff = paidKobo - expectedKobo;
  if (Math.abs(diff) <= 1) {
    return { verdict: 'exact', paidKobo, expectedKobo, diffKobo: 0 };
  }
  if (diff < 0) {
    return { verdict: 'underpaid', paidKobo, expectedKobo, shortfallKobo: -diff };
  }
  return { verdict: 'overpaid', paidKobo, expectedKobo, excessKobo: diff };
}

module.exports = {
  getMonnifyAccessToken,
  initializeTransaction,
  verifyTransaction,
  evaluatePaymentAmount,
  MONNIFY_BASE_URL,
};