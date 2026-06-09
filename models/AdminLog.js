// models/AdminLog.js
const mongoose = require('mongoose');
const adminLogSchema = new mongoose.Schema({
  adminId:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  adminName: String,
  action:    String,   // e.g. "PATCH /api/v1/admin/orders/123/status"
  body:      Object,   // what they sent
  ip:        String,
  userAgent: String,
  timestamp: { type: Date, default: Date.now },
});

module.exports = mongoose.model('AdminLog', adminLogSchema);