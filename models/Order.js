'use strict';

const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  product:   { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name:      { type: String, required: true },
  emoji:     { type: String },
  price:     { type: Number, required: true },
  quantity:  { type: Number, required: true, min: 1 },
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
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  guestEmail: { type: String }, // for guest checkouts
  items: {
    type: [orderItemSchema],
    validate: [(v) => v.length > 0, 'Order must have at least one item'],
  },
  shippingAddress: { type: addressSchema, required: true },

  // Pricing breakdown
  subtotal:  { type: Number, required: true },
  discount:  { type: Number, default: 0 },
  shipping:  { type: Number, default: 0 },
  tax:       { type: Number, default: 0 },
  total:     { type: Number, required: true },
  promoCode: { type: String },

  // Status
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

  // Payment
  paymentStatus: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'refunded'],
    default: 'pending',
  },
  paymentMethod:    { type: String, enum: ['card', 'transfer', 'ussd'] },
  transactionId:    { type: String },
  nombaReference:   { type: String },
  paidAt:           { type: Date },

  // Delivery
  trackingNumber:   { type: String },
  estimatedDelivery:{ type: Date },
  deliveredAt:      { type: Date },

  // Customer contact at time of order
  customerName:     { type: String },
  customerEmail:    { type: String },
  customerPhone:    { type: String },

  notes:            { type: String, maxlength: 500 },
  cancelReason:     { type: String },
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

// ── PRE-SAVE: generate order number ───────────────────────────────
orderSchema.pre('save', async function (next) {
  if (this.isNew) {
    const count = await mongoose.model('Order').countDocuments();
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    this.orderNumber = `VTC${year}${month}${String(count + 1).padStart(5, '0')}`;

    this.statusHistory.push({ status: 'pending', note: 'Order created' });
  }
  next();
});

// ── METHOD: add status history entry ─────────────────────────────
orderSchema.methods.addStatus = function (status, note = '') {
  this.status = status;
  this.statusHistory.push({ status, note, timestamp: new Date() });
};

module.exports = mongoose.model('Order', orderSchema);
