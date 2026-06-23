'use strict';

const mongoose = require('mongoose');
const argon2   = require('argon2');

const { getPermissionsForRole, ALL_PERMISSIONS } = require('../config/permission');

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

  // ── ROLE & PERMISSIONS ──────────────────────────
  role: {
    type: String,
    enum: ['user', 'super_admin', 'product_manager', 'order_manager', 'support_agent'],
    default: 'user',
  },

  // FIX #4: this field was referenced throughout the file but never
  // actually defined on the schema — added properly here with validation.
  extraPermissions: {
    type: [String],
    default: [],
    validate: {
      validator: (arr) => arr.every(p => ALL_PERMISSIONS.includes(p)),
      message:   'Invalid permission in extraPermissions',
    },
  },

  // Permissions explicitly removed from the role preset.
  // Lets you give someone "product_manager minus products.delete".
  revokedPermissions: {
    type: [String],
    default: [],
  },

  avatar: { type: String },
  addresses: {
    type: [addressSchema],
    validate: [(v) => v.length <= 10, 'Maximum 10 saved addresses'],
  },
  isEmailVerified:          { type: Boolean, default: false },
  emailVerificationToken:   { type: String,  select: false },
  emailVerificationExpires: { type: Date,    select: false },
  passwordResetToken:       { type: String,  select: false },
  passwordResetExpires:     { type: Date,    select: false },
  tokenVersion:             { type: Number,  default: 0, select: false }, // bump to invalidate all sessions
  loginAttempts:            { type: Number,  default: 0, select: false },
  lockUntil:                { type: Date,    select: false },
  lastLogin:                { type: Date },
  lastLoginIp:              { type: String,  select: false },
  isGuest:                  { type: Boolean, default: false },
  isActive:                 { type: Boolean, default: true },
  wishlist:                 [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  newsletterSubscribed:     { type: Boolean, default: false },
  deletedAt:                { type: Date,    select: false }, // soft delete
}, {
  timestamps: true,
  toJSON:   { virtuals: true },
  toObject: { virtuals: true },
});

// ── INDEXES ─────────────────────────────────────────────────────
userSchema.index({ createdAt: -1 });
userSchema.index({ role: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ emailVerificationToken: 1 }, { sparse: true });
userSchema.index({ passwordResetToken: 1 },     { sparse: true });

// ── VIRTUAL: is account locked ─────────────────────────────────
userSchema.virtual('isLocked').get(function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

// ── PRE-SAVE: hash password + bump tokenVersion on change ──────
userSchema.pre('save', async function () {
  
    if (this.isModified('password')) {
      this.password = await argon2.hash(this.password);
    }
    if (!this.isNew && this.isModified('password')) {
      this.tokenVersion = (this.tokenVersion || 0) + 1;
    }
    
  }
);

// ── METHOD: compare password ────────────────────────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
  return argon2.verify(this.password, candidatePassword);
};

// ── METHOD: increment login attempts / lock ─────────────────────
userSchema.methods.incLoginAttempts = async function () {
  const MAX_ATTEMPTS = 5;
  const LOCK_TIME    = 2 * 60 * 60 * 1000;
  const now = Date.now();

  if (this.lockUntil && this.lockUntil < now) {
    return this.updateOne({
      $set:   { loginAttempts: 1 },
      $unset: { lockUntil: 1 },
    });
  }

  const newAttempts = (this.loginAttempts || 0) + 1;
  const updates = { $set: { loginAttempts: newAttempts } };
  if (newAttempts >= MAX_ATTEMPTS) {
    updates.$set.lockUntil = now + LOCK_TIME;
  }
  return this.updateOne(updates);
};

// ── PERMISSIONS ──────────────────────────────────

/**
 * Computes the user's effective permission list:
 */
userSchema.methods.getEffectivePermissions = function () {
  if (this.role === 'user') return []; // regular customers have no admin permissions

  const base       = getPermissionsForRole(this.role);
  const withExtras = [...new Set([...base, ...(this.extraPermissions ?? [])])];
  return withExtras.filter(p => !(this.revokedPermissions ?? []).includes(p));
};

/** user.hasPermission('products.delete') */
userSchema.methods.hasPermission = function (permission) {
  return this.getEffectivePermissions().includes(permission);
};

/** user.hasAllPermissions(['orders.view', 'orders.update']) */
userSchema.methods.hasAllPermissions = function (permissions) {
  const effective = this.getEffectivePermissions();
  return permissions.every(p => effective.includes(p));
};

/** user.hasAnyPermission(['orders.view', 'orders.update']) */
userSchema.methods.hasAnyPermission = function (permissions) {
  const effective = this.getEffectivePermissions();
  return permissions.some(p => effective.includes(p));
};

// ── METHOD: safe user object ────────────────────────────────────
userSchema.methods.toSafeObject = function () {
  return {
    id:                   this._id,
    name:                 this.name,
    email:                this.email,
    phone:                this.phone,
    role:                 this.role,
    permissions:          this.getEffectivePermissions(), // FIX #6: computed permissions, not just raw arrays
    avatar:               this.avatar,
    addresses:            this.addresses,
    isEmailVerified:      this.isEmailVerified,
    wishlist:             this.wishlist,
    newsletterSubscribed: this.newsletterSubscribed,
    lastLogin:            this.lastLogin,
    createdAt:            this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);