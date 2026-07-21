'use strict';

const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const streamifier = require('streamifier');
const { randomUUID } = require('crypto');
const logger = require('../utils/logger');

/* -------------------------------------------------------------------------- */
/*                                CONFIGURATION                               */
/* -------------------------------------------------------------------------- */

const isConfigured = () =>
  Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );

if (!isConfigured()) {
  logger.warn('Cloudinary credentials are missing.');
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

/* -------------------------------------------------------------------------- */

const DEFAULT_FOLDER = 'winners/products';

const MAX_FILE_SIZE = 5 * 1024 * 1024; //5MB

const MAX_FILES = 5;

const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/* -------------------------------------------------------------------------- */
/*                               MULTER CONFIG                                */
/* -------------------------------------------------------------------------- */

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIMES.has(file.mimetype)) {
    return cb(new Error('Unsupported image type'));
  }

  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  },
});

const uploadSingle = upload.single('image');

const uploadMultiple = upload.array('images', MAX_FILES);

/* -------------------------------------------------------------------------- */
/*                          CLOUDINARY STREAM UPLOAD                          */
/* -------------------------------------------------------------------------- */

function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || DEFAULT_FOLDER,

        public_id:
          options.public_id ||
          `product_${randomUUID().replace(/-/g, '')}`,

        overwrite: false,

        resource_type: 'image',

        quality: 'auto',

        fetch_format: 'auto',

        transformation: [
          {
            width: 1200,
            height: 1200,
            crop: 'limit',
          },
        ],

        ...options,
      },

      (err, result) => {
        if (err) return reject(err);

        resolve(result);
      }
    );

    streamifier.createReadStream(buffer).pipe(stream);
  });
}

/* -------------------------------------------------------------------------- */

async function uploadToCloudinary(file, options = {}) {
  if (!isConfigured()) {
    throw new Error('Cloudinary is not configured.');
  }

  if (!file || !file.buffer) {
    throw new Error('Invalid upload.');
  }

  try {
    const result = await uploadBuffer(file.buffer, options);

    logger.info(`Uploaded ${result.public_id}`);

    return result;
  } catch (err) {
    logger.error(err);

    throw err;
  }
}

/* -------------------------------------------------------------------------- */

async function deleteFromCloudinary(publicId) {
  if (!publicId) return null;

  try {
    return await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    logger.error(err);

    return null;
  }
}

/* -------------------------------------------------------------------------- */

async function deleteMultipleFromCloudinary(publicIds = []) {
  if (!publicIds.length) return [];

  return Promise.all(
    publicIds.map((id) => deleteFromCloudinary(id))
  );
}

/* -------------------------------------------------------------------------- */

function getOptimizedUrl(publicId, options = {}) {
  if (!publicId) return null;

  return cloudinary.url(publicId, {
    secure: true,

    width: options.width || 800,

    height: options.height || 800,

    crop: options.crop || 'limit',

    quality: options.quality || 'auto',

    fetch_format: 'auto',
  });
}

function getThumbnailUrl(publicId) {
  return getOptimizedUrl(publicId, {
    width: 250,
    height: 250,
    crop: 'fill',
    gravity: 'auto',
  });
}

/* -------------------------------------------------------------------------- */

function handleMulterError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: err.message,
      code: err.code,
    });
  }

  if (err) {
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  next();
}

/* -------------------------------------------------------------------------- */

module.exports = {
  cloudinary,

  upload,

  uploadSingle,

  uploadMultiple,

  uploadToCloudinary,

  deleteFromCloudinary,

  deleteMultipleFromCloudinary,

  getOptimizedUrl,

  getThumbnailUrl,

  handleMulterError,

  isConfigured,

  DEFAULT_FOLDER,

  MAX_FILE_SIZE,

  MAX_FILES,
};