'use strict';
// controllers/adminStats.js
// Powers GET /api/v1/admin/stats  — the dashboard page

const mongoose = require('mongoose');
const Order    = require('../models/Order');
const User     = require('../models/User');
const Product  = require('../models/Product');
const logger   = require('../utils/logger');

/**
 * GET /api/v1/admin/stats
 * Returns all KPIs, charts, inventory, and top products for the dashboard.
 * Query params:
 *   period = '7d' | '30d' | '90d' | 'today'  (default: '7d')
 */
async function getDashboardStats(req, res) {
  try {
    const period  = req.query.period ?? '7d';
    const { from, prev } = getPeriodDates(period);
    const now     = new Date();

    // ── Run all queries in parallel ──────────────────────────────
    const [
      revenueAgg,
      prevRevenueAgg,
      orderCount,
      prevOrderCount,
      customerCount,
      prevCustomerCount,
      pendingCount,
      cancelledCount,
      products,
      salesChart,
      categoryBreakdown,
    ] = await Promise.all([

      // Revenue this period
      Order.aggregate([
        { $match: { createdAt: { $gte: from }, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, total: { $sum: '$totalPrice' } } },
      ]),

      // Revenue previous period
      Order.aggregate([
        { $match: { createdAt: { $gte: prev, $lt: from }, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, total: { $sum: '$totalPrice' } } },
      ]),

      // Orders this period
      Order.countDocuments({ createdAt: { $gte: from } }),

      // Orders prev period
      Order.countDocuments({ createdAt: { $gte: prev, $lt: from } }),

      // Customers this period
      User.countDocuments({ role: 'user', createdAt: { $gte: from } }),

      // Customers prev period
      User.countDocuments({ role: 'user', createdAt: { $gte: prev, $lt: from } }),

      // Pending orders
      Order.countDocuments({ status: 'pending' }),

      // Cancelled this period
      Order.countDocuments({ status: 'cancelled', createdAt: { $gte: from } }),

      // All products (for inventory)
      Product.find({}, 'name stock emoji category price').lean(),

      // Daily sales chart (last 7 or 30 days)
      buildSalesChart(from, now),

      // Revenue by category
      buildCategoryBreakdown(from),
    ]);

    // ── Calculate deltas ─────────────────────────────────────────
    const revenue     = revenueAgg[0]?.total     ?? 0;
    const prevRevenue = prevRevenueAgg[0]?.total  ?? 0;
    const netProfit   = Math.round(revenue * 0.462); // 46.2% margin

    // ── Inventory data ───────────────────────────────────────────
    const inventory = products.map(p => ({
      name:  p.name,
      stock: p.stock,
      max:   Math.max(p.stock + 50, 100),
      alert: p.stock < 30,
      emoji: p.emoji,
    }));

    // ── Top products ─────────────────────────────────────────────
    const topProducts = await Order.aggregate([
      { $match: { createdAt: { $gte: from }, status: { $ne: 'cancelled' } } },
      { $unwind: '$items' },
      {
        $group: {
          _id:     '$items.product',
          revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
          units:   { $sum: '$items.quantity' },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 4 },
      {
        $lookup: {
          from:         'products',
          localField:   '_id',
          foreignField: '_id',
          as:           'product',
        },
      },
      { $unwind: '$product' },
      {
        $project: {
          name:     '$product.name',
          emoji:    '$product.emoji',
          category: '$product.category',
          revenue:  1,
          units:    1,
        },
      },
    ]);

    res.json({
      success: true,
      data: {
        // KPI cards
        revenue: {
          value: formatNaira(revenue),
          delta: formatDelta(revenue, prevRevenue),
          up:    revenue >= prevRevenue,
          raw:   revenue,
        },
        orders: {
          value: orderCount.toLocaleString(),
          delta: formatDelta(orderCount, prevOrderCount),
          up:    orderCount >= prevOrderCount,
        },
        customers: {
          value: customerCount.toLocaleString(),
          delta: formatDelta(customerCount, prevCustomerCount),
          up:    customerCount >= prevCustomerCount,
        },
        outOfStock: {
          value: products.filter(p => p.stock < 1).length.toString(),
          delta: `${products.filter(p => p.stock < 30).length} low`,
          up:    false,
        },

        // Stats strip
        pendingOrders: pendingCount,
        cancelled:     cancelledCount,
        netProfit:     formatNaira(netProfit),
        margin:        '46.2%',

        // Charts
        salesChart,
        categoryBreakdown,

        // Tables
        topProducts: topProducts.map(p => ({
          name:     p.name,
          emoji:    p.emoji ?? '💊',
          category: cap(p.category),
          revenue:  formatNaira(p.revenue),
          units:    p.units,
        })),
        inventory,
      },
    });
  } catch (err) {
    logger.error('getDashboardStats error:', err);
    res.status(500).json({ success: false, error: 'Failed to load dashboard stats' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function getPeriodDates(period) {
  const now  = new Date();
  const from = new Date(now);
  const prev = new Date(now);

  switch (period) {
    case 'today':
      from.setHours(0, 0, 0, 0);
      prev.setDate(prev.getDate() - 1);
      prev.setHours(0, 0, 0, 0);
      break;
    case '30d':
      from.setDate(from.getDate() - 30);
      prev.setDate(prev.getDate() - 60);
      break;
    case '90d':
      from.setDate(from.getDate() - 90);
      prev.setDate(prev.getDate() - 180);
      break;
    default: // 7d
      from.setDate(from.getDate() - 7);
      prev.setDate(prev.getDate() - 14);
  }

  return { from, prev };
}

async function buildSalesChart(from, to) {
  const days = Math.ceil((to - from) / (1000 * 60 * 60 * 24));
  const prevFrom = new Date(from);
  prevFrom.setDate(prevFrom.getDate() - days);

  const [thisWeek, lastWeek] = await Promise.all([
    Order.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to }, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id:   { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          total: { $sum: '$totalPrice' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: prevFrom, $lt: from }, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id:   { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          total: { $sum: '$totalPrice' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  // Build day labels (last 7 days)
  const labels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const result = labels.map((day, i) => {
    const date = new Date(from);
    date.setDate(date.getDate() + i);
    const key = date.toISOString().split('T')[0];
    return {
      day,
      thisWeek: thisWeek.find(d => d._id === key)?.total ?? 0,
      lastWeek: lastWeek.find(d => d._id === key)?.total ?? 0,
    };
  });

  return result;
}

async function buildCategoryBreakdown(from) {
  const COLORS = {
    immunity: '#00c896',
    vitamins: '#7c5cfc',
    beauty:   '#f59e0b',
    energy:   '#ff4d6d',
    weight:   '#00b4d8',
  };

  const result = await Order.aggregate([
    { $match: { createdAt: { $gte: from }, status: { $ne: 'cancelled' } } },
    { $unwind: '$items' },
    {
      $lookup: {
        from:         'products',
        localField:   'items.product',
        foreignField: '_id',
        as:           'product',
      },
    },
    { $unwind: '$product' },
    {
      $group: {
        _id:   '$product.category',
        value: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
      },
    },
    { $sort: { value: -1 } },
  ]);

  const total = result.reduce((s, r) => s + r.value, 0) || 1;

  return result.map(r => ({
    name:  cap(r._id),
    value: Math.round((r.value / total) * 100),
    color: COLORS[r._id] ?? '#7b829a',
  }));
}

function formatNaira(n) {
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `₦${(n / 1_000).toFixed(0)}K`;
  return `₦${n}`;
}

function formatDelta(current, previous) {
  if (!previous) return '+100%';
  const pct = ((current - previous) / previous * 100).toFixed(1);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

module.exports = { getDashboardStats };
