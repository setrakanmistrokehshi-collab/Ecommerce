'use strict';

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { protect, restrictTo, optionalAuth } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { reviewLimiter } = require('../middleware/rateLimiter');
const { cacheGet, cacheSet, cacheDel, cacheDelPattern } = require('../config/redis');
const { 
  deleteFromCloudinary, 
  deleteMultipleFromCloudinary,
  getOptimizedUrl,
  getThumbnailUrl,
  MAX_FILES,
  isConfigured,
  handleMulterError,
} = require('../config/cloudinary');
const { handleUpload } = require('../middleware/handleUpload');
const logger = require('../utils/logger');

const router = express.Router();

// ── HELPERS ───────────────────────────────────────────────────────
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ 
      success: false, 
      errors: errors.array() 
    });
  }
  next();
}

// ── CLEAN CACHE HELPER ──────────────────────────────────────────
async function clearProductCache(slug = null) {
  try {
    if (slug) {
      await cacheDel(`products:detail:${slug}`);
    }
    await cacheDelPattern('products:list:*');
    logger.debug('🔄 Product cache cleared');
  } catch (error) {
    logger.warn('⚠️ Failed to clear cache:', error.message);
  }
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

    // Build cache key from query
    const cacheKey = `products:list:${JSON.stringify(req.query)}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Build filter
    const filter = { isActive: true };
    if (category) filter.category = category;
    if (featured === 'true') filter.isFeatured = true;
    if (badge) filter.badge = badge;
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }
    if (search) {
      filter.$text = { $search: search.slice(0, 100) };
    }

    // Sorting
    const sortMap = {
      '-createdAt': { createdAt: -1 },
      'price': { price: 1 },
      '-price': { price: -1 },
      '-rating': { rating: -1 },
      '-totalSold': { totalSold: -1 },
      'name': { name: 1 },
      '-name': { name: -1 },
    };
    const sortObj = sortMap[sort] || { createdAt: -1 };
    
    // Pagination
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 12));
    const skip = (pageNum - 1) * limitNum;

    // Fetch products with optimized query
    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
        .select('-reviews -__v')
        .lean(),
      Product.countDocuments(filter),
    ]);

    // Add optimized image URLs
    const productsWithUrls = products.map(product => ({
      ...product,
      thumbnail: product.images?.length > 0 
        ? getThumbnailUrl(product.images[0]) 
        : null,
      images: product.images?.map(img => getOptimizedUrl(img)) || [],
    }));

    const response = {
      success: true,
      products: productsWithUrls,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    };

    // Cache for 5 minutes
    await cacheSet(cacheKey, response, 300);
    res.json(response);
  } catch (err) {
    logger.error('❌ Error fetching products:', err);
    next(err);
  }
});

// ── GET SINGLE PRODUCT ────────────────────────────────────────────
router.get('/:slug', optionalAuth, async (req, res, next) => {
  try {
    const cacheKey = `products:detail:${req.params.slug}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const product = await Product.findOne({ 
      slug: req.params.slug, 
      isActive: true 
    })
      .populate('reviews.user', 'name avatar')
      .select('-__v')
      .lean();

    if (!product) {
      return next(new AppError('Product not found', 404));
    }

    // Add optimized image URLs
    const productWithUrls = {
      ...product,
      thumbnail: product.images?.length > 0 
        ? getThumbnailUrl(product.images[0]) 
        : null,
      images: product.images?.map(img => getOptimizedUrl(img)) || [],
    };

    const response = { 
      success: true, 
      product: productWithUrls 
    };
    
    // Cache for 10 minutes
    await cacheSet(cacheKey, response, 600);
    res.json(response);
  } catch (err) {
    logger.error('❌ Error fetching product:', err);
    next(err);
  }
});

// ── ADD REVIEW ────────────────────────────────────────────────────
router.post('/:id/reviews', protect, reviewLimiter, [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('comment').trim().notEmpty().isLength({ min: 10, max: 1000 })
    .withMessage('Comment must be between 10 and 1000 characters'),
  body('title').optional().trim().isLength({ max: 100 })
    .withMessage('Title must be less than 100 characters'),
], validate, async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return next(new AppError('Product not found', 404));
    }

    // Check if user already reviewed
    const alreadyReviewed = product.reviews.some(
      (r) => r.user.toString() === req.user._id.toString()
    );
    if (alreadyReviewed) {
      return next(new AppError('You have already reviewed this product', 400));
    }

    // Check if user purchased product
    const hasPurchased = await Order.exists({
      user: req.user._id,
      'items.product': product._id,
      paymentStatus: 'completed',
    });

    // Add review
    product.reviews.push({
      user: req.user._id,
      name: req.user.name,
      rating: req.body.rating,
      comment: req.body.comment,
      title: req.body.title,
      verified: !!hasPurchased,
    });

    // Recalculate rating
    product.recalcRating();
    await product.save();

    // Clear cache
    await clearProductCache(product.slug);

    logger.info(`✅ Review added for product ${product._id} by user ${req.user._id}`);
    
    res.status(201).json({ 
      success: true, 
      message: 'Review added successfully' 
    });
  } catch (err) {
    logger.error('❌ Error adding review:', err);
    next(err);
  }
});

