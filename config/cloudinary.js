'use strict';

const cloudinary        = require('cloudinary').v2;
const cloudinaryStorage = require('cloudinary-multer');
const multer            = require('multer');
const { randomUUID }    = require('crypto');
const logger            = require('../utils/logger');

// ── CLOUDINARY INIT ───────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
});

// ── CONSTANTS ─────────────────────────────────────────────────────
const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per file
const MAX_FILES     = 5;               // max per upload call

// ── STORAGE (cloudinary-multer) ───────────────────────────────────
// cloudinary-multer passes req.file fields directly from Cloudinary's
// upload_stream response, so req.file will contain:
//   req.file.public_id   → "winners/products/product_xxx_123"
//   req.file.secure_url  → "https://res.cloudinary.com/..."
//   req.file.url         → http variant (use secure_url instead)
//   req.file.format, width, height, bytes, etc.
const storage = cloudinaryStorage({
  cloudinary,
  uploadOptions: {
    folder:         'winners/products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [
      {
        width:        500,
        height:       500,
        crop:         'auto',
        quality:      'auto',
        fetch_format: 'auto',
      },
    ],
    // public_id scoped inside folder — Cloudinary stores as "winners/products/<value>"
    public_id: `product_${randomUUID()}_${Date.now()}`,
  },
});

// ── FILE FILTER ───────────────────────────────────────────────────
function fileFilter(req, file, cb) {
  if (!ALLOWED_MIMES.includes(file.mimetype)) {
    return cb(new Error('Only JPEG, PNG and WebP images are allowed'), false);
  }
  cb(null, true);
}

// ── MULTER INSTANCE ───────────────────────────────────────────────
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize:  MAX_FILE_SIZE,
    files:     MAX_FILES,
    fieldSize: 10 * 1024,
  },
});

// ── HELPER: delete by full public_id from Cloudinary ─────────────
// public_id here is the full path including folder:
//   "winners/products/product_xxx_123"
async function deleteFromCloudinary(publicId) {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    logger.info(`Cloudinary delete: ${publicId} → ${result.result}`);
    return result;
  } catch (err) {
    logger.error('Cloudinary delete failed:', err.message);
    return null;
  }
}

module.exports = { cloudinary, upload, deleteFromCloudinary, MAX_FILES };
