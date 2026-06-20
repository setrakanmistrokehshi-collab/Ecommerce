'use strict';
// middleware/requirePermission.js
// Use alongside `protect` to gate routes by specific permission(s)


const { AppError } = require('./errorHandler');

/**
 * requirePermission('products.delete')
 * requirePermission('orders.view', 'orders.update')   // requires ALL listed
 *
 */
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('You are not logged in.', 401));
    }

    // super_admin always passes — convenience escape hatch
    if (req.user.role === 'super_admin') return next();

    if (typeof req.user.hasAllPermissions !== 'function') {
      // Model wasn't updated with permission methods yet
      return next(new AppError('Permission system not configured on this user.', 500));
    }

    if (!req.user.hasAllPermissions(permissions)) {
      return next(new AppError(
        `You don't have permission to perform this action (requires: ${permissions.join(', ')})`,
        403
      ));
    }

    next();
  };
}

/**
 * requireAnyPermission('orders.view', 'orders.update')
 * Passes if user has AT LEAST ONE of the listed permissions.
 * Useful for read-only views that multiple roles can access.
 */
function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('You are not logged in.', 401));
    }

    if (req.user.role === 'super_admin') return next();

    if (!req.user.hasAnyPermission(permissions)) {
      return next(new AppError(
        `You don't have permission to perform this action (requires one of: ${permissions.join(', ')})`,
        403
      ));
    }

    next();
  };
}

module.exports = { requirePermission, requireAnyPermission };
