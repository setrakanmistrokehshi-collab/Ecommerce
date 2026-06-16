'use strict';

// ─────────────────────────────────────────────────────────────────
// scripts/migrate_kobo.js  — ONE-TIME migration script
// ─────────────────────────────────────────────────────────────────
// Converts existing Product.price and Order monetary fields from
// naira (float) to kobo (integer) before deploying the updated
// payments.js that stores all amounts in kobo.
//
// RUN ONCE on your existing data, then NEVER again.
// Run against a DB backup first to verify results before production.
//
// Usage:
//   node scripts/migrate_kobo.js
// ─────────────────────────────────────────────────────────────────
const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
require('dotenv').config();
const mongoose = require('mongoose');
const Product  = require('../models/Product');
const Order    = require('../models/Order');


async function migrate() {
   mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // ── 1. Migrate Product.price ────────────────────────────────────
  // Fetch products where price looks like naira (< 100,000 to avoid
  // double-migrating anything already in kobo). Adjust the threshold
  // if you sell products over ₦1,000 (= 100,000 kobo).
  const products = await Product.find({ price: { $lt: 100000 } });
  console.log(`Migrating ${products.length} products...`);

  for (const product of products) {
    const oldPrice = product.price;
    const newPrice = Math.round(oldPrice * 100); // ₦1,000.50 → 100050
    await Product.findByIdAndUpdate(product._id, {
      $set: { price: newPrice, reserved: product.reserved || 0 },
    });
    console.log(`  Product "${product.name}": ₦${oldPrice} → ${newPrice} kobo`);
  }

  // ── 2. Migrate Order monetary fields ────────────────────────────
  // Same guard — only touch orders where total looks like naira.
  const orders = await Order.find({ total: { $lt: 10000000 } }); // under ₦100,000
  console.log(`\nMigrating ${orders.length} orders...`);

  for (const order of orders) {
    const fields = ['subtotal', 'discount', 'shipping', 'total'];
    const updates = {};
    for (const field of fields) {
      if (typeof order[field] === 'number' && order[field] > 0) {
        updates[field] = Math.round(order[field] * 100);
      }
    }

    // Also migrate item-level prices inside the order document
    const migratedItems = order.items.map(item => ({
      ...item.toObject(),
      price: item.price < 100000 ? Math.round(item.price * 100) : item.price,
    }));

    await Order.findByIdAndUpdate(order._id, {
      $set: { ...updates, items: migratedItems },
    });
    console.log(`  Order ${order.orderNumber}: total ₦${order.total} → ${updates.total} kobo`);
  }

  console.log('\n✅ Migration complete.');

  // ── 3. Verify a sample ──────────────────────────────────────────
  const sampleProduct = await Product.findOne().lean();
  const sampleOrder   = await Order.findOne().lean();
  console.log('\nSample product price after migration:', sampleProduct?.price, 'kobo');
  console.log('Sample order total after migration:',   sampleOrder?.total,   'kobo');

  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});