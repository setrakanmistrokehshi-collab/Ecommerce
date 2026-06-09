'use strict';

const multer = require('multer');

/**
 * handleUploadError — wraps multer middleware and converts its errors
 * into the same JSON shape as the rest of the API.
 *
 * Usage (in routes):
 *   router.post('/:id/images', protect, restrictTo('admin'),
 *     handleUpload('images', 5), uploadImages);
 */
function handleUpload(fieldName, maxCount = 5) {
  const { upload } = require('../config/cloudinary');
  const multerMiddleware = upload.array(fieldName, maxCount);

  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (!err) return next();

      // Multer-specific errors
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            error: 'Each image must be under 5MB',
          });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return res.status(400).json({
            success: false,
            error: 'Maximum 5 images per upload',
          });
        }
        return res.status(400).json({
          success: false,
          error: `Upload error: ${err.message}`,
        });
      }

      // File type rejection from our fileFilter
      if (err?.message?.includes('JPEG') || err?.message?.includes('PNG')) {
        return res.status(400).json({
          success: false,
          error: err.message,
        });
      }

      // Cloudinary / network errors
      return res.status(500).json({
        success: false,
        error: 'Image upload failed. Please try again.',
      });
    });
  };
}

module.exports = { handleUpload };
