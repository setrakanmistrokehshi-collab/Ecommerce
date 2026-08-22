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
  },

  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  guestEmail: {
    type: String,
  },

  items: {
    type: [orderItemSchema],
    validate: [(v) => v.length > 0, 'Order must have at least one item'],
  },

  shippingAddress: { type: addressSchema, required: true },

  // ── Pricing (all values stored in KOBO — integer) ──────────────
  // e.g. ₦1,000.50 → stored as 100050
  // Monnify's API reports amounts in decimal Naira — the Monnify
  // service layer converts to/from kobo at that boundary, same
  // pattern the old Nomba integration used.
  subtotal:  { type: Number, required: true },
  discount:  { type: Number, default: 0 },
  shipping:  { type: Number, default: 0 },
  tax:       { type: Number, default: 0 },
  total:     { type: Number, required: true },
  promoCode: { type: String },

  // ── Order status (lifecycle) ──────────────────────────────────
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
    // 'expired' — set by releaseAbandonedReservations() when checkout
    //   is abandoned, AND now also the direct mapping for Monnify's
    //   EXPIRED transaction status.
    // 'flagged_underpaid' — Monnify verify confirmed less than the
    //   order total was paid. Order is NOT fulfilled in this state.
    // 'discrepancy' — verified amount/status don't reconcile cleanly
    //   (e.g. gateway says PAID but our own kobo math disagrees).
    //   Needs manual review, distinct from a clean 'failed'.
    // 'rejected' — Monnify's gateway itself rejected an over/under
    //   payment and returned funds to the sender (REJECTED_PAYMENT
    //   webhook). Distinct from 'failed': money moved and bounced
    //   back, rather than the attempt simply not going through.
    enum: [
      'pending',
      'completed',
      'failed',
      'refunded',
      'expired',
      'flagged_underpaid',
      'discrepancy',
      'rejected',
    ],
    default: 'pending',
  },
  paymentMethod: {
    type: String,
    // 'other' covers any method the gateway returns that isn't one of
    // the three known values (e.g. Monnify's PHONE_NUMBER) — prevents
    // a validation crash on a payment method we haven't mapped yet.
    enum: ['card', 'transfer', 'ussd', 'other'],
  },
  transactionId:     { type: String },
  monnifyReference:  { type: String }, // renamed from nombaReference during the Monnify migration
  paidAt:            { type: Date },

  // ── Fulfillment flag ───────────────────────────────────────────
  // Set to true by processSuccessfulPayment() when a stock decrement
  // fails after payment is already captured (oversold item).
  fulfillmentFlag: {
    type: Boolean,
    default: false,
  },

  // ── Overpayment flag ───────────────────────────────────────
  overpaymentFlag: {
    type: Boolean,
    default: false,
  },
  overpaidAmount: {
    type: Number, // kobo — the excess amount owed back to the customer
    default: 0,
  },

  // ── Delivery ───────────────────────────────────────────────────
  trackingNumber:    { type: String },
  estimatedDelivery: { type: Date },
  deliveredAt:       { type: Date },

  // ── Customer snapshot at time of order ────────────────────────
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
orderSchema.index({ monnifyReference: 1 });
orderSchema.index({ transactionId: 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ customerEmail: 1 });
orderSchema.index({ fulfillmentFlag: 1, paymentStatus: 1 });
orderSchema.index({ overpaymentFlag: 1 }); // admin "owed refunds" queue

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
orderSchema.pre('save', async function (next) {
  if (this.isNew) {
    const date  = new Date();
    const yy    = date.getFullYear().toString().slice(-2);
    const mm    = String(date.getMonth() + 1).padStart(2, '0');
    const dd    = String(date.getDate()).padStart(2, '0');
    const rand  = crypto.randomBytes(2).toString('hex').toUpperCase();
    this.orderNumber = `VTC${yy}${mm}${dd}${rand}`;

    this.statusHistory.push({ status: 'pending', note: 'Order created' });
  }
  
});

// ── METHOD: add status history entry (lifecycle `status` field) ──
orderSchema.methods.addStatus = function (status, note = '') {
  if (!this.statusHistory) {
    this.statusHistory = [];
  }
  this.statusHistory.push({ status, note, timestamp: new Date() });
  this.status = status;
};

orderSchema.methods.addPaymentNote = function (note) {
  if (!this.statusHistory) {
    this.statusHistory = [];
  }
  this.statusHistory.push({ status: this.status, note, timestamp: new Date() });
};


orderSchema.statics.mapPaymentMethod = function (gatewayMethod) {
  const map = {
    CARD: 'card',
    ACCOUNT_TRANSFER: 'transfer',
    USSD: 'ussd',
  };
  return map[gatewayMethod] || 'other';
};

module.exports = mongoose.model('Order', orderSchema);