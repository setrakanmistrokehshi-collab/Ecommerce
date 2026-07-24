'use strict';

const express = require('express');
const { body, query, validationResult } = require('express-validator');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { protect, restrictTo, optionalAuth } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { PERMISSIONS, STAFF_ROLES } = require('../config/permission');
const { AppError } = require('../middleware/errorHandler');
const { reviewLimiter } = require('../middleware/rateLimiter');
const { cacheGet, cacheSet, cacheDel, cacheDelPattern } = require('../config/redis');
const {
  uploadToCloudinary,
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

// ── SLUG HELPER ───────────────────────────────────────────────────
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Generates a unique slug by appending -2, -3, etc. if needed.
// excludeId lets updates ignore the product's own existing slug.
async function generateUniqueSlug(name, excludeId = null) {
  const base = slugify(name);
  let candidate = base;
  let suffix = 2;

  // Loop guards against the (rare) case of many name collisions.
  for (let i = 0; i < 50; i++) {
    const filter = { slug: candidate };
    if (excludeId) filter._id = { $ne: excludeId };

    const exists = await Product.exists(filter);
    if (!exists) return candidate;

    candidate = `${base}-${suffix++}`;
  }

  return `${base}-${Date.now()}`;
}

// ── CLOUDINARY PUBLIC ID HELPER ──────────────────────────────────

function extractCloudinaryPublicId(imageUrl) {
  try {
    const match = imageUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);
    if (match && match[1]) return match[1];
  } catch (err) {
    logger.warn('⚠️ Failed to parse Cloudinary public_id from URL:', imageUrl);
  }
  return null;
}

