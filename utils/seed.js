'use strict';

/**
 * Run with: node utils/seed.js
 * Seeds the database with initial products and admin user.
 * Safe to re-run — uses upsert operations.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');
const Product = require('../models/Product');

const PRODUCTS = [
  {
    name: 'Greens Plus Daily Formula',
    description: 'Our most loved product. A comprehensive blend of 22 superfoods, adaptogens, and digestive enzymes. Just one scoop delivers more nutrition than eating 8 portions of vegetables. Includes Spirulina, Chlorella, Ashwagandha, Probiotics, Turmeric, and Lion\'s Mane.',
    shortDescription: 'Complete superfood blend with 22 ingredients for daily nutrition & immunity.',
    category: 'immunity',
    emoji: '🧃',
    price: 15000,
    originalPrice: 19500,
    stock: 150,
    servings: 30,
    ingredients: ['Spirulina', 'Chlorella', 'Ashwagandha', 'Probiotics (10B CFU)', 'Turmeric', "Lion's Mane", 'Wheat Grass', 'Barley Grass'],
    benefits: ['Boosts immunity', 'Improves gut health', 'Increases energy', 'Reduces inflammation'],
    howToUse: 'Mix 1 scoop with 250ml of water or juice daily. Best taken in the morning.',
    badge: 'Best Seller',
    isFeatured: true,
    tags: ['greens', 'superfoods', 'immunity', 'daily', 'powder'],
  },
  {
    name: 'Omega-3 Fish Oil 1000mg',
    description: 'High-potency EPA & DHA from deep-sea, sustainably caught fish. Third-party tested for mercury and heavy metals. Supports heart health, brain function, and reduces inflammation.',
    shortDescription: 'High-potency EPA & DHA for heart and brain health.',
    category: 'vitamins',
    emoji: '💊',
    price: 8500,
    originalPrice: null,
    stock: 200,
    servings: 60,
    ingredients: ['Fish Oil Concentrate', 'EPA 360mg', 'DHA 240mg', 'Vitamin E (as preservative)'],
    benefits: ['Supports heart health', 'Improves brain function', 'Reduces inflammation', 'Supports joint health'],
    howToUse: 'Take 1–2 softgels daily with meals.',
    badge: null,
    tags: ['omega3', 'fish oil', 'heart health', 'brain', 'capsules'],
  },
  {
    name: 'Energy Pro Complex',
    description: 'Clean energy and mental focus blend. No artificial stimulants — just scientifically proven ingredients including Rhodiola Rosea, Panax Ginseng, B-vitamins, and natural caffeine from Green Tea. Zero crash, zero jitters.',
    shortDescription: 'Clean energy & mental focus blend. No crash, no jitters.',
    category: 'energy',
    emoji: '⚡',
    price: 12000,
    originalPrice: 14500,
    stock: 120,
    servings: 30,
    ingredients: ['Rhodiola Rosea 500mg', 'Panax Ginseng 400mg', 'Green Tea Extract 200mg', 'B12 1000mcg', 'B6 50mg', 'CoQ10 100mg'],
    benefits: ['Sustained energy', 'Mental clarity', 'No crash or jitters', 'Improves workout performance'],
    howToUse: 'Take 2 capsules in the morning with breakfast. Do not exceed 2 capsules daily.',
    badge: 'Sale',
    tags: ['energy', 'focus', 'productivity', 'nootropics', 'capsules'],
  },
  {
    name: 'Vitamin C 1000mg + Zinc',
    description: 'Advanced immunity formula combining buffered Vitamin C (sodium ascorbate) with immune-boosting Zinc picolinate for maximum absorption. Supports collagen synthesis and powerful antioxidant protection.',
    shortDescription: 'Advanced immunity formula with high-dose Vitamin C and Zinc.',
    category: 'immunity',
    emoji: '🍊',
    price: 6500,
    originalPrice: null,
    stock: 300,
    servings: 90,
    ingredients: ['Vitamin C (Sodium Ascorbate) 1000mg', 'Zinc Picolinate 15mg', 'Rose Hip Extract 50mg', 'Bioflavonoids 50mg'],
    benefits: ['Boosts immunity', 'Powerful antioxidant', 'Collagen synthesis', 'Reduces cold duration'],
    howToUse: 'Take 1 tablet daily with meals. Increase to 2 tablets during illness.',
    badge: null,
    tags: ['vitamin c', 'zinc', 'immunity', 'antioxidant', 'tablets'],
  },
  {
    name: 'Marine Collagen Beauty Blend',
    description: 'Hydrolyzed Type I & III marine collagen peptides from sustainably sourced tilapia. Formulated with Hyaluronic Acid, Biotin, Vitamin E, and Vitamin C for maximum collagen synthesis and skin hydration.',
    shortDescription: 'Marine collagen for skin elasticity, hair growth, and joint health.',
    category: 'beauty',
    emoji: '✨',
    price: 18000,
    originalPrice: 22000,
    stock: 80,
    servings: 30,
    ingredients: ['Marine Collagen Peptides 5g', 'Hyaluronic Acid 100mg', 'Biotin 5000mcg', 'Vitamin E 400IU', 'Vitamin C 500mg'],
    benefits: ['Reduces wrinkles', 'Stronger hair & nails', 'Improved skin hydration', 'Joint support'],
    howToUse: 'Mix 1 sachet in warm or cold water daily. Best results after 8–12 weeks.',
    badge: 'New',
    isNew: true,
    tags: ['collagen', 'skin', 'hair', 'beauty', 'anti-aging', 'powder'],
  },
  {
    name: 'Complete Multivitamin',
    description: '28 essential vitamins and minerals in one daily capsule. Formulated for Nigerian adults with higher doses of commonly deficient nutrients: Vitamin D3, Iron, Folate, and B12. Complete nutritional insurance.',
    shortDescription: '28 vitamins and minerals for complete daily nutrition.',
    category: 'vitamins',
    emoji: '💊',
    price: 9500,
    originalPrice: null,
    stock: 250,
    servings: 90,
    ingredients: ['Vitamin A 5000IU', 'Vitamin D3 2000IU', 'Vitamin E 400IU', 'Vitamin C 500mg', 'B-Complex', 'Iron 18mg', 'Zinc 15mg', 'Magnesium 200mg', 'Selenium 200mcg'],
    benefits: ['Fills nutritional gaps', 'Boosts immunity', 'Supports energy', 'Improves overall health'],
    howToUse: 'Take 1 capsule daily with breakfast.',
    badge: null,
    tags: ['multivitamin', 'daily', 'vitamins', 'minerals', 'capsules'],
  },
  {
    name: 'SlimBalance Weight Support',
    description: 'Natural weight management blend combining Green Tea Extract (EGCG), Conjugated Linoleic Acid (CLA), Chromium Picolinate, and Garcinia Cambogia. Supports healthy metabolism and appetite management.',
    shortDescription: 'Natural weight management with metabolism and appetite support.',
    category: 'weight',
    emoji: '⚖️',
    price: 14000,
    originalPrice: 17000,
    stock: 90,
    servings: 45,
    ingredients: ['Green Tea Extract 500mg', 'CLA 1000mg', 'Chromium Picolinate 200mcg', 'Garcinia Cambogia 500mg', 'L-Carnitine 500mg'],
    benefits: ['Supports fat metabolism', 'Reduces appetite', 'Boosts thermogenesis', 'Maintains lean muscle'],
    howToUse: 'Take 2 capsules twice daily, 30 minutes before meals. Best with diet and exercise.',
    badge: 'Sale',
    warnings: 'Not suitable for pregnant or breastfeeding women. Consult doctor if on medication.',
    tags: ['weight loss', 'metabolism', 'slimming', 'fat burner', 'capsules'],
  },
  {
    name: 'Immunity Shield Pro',
    description: 'Advanced 7-in-1 immunity formula combining the most clinically researched immune-boosting ingredients: Elderberry, Vitamin D3, Zinc, Quercetin, Vitamin C, Astragalus, and Echinacea.',
    shortDescription: 'Advanced 7-in-1 immunity formula for year-round protection.',
    category: 'immunity',
    emoji: '🛡️',
    price: 11000,
    originalPrice: null,
    stock: 175,
    servings: 60,
    ingredients: ['Elderberry Extract 200mg', 'Vitamin D3 5000IU', 'Zinc Picolinate 20mg', 'Quercetin 500mg', 'Vitamin C 1000mg', 'Astragalus 300mg', 'Echinacea 250mg'],
    benefits: ['Year-round immune protection', 'Reduces illness frequency', 'Faster recovery', 'Anti-inflammatory'],
    howToUse: 'Take 2 capsules daily with meals for maintenance. Take 3 capsules daily at first sign of illness.',
    badge: 'Top Rated',
    isFeatured: true,
    tags: ['immunity', 'elderberry', 'zinc', 'vitamin d', 'protection', 'capsules'],
  },
  {
    name: 'Magnesium Complex 400mg',
    description: 'Premium triple magnesium formula combining Magnesium Threonate (for brain), Magnesium Glycinate (for sleep and relaxation), and Magnesium Malate (for energy and muscle function). The most bioavailable form available.',
    shortDescription: 'Triple magnesium blend for better sleep, focus, and muscle recovery.',
    category: 'vitamins',
    emoji: '💤',
    price: 7500,
    originalPrice: null,
    stock: 140,
    servings: 30,
    ingredients: ['Magnesium L-Threonate 200mg', 'Magnesium Glycinate 100mg', 'Magnesium Malate 100mg', 'Vitamin B6 10mg'],
    benefits: ['Improves sleep quality', 'Reduces anxiety', 'Muscle recovery', 'Cognitive function'],
    howToUse: 'Take 3 capsules 1–2 hours before bed, or as directed.',
    badge: 'New',
    tags: ['magnesium', 'sleep', 'relaxation', 'muscle recovery', 'capsules'],
  },
];

async function seed() {
  console.log('🌱 Starting database seed...\n');

  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ Connected to MongoDB\n');

    // ── PRODUCTS ──────────────────────────────────────────────────
    console.log('📦 Seeding products...');
    let created = 0, updated = 0;

    for (const p of PRODUCTS) {
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const result = await Product.findOneAndUpdate(
        { slug },
        { ...p, slug },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
      );
      if (result.createdAt === result.updatedAt) created++; else updated++;
      console.log(`  ${result.emoji} ${result.name} — ₦${result.price.toLocaleString()}`);
    }
    console.log(`\n  ✅ ${created} created, ${updated} updated\n`);

    // ── ADMIN USER ────────────────────────────────────────────────
    console.log('👤 Seeding admin user...');
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@vitacore.ng';
    const adminPass = process.env.ADMIN_PASSWORD || 'VitaAdmin2026!';

    const admin = await User.findOneAndUpdate(
      { email: adminEmail },
      {
        name: 'VitaCore Admin',
        email: adminEmail,
        password: adminPass,
        role: 'admin',
        isEmailVerified: true,
        isActive: true,
      },
      { upsert: true, new: true, runValidators: false, setDefaultsOnInsert: true }
    );

    console.log(`  ✅ Admin: ${admin.email}\n`);

    console.log('🎉 Seed complete!\n');
    console.log('━'.repeat(40));
    console.log(`Admin email:    ${adminEmail}`);
    console.log(`Admin password: ${adminPass}`);
    console.log('━'.repeat(40));
    console.log('⚠️  Change the admin password immediately after first login!\n');

  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

seed();
