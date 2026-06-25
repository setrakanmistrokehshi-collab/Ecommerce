// routes/categories.js
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const Category = require('../models/Category');
const { protect, restrictTo } = require('../middleware/auth');
const { requirePermission } = require('../middleware/requirePermission');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const auditLog = require('../middleware/adminAudit');
const { PERMISSIONS, STAFF_ROLES } = require('../config/permission');

const router = express.Router();

// Validation helper
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ success: false, errors: errors.array() });
  }
  next();
}

// ── PUBLIC ROUTES (no auth required) ──────────────────────────────
// Get all categories (for storefront)
router.get('/', async (req, res, next) => {
  try {
    const categories = await Category.find({ isActive: true })
      .select('name slug description image')
      .sort({ order: 1, name: 1 });
    
    res.json({ success: true, categories });
  } catch (err) {
    next(err);
  }
});

// Get single category by slug
router.get('/:slug', async (req, res, next) => {
  try {
    const category = await Category.findOne({ slug: req.params.slug, isActive: true });
    if (!category) {
      return next(new AppError('Category not found', 404));
    }
    res.json({ success: true, category });
  } catch (err) {
    next(err);
  }
});

// ── ADMIN ROUTES (require authentication) ──────────────────────────
// All admin routes require auth and permissions
router.use(protect, restrictTo(...STAFF_ROLES), auditLog);

// Get all categories (admin view - includes inactive)
router.get('/admin', requirePermission(PERMISSIONS.PRODUCTS_VIEW), async (req, res, next) => {
  try {
    const { includeInactive } = req.query;
    const filter = includeInactive === 'true' ? {} : { isActive: true };
    
    const categories = await Category.find(filter)
      .sort({ order: 1, name: 1 })
      .lean();
    
    // Get product count for each category
    const Product = require('../models/Product');
    const categoriesWithCount = await Promise.all(
      categories.map(async (cat) => {
        const count = await Product.countDocuments({ 
          category: cat._id, 
          isActive: true 
        });
        return { ...cat, productCount: count };
      })
    );
    
    res.json({ success: true, categories: categoriesWithCount });
  } catch (err) {
    next(err);
  }
});

// Create category
router.post('/admin', 
  requirePermission(PERMISSIONS.PRODUCTS_CREATE),
  [
    body('name').notEmpty().withMessage('Category name is required')
      .isLength({ max: 100 }).withMessage('Name must be less than 100 characters'),
    body('description').optional().isString().isLength({ max: 500 }),
    body('image').optional().isString().isURL().withMessage('Invalid image URL'),
    body('order').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, description, image, order } = req.body;
      
      // Check if category already exists
      const existing = await Category.findOne({ 
        name: { $regex: new RegExp(`^${name}$`, 'i') } 
      });
      if (existing) {
        return next(new AppError('Category with this name already exists', 400));
      }
      
      // Generate slug from name
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      
      const category = await Category.create({
        name,
        slug,
        description,
        image,
        order: order || 0,
        isActive: true,
      });
      
      logger.info(`Category created: ${category.name} by ${req.user.email}`);
      
      res.status(201).json({ 
        success: true, 
        category,
        message: 'Category created successfully'
      });
    } catch (err) {
      next(err);
    }
  }
);

// Update category
router.put('/admin/:id',
  requirePermission(PERMISSIONS.PRODUCTS_UPDATE),
  [
    param('id').isMongoId().withMessage('Invalid category ID'),
    body('name').optional().isString().isLength({ max: 100 }),
    body('description').optional().isString().isLength({ max: 500 }),
    body('image').optional().isString().isURL().withMessage('Invalid image URL'),
    body('order').optional().isInt({ min: 0 }),
    body('isActive').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { name, description, image, order, isActive } = req.body;
      
      const category = await Category.findById(req.params.id);
      if (!category) {
        return next(new AppError('Category not found', 404));
      }
      
      // Update fields
      if (name) {
        // Check if another category has this name
        const existing = await Category.findOne({
          name: { $regex: new RegExp(`^${name}$`, 'i') },
          _id: { $ne: req.params.id }
        });
        if (existing) {
          return next(new AppError('Category with this name already exists', 400));
        }
        
        category.name = name;
        // Update slug if name changed
        category.slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }
      
      if (description !== undefined) category.description = description;
      if (image !== undefined) category.image = image;
      if (order !== undefined) category.order = order;
      if (isActive !== undefined) category.isActive = isActive;
      
      await category.save();
      
      logger.info(`Category updated: ${category.name} by ${req.user.email}`);
      
      res.json({ 
        success: true, 
        category,
        message: 'Category updated successfully'
      });
    } catch (err) {
      next(err);
    }
  }
);

// Delete category
router.delete('/admin/:id',
  requirePermission(PERMISSIONS.PRODUCTS_DELETE),
  [
    param('id').isMongoId().withMessage('Invalid category ID'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const category = await Category.findById(req.params.id);
      if (!category) {
        return next(new AppError('Category not found', 404));
      }
      
      // Check if category has products
      const Product = require('../models/Product');
      const productCount = await Product.countDocuments({ 
        category: category._id,
        isActive: true 
      });
      
      if (productCount > 0) {
        return next(new AppError(
          `Cannot delete category with ${productCount} products. Move or delete products first.`,
          400
        ));
      }
      
      await category.deleteOne();
      
      logger.info(`Category deleted: ${category.name} by ${req.user.email}`);
      
      res.json({ 
        success: true, 
        message: 'Category deleted successfully'
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;