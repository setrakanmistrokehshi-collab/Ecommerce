'use strict';

const mongoose = require('mongoose');
const argon2 = require('argon2');

const addressSchema = new mongoose.Schema({
  label:     { type: String, default: 'Home', maxlength: 30 },
  street:    { type: String, required: true, maxlength: 200 },
  city:      { type: String, required: true, maxlength: 100 },
  state:     { type: String, required: true, maxlength: 100 },
  country:   { type: String, default: 'Nigeria', maxlength: 100 },
  zipCode:   { type: String, maxlength: 20 },
  isDefault: { type: Boolean, default: false },
}, { _id: true });

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: [60, 'Name cannot exceed 60 characters'],
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
  },
  phone: {
    type: String,
    trim: true,
    match: [/^(\+?234|0)[789]\d{9}$/, 'Please provide a valid Nigerian phone number'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false,
  },
  role: {
    type: String,
    enum: ['customer', 'admin'],
    default: 'customer',
  },
  avatar: { type: String },
  addresses: {
    type: [addressSchema],
    validate: [(v) => v.length <= 10, 'Maximum 10 saved addresses'],
  },
  isEmailVerified: { type: Boolean, default: false },
  emailVerificationToken: { type: String, select: false },
  emailVerificationExpires: { type: Date, select: false },
  passwordResetToken: { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  tokenVersion: { type: Number, default: 0, select: false }, // bump to invalidate all sessions
  loginAttempts: { type: Number, default: 0, select: false },
  lockUntil: { type: Date, select: false },
  lastLogin: { type: Date },
  lastLoginIp: { type: String, select: false },
  isActive: { type: Boolean, default: true },
  wishlist: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  newsletterSubscribed: { type: Boolean, default: false },
  deletedAt: { type: Date, select: false }, // soft delete
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
});

// ── INDEXES ────
userSchema.index({ createdAt: -1 });
userSchema.index({ role: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ emailVerificationToken: 1 }, { sparse: true });
userSchema.index({ passwordResetToken: 1 }, { sparse: true });

// ── VIRTUAL: is account locked ────────────────────────────────────
userSchema.virtual('isLocked').get(function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// ── PRE-SAVE: hash password + bump tokenVersion on change ─────────
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await argon2.hash(this.password, 12);
  // Invalidate all existing sessions when password changes
  if (!this.isNew) {
    this.tokenVersion = (this.tokenVersion || 0) + 1;
  }
  next();
});

// ── METHOD: compare password ──────────────────────────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
  return argon2.verify(this.password, candidatePassword);
};

// ── METHOD: increment login attempts / lock ───────────────────────
userSchema.methods.incLoginAttempts = async function () {
  const MAX_ATTEMPTS = 5;
  const LOCK_TIME = 2 * 60 * 60 * 1000; // 2 hours

  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({ $set: { loginAttempts: 1 }, $unset: { lockUntil: 1 } });
  }

  const updates = { $inc: { loginAttempts: 1 } };
  if (this.loginAttempts + 1 >= MAX_ATTEMPTS && !this.isLocked) {
    updates.$set = { lockUntil: Date.now() + LOCK_TIME };
  }
  return this.updateOne(updates);
};

// ── METHOD: safe user object ──────────────────────────────────────
userSchema.methods.toSafeObject = function () {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    phone: this.phone,
    role: this.role,
    avatar: this.avatar,
    addresses: this.addresses,
    isEmailVerified: this.isEmailVerified,
    wishlist: this.wishlist,
    newsletterSubscribed: this.newsletterSubscribed,
    lastLogin: this.lastLogin,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);
