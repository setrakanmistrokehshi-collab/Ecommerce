'use strict';
// models/Settings.js
// Singleton document — only one settings record ever exists.

const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    // Only one settings doc — enforced by this constant key
    _id: { type: String, default: 'store_settings' },

    store: {
      name:    { type: String, default: 'Winners Health' },
      email:   { type: String, default: 'admin@winners.ng' },
      phone:   { type: String, default: '' },
      address: { type: String, default: 'Lagos, Nigeria' },
      currency:{ type: String, default: 'NGN' },
      nafdac:  { type: String, default: '' },
      cac:     { type: String, default: '' },
    },

    payments: {
      nombaPublicKey:  { type: String, default: '' },
      webhookSecret:   { type: String, default: '' }, // stored encrypted in prod
    },

    shipping: {
      zones: {
        type: [{ name: String, price: Number }],
        default: [
          { name: 'Lagos (within)',          price: 1500  },
          { name: 'Lagos (outside island)',  price: 2000  },
          { name: 'South-West Nigeria',      price: 2500  },
          { name: 'South-East / South-South',price: 3000  },
          { name: 'North Nigeria',           price: 3500  },
          { name: 'Express (same day)',      price: 5000  },
          { name: 'PH (same day)',      price: 5000  },

        ],
      },
    },

    notifications: {
      lowStockThreshold: { type: Number, default: 30    },
      lowStock:          { type: Boolean, default: true  },
      newOrder:          { type: Boolean, default: true  },
      orderStatus:       { type: Boolean, default: true  },
      newCustomer:       { type: Boolean, default: true  },
      payment:           { type: Boolean, default: true  },
      review:            { type: Boolean, default: true  },
    },

    email: {
      smtpHost: { type: String, default: '' },
      smtpPort: { type: Number, default: 587 },
      smtpUser: { type: String, default: '' },
      // smtpPass stored in env, never in DB
    },
  },
  {
    timestamps: true,
    _id: false,   // we manage _id manually above
  }
);

module.exports = mongoose.model('Settings', settingsSchema);
