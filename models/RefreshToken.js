// models/RefreshToken.js
const mongoose = require('mongoose');

const refreshTokenSchema = new mongoose.Schema({
  tokenId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tokenVersion: { type: Number, required: true },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false },
  revoked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  deviceInfo: String,
  ipAddress: String,
  userAgent: String,
});

module.exports = mongoose.model('RefreshToken', refreshTokenSchema);