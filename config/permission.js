'use strict';
// config/permissions.js
// Single source of truth for every admin permission.
// Used by: User model, JWT signing, requirePermission middleware.

const PERMISSIONS = {
  DASHBOARD_VIEW:    'dashboard.view',

  ORDERS_VIEW:       'orders.view',
  ORDERS_UPDATE:     'orders.update',
  ORDERS_NOTIFY:     'orders.notify',

  PRODUCTS_VIEW:     'products.view',
  PRODUCTS_CREATE:   'products.create',
  PRODUCTS_UPDATE:   'products.update',
  PRODUCTS_DELETE:   'products.delete',
  PRODUCTS_STOCK:    'products.stock',
  PRODUCTS_IMAGES:   'products.images',

  CATEGORIES_VIEW:   'categories.view',
  CATEGORIES_MANAGE: 'categories.manage',

  CUSTOMERS_VIEW:    'customers.view',
  CUSTOMERS_UPDATE:  'customers.update',
  CUSTOMERS_DELETE:  'customers.delete',

  REVIEWS_VIEW:      'reviews.view',
  REVIEWS_MODERATE:  'reviews.moderate',
  REVIEWS_DELETE:    'reviews.delete',

  REPORTS_VIEW:      'reports.view',

  SETTINGS_VIEW:     'settings.view',
  SETTINGS_UPDATE:   'settings.update',

  STAFF_VIEW:        'staff.view',
  STAFF_MANAGE:      'staff.manage',
};

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

// ── ROLE PRESETS ───────────────────────────────────────────────────
// A role is just a named bundle of permissions.
// New staff get a preset; you can still add/remove individual
// permissions on top of the preset per-user if needed.

const ROLE_PRESETS = {
  super_admin: ALL_PERMISSIONS,

  product_manager: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.PRODUCTS_VIEW,
    PERMISSIONS.PRODUCTS_CREATE,
    PERMISSIONS.PRODUCTS_UPDATE,
    PERMISSIONS.PRODUCTS_DELETE,
    PERMISSIONS.PRODUCTS_STOCK,
    PERMISSIONS.PRODUCTS_IMAGES,
    PERMISSIONS.CATEGORIES_VIEW,
    PERMISSIONS.CATEGORIES_MANAGE,
    PERMISSIONS.REPORTS_VIEW,
  ],

  order_manager: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.ORDERS_UPDATE,
    PERMISSIONS.ORDERS_NOTIFY,
    PERMISSIONS.CUSTOMERS_VIEW,
    PERMISSIONS.REPORTS_VIEW,
  ],

  support_agent: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.CUSTOMERS_VIEW,
    PERMISSIONS.REVIEWS_VIEW,
    PERMISSIONS.REVIEWS_MODERATE,
  ],
};

/**
 * Returns the permission array for a given role.
 * Falls back to an empty array for unknown roles (safe default — deny by default).
 */
function getPermissionsForRole(role) {
  return ROLE_PRESETS[role] ?? [];
}

// All staff role names — i.e. every role except the regular customer 'user' role.
// Used as the base auth gate in routes/admin.js: restrictTo(...STAFF_ROLES)
const STAFF_ROLES = Object.keys(ROLE_PRESETS);

module.exports = { PERMISSIONS, ALL_PERMISSIONS, ROLE_PRESETS, STAFF_ROLES, getPermissionsForRole };
