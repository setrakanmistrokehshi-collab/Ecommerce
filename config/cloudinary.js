'use strict';

const cloudinary        = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
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
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_FILES     = 5;

// ── STORAGE ───────────────────────────────────────────────────────
const storage = new CloudinaryStorage({   // ✅ constructor, not function call
  cloudinary,
  params: {                               // ✅ params not uploadOptions
    folder:          'winners/products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [
      {
        width:        800,
        height:       800,
        crop:         'limit',            // ✅ valid crop mode
        quality:      'auto',
        fetch_format: 'auto',
      },
    ],
    // ✅ public_id must be a function — called fresh on every request
    public_id: (req, file) => `product_${randomUUID()}_${Date.now()}`,
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
    fileSize: MAX_FILE_SIZE,
    files:    MAX_FILES,
  },
});

// ── DELETE FROM CLOUDINARY ────────────────────────────────────────
// publicId = full path: "winners/products/product_xxx_123"
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