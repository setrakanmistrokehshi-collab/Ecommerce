'use strict';

const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:     { type: String, required: true, maxlength: 60 },
  rating:   { type: Number, required: true, min: 1, max: 5 },
  title:    { type: String, maxlength: 100, trim: true },
  comment:  { type: String, required: true, maxlength: 1000, trim: true },
  verified: { type: Boolean, default: false },
  helpful:  { type: Number, default: 0 },
  reported: { type: Boolean, default: false },
  hidden:   { type: Boolean, default: false },
}, { timestamps: true });

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true,
    maxlength: [120, 'Name cannot exceed 120 characters'],
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    maxlength: [2000],
  },
  shortDescription: { type: String, maxlength: 200 },
  category: {
    type: String,
    required: true,
    enum: ['immunity', 'energy', 'vitamins', 'weight', 'beauty', 'general'],
  },
  emoji:        { type: String, default: '💊' },
  images:       [{ type: String }],
  
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative'],
  },
  originalPrice: { type: Number },
  stock: {
    type: Number,
    required: true,
    default: 0,
    min: [0, 'Stock cannot be negative'],
  },
  lowStockThreshold: { type: Number, default: 10 },
  weight:       { type: Number }, // grams
  servings:     { type: Number },
  ingredients:  [{ type: String, maxlength: 200 }],
  benefits:     [{ type: String, maxlength: 300 }],
  howToUse:     { type: String, maxlength: 1000 },
  warnings:     { type: String, maxlength: 1000 },
  tags:         [{ type: String, lowercase: true, trim: true }],
  badge:        { type: String, enum: ['Best Seller', 'New', 'Sale', 'Top Rated', null] },
  isActive:     { type: Boolean, default: true },
  isFeatured:   { type: Boolean, default: false },
  reviews:      [reviewSchema],
  rating: { type: Number, default: 0, min: 0, max: 5 },
  numReviews: { type: Number, default: 0 },
  totalSold: { type: Number, default: 0 },
  metaTitle:        { type: String, maxlength: 70 },
  metaDescription:  { type: String, maxlength: 160 },
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// ── INDEXES ───────────────────────────────────────────────────────
productSchema.index({ name: 'text', description: 'text', tags: 'text' });
productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ price: 1, rating: -1 });

productSchema.index({ isActive: 1, isFeatured: -1 });
productSchema.index({ createdAt: -1 });
productSchema.index({ totalSold: -1 });
productSchema.index({ sku: 1 }, { sparse: true });

// ── VIRTUALS ──────────────────────────────────────────────────────
productSchema.virtual('discountPercent').get(function () {
  if (!this.originalPrice || this.originalPrice <= this.price) return 0;
  return Math.round((1 - this.price / this.originalPrice) * 100);
});

productSchema.virtual('inStock').get(function () {
  return this.stock > 0;
});

productSchema.virtual('isLowStock').get(function () {
  return this.stock > 0 && this.stock <= this.lowStockThreshold;
});

// ── PRE-SAVE: generate slug ───────────────────────────────────────
productSchema.pre('save', function (next) {
  if (this.isModified('name')) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
  next();
});

// ── METHOD: recalculate rating (only non-hidden reviews) ──────────
productSchema.methods.recalcRating = function () {
  const visible = this.reviews.filter((r) => !r.hidden);
  if (visible.length === 0) {
    this.rating = 0;
    this.numReviews = 0;
  } else {
    const total = visible.reduce((sum, r) => sum + r.rating, 0);
    this.rating = Math.round((total / visible.length) * 10) / 10;
    this.numReviews = visible.length;
  }
};

module.exports = mongoose.model('Product', productSchema);
