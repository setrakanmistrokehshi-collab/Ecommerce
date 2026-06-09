'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Product = require('../models/Product');
const { protect } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();
router.use(protect);

// GET /api/v1/users/profile
router.get('/profile', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).populate('wishlist', 'name emoji price slug');
    res.json({ success: true, user: user.toSafeObject() });
  } catch (err) { next(err); }
});

// PATCH /api/v1/users/profile
router.patch('/profile', [
  body('name').optional().trim().isLength({ min: 2, max: 60 }),
  body('phone').optional().isMobilePhone('en-NG'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    // Fields users cannot self-update
    const forbidden = ['password', 'email', 'role', 'isEmailVerified', 'loginAttempts'];
    forbidden.forEach(f => delete req.body[f]);

    const user = await User.findByIdAndUpdate(req.user._id, req.body, {
      new: true, runValidators: true,
    });
    res.json({ success: true, user: user.toSafeObject() });
  } catch (err) { next(err); }
});

// PATCH /api/v1/users/change-password
router.patch('/change-password', [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const user = await User.findById(req.user._id).select('+password');
    const isMatch = await user.comparePassword(req.body.currentPassword);
    if (!isMatch) return next(new AppError('Current password is incorrect', 401));

    user.password = req.body.newPassword;
    await user.save();
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) { next(err); }
});

// POST /api/v1/users/addresses
router.post('/addresses', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (req.body.isDefault) {
      user.addresses.forEach(a => { a.isDefault = false; });
    }
    user.addresses.push(req.body);
    await user.save();
    res.status(201).json({ success: true, addresses: user.addresses });
  } catch (err) { next(err); }
});

// DELETE /api/v1/users/addresses/:addressId
router.delete('/addresses/:addressId', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    user.addresses = user.addresses.filter(a => a._id.toString() !== req.params.addressId);
    await user.save();
    res.json({ success: true, addresses: user.addresses });
  } catch (err) { next(err); }
});

// POST /api/v1/users/wishlist/:productId — toggle
router.post('/wishlist/:productId', async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const idx = user.wishlist.findIndex(id => id.toString() === req.params.productId);
    let action;
    if (idx > -1) {
      user.wishlist.splice(idx, 1);
      action = 'removed';
    } else {
      const product = await Product.findById(req.params.productId);
      if (!product) return next(new AppError('Product not found', 404));
      user.wishlist.push(req.params.productId);
      action = 'added';
    }
    await user.save();
    res.json({ success: true, action, wishlistCount: user.wishlist.length });
  } catch (err) { next(err); }
});

// POST /api/v1/users/newsletter
router.post('/newsletter', async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { newsletterSubscribed: req.body.subscribe !== false });
    res.json({ success: true, message: req.body.subscribe !== false ? 'Subscribed!' : 'Unsubscribed.' });
  } catch (err) { next(err); }
});

module.exports = router;
