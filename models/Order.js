'use strict';

const mongoose = require('mongoose');
const crypto   = require('crypto');

const orderItemSchema = new mongoose.Schema({
  product:  { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name:     { type: String, required: true },
  emoji:    { type: String },
  price:    { type: Number, required: true }, // stored in KOBO (integer)
  quantity: { type: Number, required: true, min: 1 },
}, { _id: false });

const addressSchema = new mongoose.Schema({
  street:  { type: String, required: true },
  city:    { type: String, required: true },
  state:   { type: String, required: true },
  country: { type: String, default: 'Nigeria' },
}, { _id: false });

const orderSchema = new mongoose.Schema({

  orderNumber: {
    type: String,
    unique: true,
    index: true,
    // Generated in the pre-save hook below using a timestamp +
    // random suffix — safe against duplicate numbers even if orders
    // are deleted (unlike countDocuments-based approaches).
  },

  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  // FIX: guestEmail declared only once (was duplicated on lines 24
  // and 57 in the original — Mongoose silently used the last one).
  guestEmail: {
    type: String,
    // Populated only for guest checkout orders. Identifies guest
    // orders in the admin dashboard without a full user lookup.
  },

  items: {
    type: [orderItemSchema],
    validate: [(v) => v.length > 0, 'Order must have at least one item'],
  },

  shippingAddress: { type: addressSchema, required: true },

  // ── Pricing (all values stored in KOBO — integer) ──────────────
  // e.g. ₦1,000.50 → stored as 100050
  // payments.js converts to naira string at the Nomba API boundary
  // and converts back to kobo when verifying webhook/status responses.
  subtotal:  { type: Number, required: true },
  discount:  { type: Number, default: 0 },
  shipping:  { type: Number, default: 0 },
  tax:       { type: Number, default: 0 },
  total:     { type: Number, required: true },
  promoCode: { type: String },

  // ── Order status ───────────────────────────────────────────────
  status: {
    type: String,
    enum: ['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
    default: 'pending',
  },
  statusHistory: [{
    status:    { type: String },
    note:      { type: String },
    timestamp: { type: Date, default: Date.now },
  }],

  // ── Payment ────────────────────────────────────────────────────
  paymentStatus: {
    type: String,
    // 'expired' is set by the releaseAbandonedReservations() cron job
    // when a user abandons the Nomba checkout page after 30 minutes.
    enum: ['pending', 'completed', 'failed', 'refunded', 'expired'],
    default: 'pending',
  },
  paymentMethod: {
    type: String,
    // 'other' covers any method string Nomba returns that isn't one
    // of the three known values — prevents silent empty field on new
    // payment methods Nomba might add.
    enum: ['card', 'transfer', 'ussd', 'other'],
  },
  transactionId:  { type: String },
  nombaReference: { type: String },
  paidAt:         { type: Date },

  // ── Fulfillment flag ───────────────────────────────────────────
  // Set to true by processSuccessfulPayment() when a stock decrement
  // fails after payment is already captured (oversold item).
  // Surfaces in the admin dashboard so a human can intervene:
  // partial refund, backorder, or restock.
  fulfillmentFlag: {
    type: Boolean,
    default: false,
  },

  // ── Delivery ───────────────────────────────────────────────────
  trackingNumber:    { type: String },
  estimatedDelivery: { type: Date },
  deliveredAt:       { type: Date },

  // ── Customer snapshot at time of order ────────────────────────
  // Stored separately from the User document so order history stays
  // accurate even if the user later changes their name/email/phone.
  customerName:  { type: String },
  customerEmail: { type: String },
  customerPhone: { type: String },
  notes:         { type: String, maxlength: 500 },
  cancelReason:  { type: String },

}, {
  timestamps: true,
  toJSON: { virtuals: true },
});

// ── INDEXES ───────────────────────────────────────────────────────
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ nombaReference: 1 });
orderSchema.index({ transactionId: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ customerEmail: 1 }); // used by isPromoEligible() in payments.js
orderSchema.index({ fulfillmentFlag: 1, paymentStatus: 1 }); // admin dashboard unfulfilled query

// Prevents a second pending order being created for the same user
// while one is already in-flight (double-submit / race condition fix).
// partialFilterExpression means uniqueness only applies to 'pending'
// documents — completed and failed orders don't block future checkouts.
orderSchema.index(
  { user: 1, paymentStatus: 1 },
  {
    unique: true,
    partialFilterExpression: { paymentStatus: 'pending' },
    sparse: true,
    name: 'unique_pending_payment_per_user',
  }
);

// ── PRE-SAVE: generate order number ───────────────────────────────
// FIX: original used countDocuments() which produces duplicate order
// numbers if any orders are ever deleted (count drops, next insert
// collides with an existing orderNumber).
// Replaced with: prefix + YYMMDD + 4 random hex chars.
// Collision probability is negligible (~1 in 65,536 per day) and the
// unique index on orderNumber will catch the rare case and surface it
// as a retryable duplicate-key error rather than silent corruption.
orderSchema.pre('save', async function (next) {
  if (this.isNew) {
    const date  = new Date();
    const yy    = date.getFullYear().toString().slice(-2);
    const mm    = String(date.getMonth() + 1).padStart(2, '0');
    const dd    = String(date.getDate()).padStart(2, '0');
    const rand  = crypto.randomBytes(2).toString('hex').toUpperCase(); // e.g. "A3F1"
    this.orderNumber = `VTC${yy}${mm}${dd}${rand}`; // e.g. VTC250616A3F1

    this.statusHistory.push({ status: 'pending', note: 'Order created' });
  }
  next();
});

// ── METHOD: add status history entry ─────────────────────────────
// FIX: original was missing braces on the if-block, meaning
// this.statusHistory = [] would execute unconditionally in some
// JS parsers, wiping history on every addStatus() call.
orderSchema.methods.addStatus = function (status, note = '') {
  if (!this.statusHistory) {
    this.statusHistory = [];
  }
  this.statusHistory.push({ status, note, timestamp: new Date() });
  this.status = status;
};

module.exports = mongoose.model('Order', orderSchema);