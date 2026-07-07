const mongoose = require('mongoose');

const promoCodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: 30,
    },
    discount: {
      type: Number, // 0.15 = 15%
      required: true,
      min: 0,
      max: 1,
    },
    description: { type: String, default: '' },
    firstOrderOnly: { type: Boolean, default: false },
    maxUses: { type: Number, default: null },
    perUserLimit: { type: Number, default: 1 },
    usedCount: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PromoCode', promoCodeSchema);