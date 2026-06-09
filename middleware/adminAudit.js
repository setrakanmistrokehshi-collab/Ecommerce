'use strict';

const AdminLog = require('../models/AdminLog');
const logger   = require('../utils/logger');

const auditLog = (req, res, next) => {
  const { password, token, secret, ...safeBody } = req.body || {};

  AdminLog.create({
    adminId:   req.user?._id,
    adminName: req.user?.name,
    action:    `${req.method} ${req.originalUrl}`,
    body:      safeBody,
    ip:        req.ip,
    userAgent: req.headers['user-agent'],
  }).catch(err => logger.error('Audit log failed:', err));

  next();
};

module.exports = auditLog;