// ── GET PRODUCT REVIEWS ──────────────────────────────────────────
router.get('/:id/reviews', async (req, res, next) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));

    const product = await Product.findById(req.params.id)
      .select('reviews')
      .lean();

    if (!product) {
      return next(new AppError('Product not found', 404));
    }

    const reviews = product.reviews
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice((pageNum - 1) * limitNum, pageNum * limitNum);

    res.json({
      success: true,
      reviews,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: product.reviews.length,
        pages: Math.ceil(product.reviews.length / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── ADMIN: CREATE PRODUCT ─────────────────────────────────────────
router.post('/', protect, restrictTo('admin'), [
  body('name').notEmpty().trim().isLength({ max: 120 }),
  body('description').notEmpty().trim().isLength({ max: 2000 }),
  body('price').isFloat({ min: 0 }),
  body('category').isIn(['immunity', 'energy', 'vitamins', 'weight', 'beauty', 'general']),
  body('stock').isInt({ min: 0 }),
  body('discount').optional().isFloat({ min: 0, max: 100 }),
], validate, async (req, res, next) => {
  try {
    // Generate slug from name
    const slug = req.body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const productData = {
      ...req.body,
      slug,
    };

    const product = await Product.create(productData);
    
    // Clear cache
    await clearProductCache();

    logger.info(`📦 Product created: ${product.name} (${product._id}) by admin ${req.user._id}`);
    
    res.status(201).json({ 
      success: true, 
      product 
    });
  } catch (err) {
    logger.error('❌ Error creating product:', err);
    next(err);
  }
});

// ── ADMIN: UPLOAD IMAGES ──────────────────────────────────────────
router.post(
  '/:id/images',
  protect,
  restrictTo('admin'),
  (req, res, next) => {
    if (!isConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'Image upload service is not available. Please configure Cloudinary.',
      });
    }
    next();
  },
  handleUpload('images', MAX_FILES),
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) {
        // Clean up uploaded images
        if (req.files?.length) {
          await Promise.all(req.files.map((f) => deleteFromCloudinary(f.public_id || f.path)));
        }
        return next(new AppError('Product not found', 404));
      }

      // Check image limit
      const totalAfterUpload = product.images.length + (req.files?.length || 0);
      if (totalAfterUpload > 10) {
        if (req.files?.length) {
          await Promise.all(req.files.map((f) => deleteFromCloudinary(f.public_id || f.path)));
        }
        return next(new AppError(
          `Product cannot have more than 10 images. Currently has ${product.images.length}.`,
          400
        ));
      }

      if (!req.files || req.files.length === 0) {
        return next(new AppError('No images uploaded', 400));
      }

      // Get Cloudinary public IDs or URLs
      const newImages = req.files.map((f) => f.path || f.secure_url);
      product.images.push(...newImages);
      await product.save({ validateBeforeSave: false });

      // Clear cache
      await clearProductCache(product.slug);

      logger.info(`📸 ${newImages.length} image(s) uploaded for product ${product._id} by admin ${req.user._id}`);

      res.status(201).json({
        success: true,
        message: `${newImages.length} image(s) uploaded successfully`,
        images: product.images,
        uploaded: newImages,
      });
    } catch (err) {
      // Clean up if error
      if (req.files?.length) {
        await Promise.all(req.files.map((f) => deleteFromCloudinary(f.public_id || f.path)));
      }
      logger.error('❌ Error uploading images:', err);
      next(err);
    }
  }
);

