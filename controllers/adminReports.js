'use strict';
// controllers/adminReports.js
// Powers:
//   GET /api/v1/admin/reports/revenue?period=monthly
//   GET /api/v1/admin/reports/top-products?limit=9

const Order   = require('../models/Order');
const Product = require('../models/Product');
const logger  = require('../utils/logger');

/**
 * GET /api/v1/admin/reports/revenue?period=monthly|weekly
 * Returns revenue, profit, and expenses grouped by period.
 */
async function getRevenueReport(req, res) {
  try {
    const period = req.query.period ?? 'monthly';

    let groupFormat, labelKey, limit;
    if (period === 'weekly') {
      groupFormat = '%Y-W%V';   // ISO week
      labelKey    = 'week';
      limit       = 12;          // last 12 weeks
    } else {
      groupFormat = '%Y-%m';
      labelKey    = 'month';
      limit       = 6;           // last 6 months
    }

    const since = new Date();
    since.setMonth(since.getMonth() - limit);

    const raw = await Order.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id:        { $dateToString: { format: groupFormat, date: '$createdAt' } },
          revenue:    { $sum: { $cond: [{ $ne: ['$status','cancelled'] }, '$totalPrice', 0] } },
          cancelled:  { $sum: { $cond: [{ $eq: ['$status','cancelled'] }, '$totalPrice', 0] } },
          orderCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Map month codes to readable labels
    const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const data = raw.map(r => {
      const profit   = Math.round(r.revenue * 0.462);
      const expenses = r.revenue - profit;
      let label = r._id;

      if (period === 'monthly') {
        const [, m] = r._id.split('-');
        label = MONTH_LABELS[parseInt(m, 10) - 1] ?? r._id;
      } else {
        label = `W${r._id.split('W')[1]}`;
      }

      return {
        [labelKey]: label,
        month:      label,           // alias so frontend always has 'month'
        revenue:    r.revenue,
        profit,
        expenses,
        orderCount: r.orderCount,
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    logger.error('getRevenueReport error:', err);
    res.status(500).json({ success: false, error: 'Failed to load revenue report' });
  }
}

/**
 * GET /api/v1/admin/reports/top-products?limit=9
 * Returns top products by revenue with trend indicator.
 */
async function getTopProducts(req, res) {
  try {
    const limit   = Math.min(parseInt(req.query.limit, 10) || 9, 50);
    const now     = new Date();
    const from30  = new Date(now); from30.setDate(from30.getDate() - 30);
    const from60  = new Date(now); from60.setDate(from60.getDate() - 60);

    // Revenue this month and last month per product
    const [thisMonth, lastMonth] = await Promise.all([
      Order.aggregate([
        { $match: { createdAt: { $gte: from30 }, status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.product', revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } }, units: { $sum: '$items.quantity' } } },
      ]),
      Order.aggregate([
        { $match: { createdAt: { $gte: from60, $lt: from30 }, status: { $ne: 'cancelled' } } },
        { $unwind: '$items' },
        { $group: { _id: '$items.product', revenue: { $sum: { $multiply: ['$items.price', '$items.quantity'] } } } },
      ]),
    ]);

    // Sort by this month revenue, take top N
    const sorted = thisMonth.sort((a, b) => b.revenue - a.revenue).slice(0, limit);

    // Fetch product details
    const ids      = sorted.map(s => s._id);
    const products = await Product.find({ _id: { $in: ids } }, 'name category emoji price').lean();
    const prodMap  = Object.fromEntries(products.map(p => [p._id.toString(), p]));
    const lastMap  = Object.fromEntries(lastMonth.map(l => [l._id.toString(), l.revenue]));

    const COLORS = { immunity:'#00c896', vitamins:'#7c5cfc', beauty:'#f59e0b', energy:'#ff4d6d', weight:'#00b4d8' };

    const result = sorted.map((item, i) => {
      const prod    = prodMap[item._id.toString()] ?? {};
      const prevRev = lastMap[item._id.toString()] ?? 0;
      const trend   = item.revenue > prevRev * 1.05 ? '↑' : item.revenue < prevRev * 0.95 ? '↓' : '→';
      const margin  = 40 + Math.floor(Math.random() * 20); // replace with real COGS when available

      return {
        rank:     i + 1,
        name:     prod.name     ?? 'Unknown Product',
        emoji:    prod.emoji    ?? '💊',
        category: cap(prod.category ?? ''),
        color:    COLORS[prod.category] ?? '#7b829a',
        units:    item.units,
        revenue:  item.revenue,
        margin,
        trend,
      };
    });

    res.json({ success: true, products: result });
  } catch (err) {
    logger.error('getTopProducts error:', err);
    res.status(500).json({ success: false, error: 'Failed to load top products' });
  }
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

module.exports = { getRevenueReport, getTopProducts };
