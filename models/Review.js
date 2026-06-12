'use strict';
// models/Review.js

const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
  {
    product: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'Product',
      required: true,
      index:    true,
    },
    user: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      'User',
      required: true,
    },
    rating: {
      type:     Number,
      required: true,
      min:      1,
      max:      5,
    },
    comment: {
      type:      String,
      required:  true,
      maxlength: 1000,
      trim:      true,
    },
    status: {
      type:    String,
      enum:    ['pending', 'approved', 'rejected'],
      default: 'pending',
      index:   true,
    },
    rejectedReason: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// One review per user per product
reviewSchema.index({ product: 1, user: 1 }, { unique: true });

// After save — update product's average rating
reviewSchema.post('save', async function () {
  await updateProductRating(this.product);
});

reviewSchema.post('findOneAndUpdate', async function (doc) {
  if (doc) await updateProductRating(doc.product);
});

async function updateProductRating(productId) {
  const Review  = mongoose.model('Review');
  const Product = mongoose.model('Product');

  const stats = await Review.aggregate([
    { $match: { product: productId, status: 'approved' } },
    {
      $group: {
        _id:        '$product',
        avgRating:  { $avg: '$rating' },
        numReviews: { $sum: 1 },
      },
    },
  ]);

  if (stats.length) {
    await Product.findByIdAndUpdate(productId, {
      rating:     Math.round(stats[0].avgRating * 10) / 10,
      numReviews: stats[0].numReviews,
    });
  } else {
    await Product.findByIdAndUpdate(productId, { rating: 0, numReviews: 0 });
  }
}

module.exports = mongoose.model('Review', reviewSchema);