function normalizeImageInputs(images) {
  if (images === undefined || images === null) return undefined;

  const rawList = Array.isArray(images) ? images : [images];

  const flattened = rawList
    .flatMap((val) => (typeof val === 'string' ? val.split(/[\n,]+/) : [val]))
    .map((val) => (typeof val === 'string' ? val.trim() : ''))
    .filter(Boolean);

  const deduped = [...new Set(flattened)];

  return deduped
    .map((val) => (val.includes('cloudinary.com') ? (extractCloudinaryPublicId(val) || val) : val))
    .slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════
// PUBLIC ROUTES (No authentication required)
// ═══════════════════════════════════════════════════════════════════

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

    let sortObj;
    let projection = '-reviews -__v';
    if (search && sort === '-createdAt') {
      sortObj = { score: { $meta: 'textScore' }, createdAt: -1 };
      projection = { reviews: 0, __v: 0, score: { $meta: 'textScore' } };
    } else {
      sortObj = sortMap[sort] || { createdAt: -1 };
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 12));
    const skip = (pageNum - 1) * limitNum;

    // Fetch products with optimized query
    const [products, total] = await Promise.all([
      Product.find(filter)
        .select(projection)
        .sort(sortObj)
        .skip(skip)
        .limit(limitNum)
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

// ═══════════════════════════════════════════════════════════════════
// AUTHENTICATED ROUTES (User level)
// ═══════════════════════════════════════════════════════════════════

// ── ADD REVIEW ────────────────────────────────────────────────────
router.post('/:id/reviews', protect, reviewLimiter, [
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('comment').trim().notEmpty().isLength({ min: 10, max: 1000 })
    .withMessage('Comment must be between 10 and 1000 characters'),
  body('title').optional().trim().isLength({ max: 100 })
    .withMessage('Title must be less than 100 characters'),
], validate, async (req, res, next) => {
  try {
    // Check if user purchased product (used to mark the review verified)
    const hasPurchased = await Order.exists({
      user: req.user._id,
      'items.product': req.params.id,
      paymentStatus: 'completed',
    });

    const newReview = {
      user: req.user._id,
      name: req.user.name,
      rating: req.body.rating,
      comment: req.body.comment,
      title: req.body.title,
      verified: !!hasPurchased,
    };

    const updated = await Product.findOneAndUpdate(
      {
        _id: req.params.id,
        'reviews.user': { $ne: req.user._id },
      },
      { $push: { reviews: newReview } },
      { returnDocument: 'after' }
    );

    if (!updated) {
      // Either the product doesn't exist, or the user already reviewed it.
      const exists = await Product.exists({ _id: req.params.id });
      if (!exists) {
        return next(new AppError('Product not found', 404));
      }
      return next(new AppError('You have already reviewed this product', 400));
    }

    // Recalculate and persist the aggregate rating.
    updated.recalcRating();
    await updated.save();

    // Clear cache
    await clearProductCache(updated.slug);

    logger.info(`✅ Review added for product ${updated._id} by user ${req.user._id}`);

    res.status(201).json({
      success: true,
      message: 'Review added successfully'
    });
  } catch (err) {
    logger.error('❌ Error adding review:', err);
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// ADMIN ROUTES (Permission based)
// ═══════════════════════════════════════════════════════════════════

// ── ADMIN: CREATE PRODUCT ─────────────────────────────────────────
router.post('/',
  protect,
  restrictTo(...STAFF_ROLES),
  requirePermission(PERMISSIONS.PRODUCTS_CREATE),
  [
    body('name').notEmpty().trim().isLength({ max: 120 }),
    body('description').notEmpty().trim().isLength({ max: 2000 }),
    body('price').isFloat({ min: 0 }),
    body('category').isIn(['immunity', 'energy', 'vitamins', 'weight', 'beauty', 'general']),
    body('stock').isInt({ min: 0 }),
    body('discount').optional().isFloat({ min: 0, max: 100 }),
    body('images').optional(),
  ],
  validate,
  async (req, res, next) => {
    try {
     
      const slug = await generateUniqueSlug(req.body.name);

      const productData = {
        ...req.body,
        slug,
      };

      const normalizedImages = normalizeImageInputs(req.body.images);
      if (normalizedImages !== undefined) {
        productData.images = normalizedImages;
      }

      const product = await Product.create(productData);

      // Clear cache
      await clearProductCache();

      logger.info(`📦 Product created: ${product.name} (${product._id}) by ${req.user.email} (${req.user._id})`);

      res.status(201).json({
        success: true,
        product
      });
    } catch (err) {
     
      if (err?.code === 11000 && err?.keyPattern?.slug) {
        return next(new AppError('A product with a very similar name already exists. Please try a different name.', 409));
      }
      logger.error('❌ Error creating product:', err);
      next(err);
    }
  }
);

// ── ADMIN: UPDATE PRODUCT ─────────────────────────────────────────
router.patch('/:id',
  protect,
  restrictTo(...STAFF_ROLES),
  requirePermission(PERMISSIONS.PRODUCTS_UPDATE),
  async (req, res, next) => {
    try {
      
      const disallowed = ['_id', 'reviews', 'rating', 'numReviews', 'totalSold', 'slug'];
      disallowed.forEach((f) => delete req.body[f]);

     
      if (req.body.images !== undefined) {
        req.body.images = normalizeImageInputs(req.body.images) || [];
      }

      // If name is being updated, regenerate a unique slug too
      if (req.body.name) {
        req.body.slug = await generateUniqueSlug(req.body.name, req.params.id);
      }

      const product = await Product.findByIdAndUpdate(
        req.params.id,
        req.body,
        {
          returnDocument: 'after',
          runValidators: true,
          select: '-__v',
        }
      );

      if (!product) {
        return next(new AppError('Product not found', 404));
      }

      // Clear cache
      await clearProductCache(product.slug);

      logger.info(`📝 Product updated: ${product._id} by ${req.user.email} (${req.user._id})`);

      res.json({
        success: true,
        product
      });
    } catch (err) {
      if (err?.code === 11000 && err?.keyPattern?.slug) {
        return next(new AppError('A product with a very similar name already exists. Please try a different name.', 409));
      }
      logger.error('❌ Error updating product:', err);
      next(err);
    }
  }
);

// ── ADMIN: UPLOAD IMAGES ──────────────────────────────────────────

router.post(
  '/:id/images',
  protect,
  restrictTo(...STAFF_ROLES),
  requirePermission(PERMISSIONS.PRODUCTS_CREATE),
  // Check Cloudinary configuration
  (req, res, next) => {
    if (!isConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'Image upload service is not available. Please configure Cloudinary.',
      });
    }
    next();
  },
  // Handle upload - this processes the files
  handleUpload('images', MAX_FILES),
  // Main upload handler
  async (req, res, next) => {
    // Store uploaded file info for cleanup if something fails
    const uploadedFiles = [];
    
    try {
      // Check if files were uploaded
      if (!req.files || req.files.length === 0) {
        return next(new AppError('No images uploaded', 400));
      }

      // Find product
      const product = await Product.findById(req.params.id).select('images name slug');
      if (!product) {
        // Clean up uploaded files if product not found
        await cleanupUploadedFiles(req.files);
        return next(new AppError('Product not found', 404));
      }

      // Check image limit (max 10 images per product)
      const totalAfterUpload = product.images.length + req.files.length;
      if (totalAfterUpload > 10) {
        // Clean up uploaded files if limit exceeded
        await cleanupUploadedFiles(req.files);
        return next(new AppError(
          `Product cannot have more than 10 images. Currently has ${product.images.length}.`,
          400
        ));
      }

      // ✅ Extract Cloudinary URLs from uploaded files
      const newImageUrls = req.files.map((file) => {
        // Multer-Cloudinary stores the URL in file.path or file.secure_url
        const url = file.path || file.secure_url || file.location;
        
        // Store public ID for potential cleanup
        if (file.public_id || file.filename) {
          uploadedFiles.push(file.public_id || file.filename);
        }
        
        return url;
      });

      // ✅ Add images to product
      product.images.push(...newImageUrls);
      await product.save({ validateBeforeSave: false });

      // Clear cache
      await clearProductCache(product.slug);

      logger.info(`📸 ${uploadedFiles.length} image(s) uploaded for product ${product._id} by ${req.user.email} (${req.user._id})`);

      res.status(201).json({
        success: true,
        message: `${uploadedFiles.length} image(s) uploaded successfully`,
        images: product.images.map((id) => getOptimizedUrl(id)),
        thumbnail: product.images[0] ? getThumbnailUrl(product.images[0]) : null,
       
        imagePublicIds: product.images,
      });
    } catch (err) {
     
      if (uploadedPublicIds.length) {
        await deleteMultipleFromCloudinary(uploadedFiles.map((file) => file.public_id || file.filename));
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
  restrictTo(...STAFF_ROLES),
  requirePermission(PERMISSIONS.PRODUCTS_UPDATE),
  [
    body('publicId').notEmpty().withMessage('publicId is required'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) {
        return next(new AppError('Product not found', 404));
      }

      const { publicId } = req.body;

      // Verify image belongs to product
      if (!product.images.includes(publicId)) {
        return next(new AppError('Image not found on this product', 404));
      }

      
      const resolvedId = publicId.includes('http')
        ? extractCloudinaryPublicId(publicId)
        : publicId;

      if (!resolvedId) {
        logger.warn(`⚠️ Could not resolve Cloudinary public_id: ${publicId}`);
      } else {
        const result = await deleteFromCloudinary(resolvedId);
        if (result?.result === 'error' || result?.result === 'not found') {
          logger.warn(`⚠️ Failed to delete from Cloudinary (public_id: ${resolvedId}): ${JSON.stringify(result)}`);
        }
      }

      // Remove from DB
      product.images = product.images.filter((img) => img !== publicId);
      await product.save({ validateBeforeSave: false });

      // Clear cache
      await clearProductCache(product.slug);

      logger.info(`🗑️ Image deleted from product ${product._id} by ${req.user.email} (${req.user._id})`);

      res.json({
        success: true,
        message: 'Image deleted successfully',
        images: product.images.map((id) => getOptimizedUrl(id)),
        imagePublicIds: product.images,
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
  restrictTo(...STAFF_ROLES),
  requirePermission(PERMISSIONS.PRODUCTS_UPDATE),
  [
    body('images').isArray({ min: 1 }).withMessage('images must be a non-empty array'),
   
    body('images.*').notEmpty().withMessage('Each image entry must be a valid public_id'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) {
        return next(new AppError('Product not found', 404));
      }

      const incoming = req.body.images;

      const invalid = incoming.filter((id) => !product.images.includes(id));
      if (invalid.length > 0) {
        return next(new AppError('One or more images do not belong to this product', 400));
      }
      if (incoming.length !== product.images.length) {
        return next(new AppError('Reordered images must include every existing image exactly once', 400));
      }

      product.images = incoming;
      await product.save({ validateBeforeSave: false });

      // Clear cache
      await clearProductCache(product.slug);

      logger.info(`🔄 Images reordered for product ${product._id} by ${req.user.email} (${req.user._id})`);

      res.json({
        success: true,
        images: product.images.map((id) => getOptimizedUrl(id)),
        imagePublicIds: product.images,
      });
    } catch (err) {
      logger.error('❌ Error reordering images:', err);
      next(err);
    }
  }
);

// ── ADMIN: SOFT DELETE PRODUCT ────────────────────────────────────
router.delete('/:id',
  protect,
  restrictTo(...STAFF_ROLES),
  requirePermission(PERMISSIONS.PRODUCTS_DELETE),
  async (req, res, next) => {
    try {
      const product = await Product.findByIdAndUpdate(
        req.params.id,
        { isActive: false },
        { returnDocument: 'after' }
      );

      if (!product) {
        return next(new AppError('Product not found', 404));
      }

      // Clear cache
      await clearProductCache(product.slug);

      logger.info(`🚫 Product deactivated: ${product._id} by ${req.user.email} (${req.user._id})`);

      res.json({
        success: true,
        message: 'Product deactivated successfully'
      });
    } catch (err) {
      logger.error('❌ Error deactivating product:', err);
      next(err);
    }
  }
);

// ── ADMIN: PERMANENTLY DELETE PRODUCT ────────────────────────────
router.delete('/:id/permanent',
  protect,
  restrictTo(...STAFF_ROLES),
  requirePermission(PERMISSIONS.PRODUCTS_DELETE),
  async (req, res, next) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) {
        return next(new AppError('Product not found', 404));
      }

      // Delete all images from Cloudinary. `images` stores public_ids
    
      if (product.images.length > 0 && isConfigured()) {
        const publicIds = product.images
          .map((img) => (img.includes('http') ? extractCloudinaryPublicId(img) : img))
          .filter(Boolean);

        if (publicIds.length > 0) {
          await deleteMultipleFromCloudinary(publicIds);
          logger.info(`🗑️ Deleted ${publicIds.length} image(s) for product ${product._id}`);
        }
        if (publicIds.length !== product.images.length) {
          logger.warn(`⚠️ Could not resolve public_id for ${product.images.length - publicIds.length} image(s) on product ${product._id}`);
        }
      }

      await product.deleteOne();

      // Clear cache
      await clearProductCache();

      logger.info(`💀 Product permanently deleted: ${product._id} by ${req.user.email} (${req.user._id})`);

      res.json({
        success: true,
        message: 'Product permanently deleted',
      });
    } catch (err) {
      logger.error('❌ Error deleting product:', err);
      next(err);
    }
  }
);

// ── ADMIN: GET ALL PRODUCTS (Admin View) ──────────────────────────
router.get('/admin/all',
  protect,
  restrictTo(...STAFF_ROLES),
  requirePermission(PERMISSIONS.PRODUCTS_VIEW),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('includeInactive').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20, includeInactive = false, search } = req.query;

      const filter = {};
      if (includeInactive !== 'true') {
        filter.isActive = true;
      }
      if (search) {
        filter.$text = { $search: search };
      }

      const pageNum = Math.max(1, parseInt(page));
      const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
      const skip = (pageNum - 1) * limitNum;

      const [products, total] = await Promise.all([
        Product.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .select('-__v')
          .lean(),
        Product.countDocuments(filter),
      ]);

     
      const productsWithUrls = products.map((product) => ({
        ...product,
        thumbnail: product.images?.length > 0
          ? getThumbnailUrl(product.images[0])
          : null,
        images: product.images?.map((img) => getOptimizedUrl(img)) || [],
        imagePublicIds: product.images || [],
      }));

      res.json({
        success: true,
        products: productsWithUrls,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        },
      });
    } catch (err) {
      logger.error('❌ Error fetching admin products:', err);
      next(err);
    }
  }
);

module.exports = router;