'use strict';

const mongoose = require('mongoose');

const emailLogSchema = new mongoose.Schema({
  event: { type: String, required: true, index: true }, // delivered | hardBounce | blocked | opened | etc.
  recipient: { type: String, required: true, index: true },
  messageId: { type: String, index: true },
  tags: [{ type: String }],
  receivedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('EmailLog', emailLogSchema);