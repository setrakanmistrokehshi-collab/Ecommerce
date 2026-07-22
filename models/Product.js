'use strict';

const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true, maxlength: 60 },
  rating: { type: Number, required: true, min: 1, max: 5 },
  title: { type: String, maxlength: 100, trim: true },
  comment: { type: String, required: true, maxlength: 1000, trim: true },
  verified: { type: Boolean, default: false },
  helpful: { type: Number, default: 0 },
  reported: { type: Boolean, default: false },
  hidden: { type: Boolean, default: false },
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
    index: true,
  },
  description: {
    type: String,
    required: [true, 'Description is required'],
    maxlength: [2000, 'Description cannot exceed 2000 characters'],
  },
  shortDescription: { 
    type: String, 
    maxlength: [200, 'Short description cannot exceed 200 characters'],
    default: '',
  },
  category: {
    type: String,
    required: [true, 'Category is required'],
    enum: {
      values: ['immunity', 'energy', 'vitamins', 'weight', 'beauty', 'general'],
      message: 'Invalid category',
    },
  },
  emoji: { type: String, default: '💊' },
  images: { type: [String], default: [] },
  
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: [0, 'Price cannot be negative'],
  },
  originalPrice: { 
    type: Number, 
    min: [0, 'Original price cannot be negative'],
    default: null,
  },
  stock: {
    type: Number,
    required: [true, 'Stock is required'],
    default: 0,
    min: [0, 'Stock cannot be negative'],
  },
  lowStockThreshold: { type: Number, default: 10 },
  weight: { type: Number, default: null },
  servings: { type: Number, default: 0 },
  ingredients: { type: [String], default: [] },
  benefits: { type: [String], default: [] },
  howToUse: { type: String, maxlength: 1000, default: '' },
  warnings: { type: String, maxlength: 1000, default: '' },
  tags: { type: [String], lowercase: true, trim: true, default: [] },
  badge: { 
    type: String, 
    enum: {
      values: ['Best Seller', 'New', 'Sale', 'Top Rated', ''],
      message: 'Invalid badge',
    },
    default: '',
  },
  isActive: { type: Boolean, default: true },
  isFeatured: { type: Boolean, default: false },
  reviews: { type: [reviewSchema], default: [] },
  reservedStock: { type: Number, default: 0, min: 0 },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  numReviews: { type: Number, default: 0 },
  totalSold: { type: Number, default: 0, min: 0 },
  metaTitle: { type: String, maxlength: 70, default: '' },
  metaDescription: { type: String, maxlength: 160, default: '' },
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
productSchema.index({ _id: 1, stock: 1, reservedStock: 1 });

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

productSchema.virtual('availableStock').get(function () {
  return Math.max(0, this.stock - this.reservedStock);
});

// ── PRE-VALIDATE: Clean up data ──────────────────────────────────
productSchema.pre('validate', function(next) {
  // Trim string fields
  if (this.name) this.name = this.name.trim();
  if (this.shortDescription) this.shortDescription = this.shortDescription.trim();
  if (this.description) this.description = this.description.trim();
  if (this.howToUse) this.howToUse = this.howToUse.trim();
  if (this.warnings) this.warnings = this.warnings.trim();
  if (this.metaTitle) this.metaTitle = this.metaTitle.trim();
  if (this.metaDescription) this.metaDescription = this.metaDescription.trim();
  
  // Ensure arrays are arrays and filter empty strings
  if (!Array.isArray(this.ingredients)) this.ingredients = [];
  if (!Array.isArray(this.benefits)) this.benefits = [];
  if (!Array.isArray(this.tags)) this.tags = [];
  if (!Array.isArray(this.images)) this.images = [];
  
  this.ingredients = this.ingredients.filter(item => item && item.trim());
  this.benefits = this.benefits.filter(item => item && item.trim());
  this.tags = this.tags.filter(item => item && item.trim());
  this.images = this.images.filter(item => item && item.trim());
  
  // Convert empty strings to null for optional numeric fields
  if (this.originalPrice === '' || this.originalPrice === undefined) this.originalPrice = null;
  if (this.weight === '' || this.weight === undefined) this.weight = null;
  
  // Ensure numbers are actually numbers
  if (this.price !== undefined) this.price = Number(this.price);
  if (this.stock !== undefined) this.stock = Number(this.stock);
  if (this.servings !== undefined) this.servings = Number(this.servings);
  if (this.reservedStock !== undefined) this.reservedStock = Number(this.reservedStock);
  if (this.lowStockThreshold !== undefined) this.lowStockThreshold = Number(this.lowStockThreshold);
  
  next();
});

// ── PRE-SAVE: generate slug ───────────────────────────────────────
productSchema.pre('save', function (next) {
  if (this.isModified('name') || !this.slug) {
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
  return this;
};

// ── STATIC: Find products with filters ────────────────────────────
productSchema.statics.findWithFilters = function(filters = {}, options = {}) {
  const query = this.find(filters);
  if (options.sort) query.sort(options.sort);
  if (options.limit) query.limit(options.limit);
  if (options.skip) query.skip(options.skip);
  if (options.select) query.select(options.select);
  if (options.populate) query.populate(options.populate);
  return query.lean();
};

// ── STATIC: Get category counts ───────────────────────────────────
productSchema.statics.getCategoryCounts = function() {
  return this.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
};

// ── STATIC: Get featured products ────────────────────────────────
productSchema.statics.getFeatured = function(limit = 6) {
  return this.find({ isActive: true, isFeatured: true })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

// ── STATIC: Get best sellers ──────────────────────────────────────
productSchema.statics.getBestSellers = function(limit = 6) {
  return this.find({ isActive: true })
    .sort({ totalSold: -1 })
    .limit(limit)
    .lean();
};

// ── STATIC: Get new arrivals ──────────────────────────────────────
productSchema.statics.getNewArrivals = function(limit = 6) {
  return this.find({ isActive: true })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

module.exports = mongoose.model('Product', productSchema);