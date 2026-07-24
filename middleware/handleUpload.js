'use strict';

const multer = require('multer');

/**
 * handleUpload — wraps multer middleware and converts its errors
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

      // ── Multer-specific errors ──
      if (err instanceof multer.MulterError) {
        switch (err.code) {
          case 'LIMIT_FILE_SIZE':
            return res.status(400).json({
              success: false,
              error: `File too large. Maximum size is 5MB per image.`,
              code: err.code,
            });
          
          case 'LIMIT_FILE_COUNT':
            return res.status(400).json({
              success: false,
              error: `Too many files. Maximum ${maxCount} images per upload.`,
              code: err.code,
            });
          
          case 'LIMIT_UNEXPECTED_FILE':
            return res.status(400).json({
              success: false,
              error: `Unexpected field name. Use '${fieldName}' as the field name.`,
              code: err.code,
            });
          
          case 'LIMIT_PART_COUNT':
            return res.status(400).json({
              success: false,
              error: 'Too many parts in the upload.',
              code: err.code,
            });
          
          default:
            return res.status(400).json({
              success: false,
              error: `Upload error: ${err.message}`,
              code: err.code,
            });
        }
      }

      // ── File type rejection from our fileFilter ──
      if (err?.message) {
        const lowerMessage = err.message.toLowerCase();
        if (
          lowerMessage.includes('jpeg') ||
          lowerMessage.includes('png') ||
          lowerMessage.includes('webp') ||
          lowerMessage.includes('image') ||
          lowerMessage.includes('file type')
        ) {
          return res.status(400).json({
            success: false,
            error: err.message,
            code: 'INVALID_FILE_TYPE',
          });
        }
      }

      // ── Cloudinary / network errors ──
      console.error('❌ Image upload error:', err);
      console.error('❌ Error stack:', err.stack);

      return res.status(500).json({
        success: false,
        error: 'Image upload failed. Please try again.',
        ...(process.env.NODE_ENV !== 'production' && { details: err.message }),
      });
    });
  };
}

module.exports = { handleUpload };