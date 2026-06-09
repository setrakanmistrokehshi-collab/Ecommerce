'use strict';

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const Product = require('../models/Product');
const Order   = require('../models/Order');
const { protect, restrictTo, optionalAuth } = require('../middleware/auth');
const { AppError }    = require('../middleware/errorHandler');
const { reviewLimiter } = require('../middleware/rateLimiter');
const { cacheGet, cacheSet, cacheDel, cacheDelPattern } = require('../config/redis');
const { deleteFromCloudinary, MAX_FILES } = require('../config/cloudinary');
const { handleUpload } = require('../middleware/handleUpload');
const logger = require('../utils/logger');

const router = express.Router();

// ── HELPERS ───────────────────────────────────────────────────────
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ success: false, errors: errors.array() });
  next();
}

// ── GET ALL PRODUCTS ──────────────────────────────────────────────
router.get('/', [
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('minPrice').optional().isFloat({ min: 0 }),
  query('maxPrice').optional().isFloat({ min: 0 }),
  query('category').optional().isIn(['immunity', 'energy', 'vitamins', 'weight', 'beauty', 'general']),
], validate, async (req, res, next) => {
  try {
    const {
      category, search, minPrice, maxPrice,
      sort = '-createdAt', page = 1, limit = 12,
      featured, badge,
    } = req.query;

    const cacheKey = `products:list:${JSON.stringify(req.query)}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const filter = { isActive: true };
    if (category) filter.category = category;
    if (featured === 'true') filter.isFeatured = true;
    if (badge) filter.badge = badge;
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }
    if (search) filter.$text = { $search: search.slice(0, 100) };

    const sortMap = {
      '-createdAt': { createdAt: -1 },
      'price':      { price: 1 },
      '-price':     { price: -1 },
      '-rating':    { rating: -1 },
      '-totalSold': { totalSold: -1 },
    };
    const sortObj  = sortMap[sort] || { createdAt: -1 };
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip     = (pageNum - 1) * limitNum;

    const [products, total] = await Promise.all([
      Product.find(filter).sort(sortObj).skip(skip).limit(limitNum)
        .select('-reviews').lean(),
      Product.countDocuments(filter),
    ]);

    const response = {
      success: true,
      products,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    };

    await cacheSet(cacheKey, response, 300);
    res.json(response);
  } catch (err) { next(err); }
});

// ── GET SINGLE PRODUCT ────────────────────────────────────────────
router.get('/:slug', optionalAuth, async (req, res, next) => {
  try {
    const cacheKey = `products:detail:${req.params.slug}`;
    const cached   = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const product = await Product.findOne({ slug: req.params.slug, isActive: true })
      .populate('reviews.user', 'name');
    if (!product) return next(new AppError('Product not found', 404));

    const response = { success: true, product };
    await cacheSet(cacheKey, response, 600);
    res.json(response);
  } catch (err) { next(err); }
});

// ── ADD REVIEW ────────────────────────────────────────────────────
router.post('/:id/reviews', protect, reviewLimiter, [
  body('rating').isInt({ min: 1, max: 5 }),
  body('comment').trim().notEmpty().isLength({ min: 10, max: 1000 }),
  body('title').optional().trim().isLength({ max: 100 }),
], validate, async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return next(new AppError('Product not found', 404));

    const alreadyReviewed = product.reviews.some(
      (r) => r.user.toString() === req.user._id.toString()
    );
    if (alreadyReviewed) return next(new AppError('You have already reviewed this product', 400));

    const hasPurchased = await Order.findOne({
      user: req.user._id,
      'items.product': product._id,
      paymentStatus: 'completed',
    });

    product.reviews.push({
      user:     req.user._id,
      name:     req.user.name,
      rating:   req.body.rating,
      comment:  req.body.comment,
      title:    req.body.title,
      verified: !!hasPurchased,
    });
    product.recalcRating();
    await product.save();

    await cacheDel(`products:detail:${product.slug}`);
    res.status(201).json({ success: true, message: 'Review added successfully' });
  } catch (err) { next(err); }
});

// ── ADMIN: CREATE PRODUCT ─────────────────────────────────────────
router.post('/', protect, restrictTo('admin'), [
  body('name').notEmpty().trim().isLength({ max: 120 }),
  body('description').notEmpty().trim().isLength({ max: 2000 }),
  body('price').isFloat({ min: 0 }),
  body('category').isIn(['immunity', 'energy', 'vitamins', 'weight', 'beauty', 'general']),
  body('stock').isInt({ min: 0 }),
], validate, async (req, res, next) => {
  try {
    const product = await Product.create(req.body);
    await cacheDelPattern('products:list:*');
    logger.info(`Product created: ${product.name} by admin ${req.user._id}`);
    res.status(201).json({ success: true, product });
  } catch (err) { next(err); }
});

// ── ADMIN: UPLOAD IMAGES ──────────────────────────────────────────
// POST /api/v1/products/:id/images
// multipart/form-data, field name: "images", max 5 files, 5MB each
router.post(
  '/:id/images',
  protect,
  restrictTo('admin'),
  handleUpload('images', MAX_FILES),
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) {
        // Clean up already-uploaded files from Cloudinary before erroring
        if (req.files?.length) {
          await Promise.all(req.files.map((f) => deleteFromCloudinary(f.path)));
        }
        return next(new AppError('Product not found', 404));
      }

      // Total image cap per product
      const totalAfterUpload = product.images.length + (req.files?.length || 0);
      if (totalAfterUpload > 10) {
        if (req.files?.length) {
          await Promise.all(req.files.map((f) => deleteFromCloudinary(f.path)));
        }
        return next(new AppError(`Product cannot have more than 10 images. Currently has ${product.images.length}.`, 400));
      }

      if (!req.files || req.files.length === 0) {
        return next(new AppError('No images uploaded', 400));
      }

      // req.files[].path is the secure Cloudinary URL (set by multer-storage-cloudinary)
      const newUrls = req.files.map((f) => f.path);
      product.images.push(...newUrls);
      await product.save({ validateBeforeSave: false });

      // Bust cache
      await cacheDel(`products:detail:${product.slug}`);
      await cacheDelPattern('products:list:*');

      logger.info(`${newUrls.length} image(s) uploaded for product ${product._id} by admin ${req.user._id}`);

      res.status(201).json({
        success: true,
        message: `${newUrls.length} image(s) uploaded successfully`,
        images:  product.images,
        uploaded: newUrls,
      });
    } catch (err) { next(err); }
  }
);

// ── ADMIN: DELETE SINGLE IMAGE ────────────────────────────────────
// DELETE /api/v1/products/:id/images
// body: { imageUrl: "https://res.cloudinary.com/..." }
router.delete(
  '/:id/images',
  protect,
  restrictTo('admin'),
  [body('imageUrl').notEmpty().isURL().withMessage('Valid imageUrl required')],
  validate,
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return next(new AppError('Product not found', 404));

      const { imageUrl } = req.body;

      // Make sure the URL actually belongs to this product
      if (!product.images.includes(imageUrl)) {
        return next(new AppError('Image not found on this product', 404));
      }

      // Remove from Cloudinary first
      await deleteFromCloudinary(imageUrl);

      // Remove from DB
      product.images = product.images.filter((img) => img !== imageUrl);
      await product.save({ validateBeforeSave: false });

      // Bust cache
      await cacheDel(`products:detail:${product.slug}`);
      await cacheDelPattern('products:list:*');

      logger.info(`Image deleted from product ${product._id} by admin ${req.user._id}`);

      res.json({
        success: true,
        message: 'Image deleted successfully',
        images:  product.images,
      });
    } catch (err) { next(err); }
  }
);

// ── ADMIN: REORDER IMAGES ─────────────────────────────────────────
// PATCH /api/v1/products/:id/images/reorder
// body: { images: ["url1", "url2", ...] } — full ordered array
router.patch(
  '/:id/images/reorder',
  protect,
  restrictTo('admin'),
  [body('images').isArray({ min: 1 }).withMessage('images must be a non-empty array')],
  validate,
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return next(new AppError('Product not found', 404));

      const incoming = req.body.images;

      // Validate that all incoming URLs exist on this product
      const invalid = incoming.filter((url) => !product.images.includes(url));
      if (invalid.length > 0) {
        return next(new AppError('One or more image URLs do not belong to this product', 400));
      }

      product.images = incoming;
      await product.save({ validateBeforeSave: false });

      await cacheDel(`products:detail:${product.slug}`);

      res.json({ success: true, images: product.images });
    } catch (err) { next(err); }
  }
);

// ── ADMIN: UPDATE PRODUCT ─────────────────────────────────────────
router.patch('/:id', protect, restrictTo('admin'), async (req, res, next) => {
  try {
    const disallowed = ['_id', 'reviews', 'rating', 'numReviews', 'totalSold', 'images'];
    // images is managed through dedicated upload/delete routes above
    disallowed.forEach((f) => delete req.body[f]);

    const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!product) return next(new AppError('Product not found', 404));

    await cacheDel(`products:detail:${product.slug}`);
    await cacheDelPattern('products:list:*');
    logger.info(`Product updated: ${product._id} by admin ${req.user._id}`);
    res.json({ success: true, product });
  } catch (err) { next(err); }
});

// ── ADMIN: SOFT DELETE PRODUCT ────────────────────────────────────
router.delete('/:id', protect, restrictTo('admin'), async (req, res, next) => {
  try {
    const product = await Product.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!product) return next(new AppError('Product not found', 404));

    await cacheDel(`products:detail:${product.slug}`);
    await cacheDelPattern('products:list:*');
    logger.info(`Product deactivated: ${product._id} by admin ${req.user._id}`);
    res.json({ success: true, message: 'Product deactivated' });
  } catch (err) { next(err); }
});

module.exports = router;
