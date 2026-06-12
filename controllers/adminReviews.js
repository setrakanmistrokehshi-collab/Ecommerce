'use strict';
// controllers/adminReviews.js
// Powers:
//   GET   /api/v1/admin/reviews
//   PATCH /api/v1/admin/reviews/:id/approve
//   PATCH /api/v1/admin/reviews/:id/reject

const Review  = require('../models/Review');
const logger  = require('../utils/logger');

/**
 * GET /api/v1/admin/reviews
 * Query params:
 *   status = pending | approved | rejected | (all if omitted)
 *   page   = 1
 *   limit  = 20
 *   product = productId  (filter by product)
 */
async function getReviews(req, res) {
  try {
    const { status, product, page = 1, limit = 20 } = req.query;

    const filter = {};
    if (status  && status !== 'all') filter.status  = status;
    if (product) filter.product = product;

    const skip  = (parseInt(page, 10)  - 1) * parseInt(limit, 10);
    const total = await Review.countDocuments(filter);

    const reviews = await Review
      .find(filter)
      .populate('user',    'name email')
      .populate('product', 'name emoji category')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit, 10))
      .lean();

    // Summary counts for KPI cards
    const [pending, approved, rejected, all] = await Promise.all([
      Review.countDocuments({ status: 'pending'  }),
      Review.countDocuments({ status: 'approved' }),
      Review.countDocuments({ status: 'rejected' }),
      Review.countDocuments({}),
    ]);

    const avgRating = all
      ? (await Review.aggregate([
          { $match: { status: 'approved' } },
          { $group: { _id: null, avg: { $avg: '$rating' } } },
        ]))[0]?.avg?.toFixed(1) ?? '0.0'
      : '0.0';

    res.json({
      success: true,
      reviews,
      total,
      page:    parseInt(page, 10),
      pages:   Math.ceil(total / parseInt(limit, 10)),
      summary: { pending, approved, rejected, avgRating },
    });
  } catch (err) {
    logger.error('getReviews error:', err);
    res.status(500).json({ success: false, error: 'Failed to load reviews' });
  }
}

/**
 * PATCH /api/v1/admin/reviews/:id/approve
 */
async function approveReview(req, res) {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ success: false, error: 'Review not found' });

    review.status = 'approved';
    await review.save(); // triggers post-save hook to update product rating

    logger.info(`Review ${review._id} approved by admin ${req.user._id}`);
    res.json({ success: true, message: 'Review approved', review });
  } catch (err) {
    logger.error('approveReview error:', err);
    res.status(500).json({ success: false, error: 'Failed to approve review' });
  }
}

/**
 * PATCH /api/v1/admin/reviews/:id/reject
 * Body: { reason? }
 */
async function rejectReview(req, res) {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return res.status(404).json({ success: false, error: 'Review not found' });

    review.status         = 'rejected';
    review.rejectedReason = req.body.reason ?? 'Does not meet community guidelines';
    await review.save(); // triggers post-save hook to update product rating

    logger.info(`Review ${review._id} rejected by admin ${req.user._id}`);
    res.json({ success: true, message: 'Review rejected', review });
  } catch (err) {
    logger.error('rejectReview error:', err);
    res.status(500).json({ success: false, error: 'Failed to reject review' });
  }
}

/**
 * DELETE /api/v1/admin/reviews/:id  (optional — hard delete)
 */
async function deleteReview(req, res) {
  try {
    const review = await Review.findByIdAndDelete(req.params.id);
    if (!review) return res.status(404).json({ success: false, error: 'Review not found' });

    res.json({ success: true, message: 'Review deleted' });
  } catch (err) {
    logger.error('deleteReview error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete review' });
  }
}

module.exports = { getReviews, approveReview, rejectReview, deleteReview };
