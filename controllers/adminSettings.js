'use strict';
// controllers/adminSettings.js
// Powers:
//   GET  /api/v1/admin/settings
//   POST /api/v1/admin/settings

const Settings = require('../models/Settings');
const logger   = require('../utils/logger');

/**
 * GET /api/v1/admin/settings
 * Returns the store settings document. Creates defaults if none exist.
 */
async function getSettings(req, res) {
  try {
    let settings = await Settings.findById('store_settings').lean();

    if (!settings) {
      // First boot — create defaults
      settings = await Settings.create({ _id: 'store_settings' });
    }

    // Never return payment secrets to the client — return masked versions
    const safe = {
      ...settings,
      payments: {
        nombaPublicKey:  settings.payments?.nombaPublicKey  ? '***' : '',
        webhookSecret:   settings.payments?.webhookSecret   ? '***' : '',
      },
      email: {
        ...settings.email,
        // smtpPass is never stored in DB — not returned
      },
    };

    res.json({ success: true, data: safe });
  } catch (err) {
    logger.error('getSettings error:', err);
    res.status(500).json({ success: false, error: 'Failed to load settings' });
  }
}

/**
 * POST /api/v1/admin/settings
 * Upserts the settings document. Sensitive fields only updated if non-empty/non-masked.
 */
async function updateSettings(req, res) {
  try {
    const { store, shipping, notifications, email, payments } = req.body;

    // Build update object — only include fields sent
    const update = {};

    if (store) {
      update['store.name']     = store.name;
      update['store.email']    = store.email;
      update['store.phone']    = store.phone;
      update['store.address']  = store.address;
      update['store.currency'] = store.currency;
      update['store.nafdac']   = store.nafdac;
      update['store.cac']      = store.cac;
    }

    if (shipping?.zones) {
      update['shipping.zones'] = shipping.zones;
    }

    if (notifications) {
      Object.entries(notifications).forEach(([key, val]) => {
        update[`notifications.${key}`] = val;
      });
    }

    if (email) {
      if (email.smtpHost) update['email.smtpHost'] = email.smtpHost;
      if (email.smtpPort) update['email.smtpPort'] = email.smtpPort;
      if (email.smtpUser) update['email.smtpUser'] = email.smtpUser;
      // smtpPass goes to env/secrets manager, never stored in DB
    }

    // Only update payment keys if they are real values (not '***' masked placeholders)
    if (payments) {
      if (payments.nombaPublicKey && payments.nombaPublicKey !== '***') {
        update['payments.nombaPublicKey'] = payments.nombaPublicKey;
      }
      if (payments.webhookSecret && payments.webhookSecret !== '***') {
        update['payments.webhookSecret'] = payments.webhookSecret;
      }
    }

    const settings = await Settings.findByIdAndUpdate(
      'store_settings',
      { $set: update },
      { upsert: true, new: true, runValidators: true }
    );

    logger.info(`Settings updated by admin ${req.user._id}`);
    res.json({ success: true, message: 'Settings saved', data: settings });
  } catch (err) {
    logger.error('updateSettings error:', err);
    res.status(500).json({ success: false, error: 'Failed to save settings' });
  }
}

module.exports = { getSettings, updateSettings };