// ── ADMIN: DELETE SINGLE IMAGE ────────────────────────────────────
router.delete(
  '/:id/images',
  protect,
  restrictTo('admin'),
  [body('imageUrl').notEmpty().isURL().withMessage('Valid imageUrl required')],
  validate,
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) {
        return next(new AppError('Product not found', 404));
      }

      const { imageUrl } = req.body;

      // Verify image belongs to product
      if (!product.images.includes(imageUrl)) {
        return next(new AppError('Image not found on this product', 404));
      }

      // Extract public ID from URL
      let publicId = imageUrl;
      if (imageUrl.includes('cloudinary')) {
        const parts = imageUrl.split('/');
        const fileName = parts[parts.length - 1].split('.')[0];
        publicId = `winners/products/${fileName}`;
      }

      // Delete from Cloudinary
      const result = await deleteFromCloudinary(publicId);
      if (result?.result === 'error') {
        logger.warn(`⚠️ Failed to delete from Cloudinary: ${publicId}`);
      }

      // Remove from DB
      product.images = product.images.filter((img) => img !== imageUrl);
      await product.save({ validateBeforeSave: false });

      // Clear cache
      await clearProductCache(product.slug);

      logger.info(`🗑️ Image deleted from product ${product._id} by admin ${req.user._id}`);

      res.json({
        success: true,
        message: 'Image deleted successfully',
        images: product.images,
      });
    } catch (err) {
      logger.error('❌ Error deleting image:', err);
      next(err);
    }
  }
);

// ── ADMIN: REORDER IMAGES ─────────────────────────────────────────
router.patch(
  '/:id/images/reorder',
  protect,
  restrictTo('admin'),
  [
    body('images').isArray({ min: 1 }).withMessage('images must be a non-empty array'),
    body('images.*').isURL().withMessage('Each image must be a valid URL'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) {
        return next(new AppError('Product not found', 404));
      }

      const incoming = req.body.images;

      // Validate all incoming URLs exist on product
      const invalid = incoming.filter((url) => !product.images.includes(url));
      if (invalid.length > 0) {
        return next(new AppError('One or more image URLs do not belong to this product', 400));
      }

      product.images = incoming;
      await product.save({ validateBeforeSave: false });

      // Clear cache
      await clearProductCache(product.slug);

      logger.info(`🔄 Images reordered for product ${product._id} by admin ${req.user._id}`);

      res.json({ 
        success: true, 
        images: product.images 
      });
    } catch (err) {
      logger.error('❌ Error reordering images:', err);
      next(err);
    }
  }
);

// ── ADMIN: UPDATE PRODUCT ─────────────────────────────────────────
router.patch('/:id', protect, restrictTo('admin'), async (req, res, next) => {
  try {
    // Prevent updating sensitive fields
    const disallowed = ['_id', 'reviews', 'rating', 'numReviews', 'totalSold', 'images', 'slug'];
    disallowed.forEach((f) => delete req.body[f]);

    // If name is being updated, update slug too
    if (req.body.name) {
      req.body.slug = req.body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      req.body,
      { 
        new: true, 
        runValidators: true,
        select: '-__v',
      }
    );

    if (!product) {
      return next(new AppError('Product not found', 404));
    }

    // Clear cache
    await clearProductCache(product.slug);

    logger.info(`📝 Product updated: ${product._id} by admin ${req.user._id}`);

    res.json({ 
      success: true, 
      product 
    });
  } catch (err) {
    logger.error('❌ Error updating product:', err);
    next(err);
  }
});

// ── ADMIN: SOFT DELETE PRODUCT ────────────────────────────────────
router.delete('/:id', protect, restrictTo('admin'), async (req, res, next) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id, 
      { isActive: false },
      { new: true }
    );

    if (!product) {
      return next(new AppError('Product not found', 404));
    }

    // Clear cache
    await clearProductCache(product.slug);

    logger.info(`🚫 Product deactivated: ${product._id} by admin ${req.user._id}`);

    res.json({ 
      success: true, 
      message: 'Product deactivated successfully' 
    });
  } catch (err) {
    logger.error('❌ Error deactivating product:', err);
    next(err);
  }
});

// ── ADMIN: PERMANENTLY DELETE PRODUCT ────────────────────────────
router.delete('/:id/permanent', protect, restrictTo('admin'), async (req, res, next) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return next(new AppError('Product not found', 404));
    }

    // Delete all images from Cloudinary
    if (product.images.length > 0 && isConfigured()) {
      const publicIds = product.images.map(img => {
        const parts = img.split('/');
        const fileName = parts[parts.length - 1].split('.')[0];
        return `winners/products/${fileName}`;
      });
      
      await deleteMultipleFromCloudinary(publicIds);
      logger.info(`🗑️ Deleted ${product.images.length} images for product ${product._id}`);
    }

    await product.deleteOne();

    // Clear cache
    await clearProductCache();

    logger.info(`💀 Product permanently deleted: ${product._id} by admin ${req.user._id}`);

    res.json({
      success: true,
      message: 'Product permanently deleted',
    });
  } catch (err) {
    logger.error('❌ Error deleting product:', err);
    next(err);
  }
});

module.exports = router;