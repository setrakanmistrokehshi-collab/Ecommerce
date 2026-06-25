'use strict';

/**
 * Run with: node seed.js
 *
 * KEY FIX: Admin user is created with `new User({...}).save()` — NOT
 * findOneAndUpdate() — so the pre('save') hook on the User model fires
 * and argon2 hashes the password automatically.
 *
 * Safe to re-run — checks for existing records before inserting.
 */

const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('./models/User');
const Product  = require('./models/Product');

const PRODUCTS = [
  {
    name: 'Greens Plus Daily Formula',
    description: "Our most loved product. A comprehensive blend of 22 superfoods, adaptogens, and digestive enzymes.",
    shortDescription: 'Complete superfood blend with 22 ingredients for daily nutrition & immunity.',
    category: 'immunity', emoji: '🧃', price: 15000, originalPrice: 19500, stock: 150, servings: 30,
    ingredients: ['Spirulina', 'Chlorella', 'Ashwagandha', 'Probiotics (10B CFU)', 'Turmeric', "Lion's Mane", 'Wheat Grass', 'Barley Grass'],
    benefits: ['Boosts immunity', 'Improves gut health', 'Increases energy', 'Reduces inflammation'],
    howToUse: 'Mix 1 scoop with 250ml of water or juice daily. Best taken in the morning.',
    badge: 'Best Seller', isFeatured: true, isActive: true,
    tags: ['greens', 'superfoods', 'immunity', 'daily', 'powder'],
  },
  {
    name: 'Omega-3 Fish Oil 1000mg',
    description: 'High-potency EPA & DHA from deep-sea, sustainably caught fish. Third-party tested for mercury and heavy metals.',
    shortDescription: 'High-potency EPA & DHA for heart and brain health.',
    category: 'vitamins', emoji: '💊', price: 8500, originalPrice: null, stock: 200, servings: 60,
    ingredients: ['Fish Oil Concentrate', 'EPA 360mg', 'DHA 240mg', 'Vitamin E (as preservative)'],
    benefits: ['Supports heart health', 'Improves brain function', 'Reduces inflammation', 'Supports joint health'],
    howToUse: 'Take 1–2 softgels daily with meals.',
    badge: null, isActive: true, tags: ['omega3', 'fish oil', 'heart health', 'brain', 'capsules'],
  },
  {
    name: 'Energy Pro Complex',
    description: 'Clean energy and mental focus blend. No artificial stimulants.',
    shortDescription: 'Clean energy & mental focus blend. No crash, no jitters.',
    category: 'energy', emoji: '⚡', price: 12000, originalPrice: 14500, stock: 120, servings: 30,
    ingredients: ['Rhodiola Rosea 500mg', 'Panax Ginseng 400mg', 'Green Tea Extract 200mg', 'B12 1000mcg', 'B6 50mg', 'CoQ10 100mg'],
    benefits: ['Sustained energy', 'Mental clarity', 'No crash or jitters', 'Improves workout performance'],
    howToUse: 'Take 2 capsules in the morning with breakfast.',
    badge: 'Sale', isActive: true, tags: ['energy', 'focus', 'productivity', 'nootropics', 'capsules'],
  },
  {
    name: 'Vitamin C 1000mg + Zinc',
    description: 'Advanced immunity formula combining buffered Vitamin C with Zinc picolinate.',
    shortDescription: 'Advanced immunity formula with high-dose Vitamin C and Zinc.',
    category: 'immunity', emoji: '🍊', price: 6500, originalPrice: null, stock: 300, servings: 90,
    ingredients: ['Vitamin C (Sodium Ascorbate) 1000mg', 'Zinc Picolinate 15mg', 'Rose Hip Extract 50mg', 'Bioflavonoids 50mg'],
    benefits: ['Boosts immunity', 'Powerful antioxidant', 'Collagen synthesis', 'Reduces cold duration'],
    howToUse: 'Take 1 tablet daily with meals.',
    badge: null, isActive: true, tags: ['vitamin c', 'zinc', 'immunity', 'antioxidant', 'tablets'],
  },
  {
    name: 'Marine Collagen Beauty Blend',
    description: 'Hydrolyzed Type I & III marine collagen peptides from sustainably sourced tilapia.',
    shortDescription: 'Marine collagen for skin elasticity, hair growth, and joint health.',
    category: 'beauty', emoji: '✨', price: 18000, originalPrice: 22000, stock: 80, servings: 30,
    ingredients: ['Marine Collagen Peptides 5g', 'Hyaluronic Acid 100mg', 'Biotin 5000mcg', 'Vitamin E 400IU', 'Vitamin C 500mg'],
    benefits: ['Reduces wrinkles', 'Stronger hair & nails', 'Improved skin hydration', 'Joint support'],
    howToUse: 'Mix 1 sachet in warm or cold water daily.',
    badge: 'New', isActive: true, tags: ['collagen', 'skin', 'hair', 'beauty', 'anti-aging', 'powder'],
  },
  {
    name: 'Complete Multivitamin',
    description: '28 essential vitamins and minerals in one daily capsule. Formulated for Nigerian adults.',
    shortDescription: '28 vitamins and minerals for complete daily nutrition.',
    category: 'vitamins', emoji: '💊', price: 9500, originalPrice: null, stock: 250, servings: 90,
    ingredients: ['Vitamin A 5000IU', 'Vitamin D3 2000IU', 'Vitamin E 400IU', 'Vitamin C 500mg', 'B-Complex', 'Iron 18mg', 'Zinc 15mg', 'Magnesium 200mg', 'Selenium 200mcg'],
    benefits: ['Fills nutritional gaps', 'Boosts immunity', 'Supports energy', 'Improves overall health'],
    howToUse: 'Take 1 capsule daily with breakfast.',
    badge: null, isActive: true, tags: ['multivitamin', 'daily', 'vitamins', 'minerals', 'capsules'],
  },
  {
    name: 'SlimBalance Weight Support',
    description: 'Natural weight management blend combining Green Tea Extract, CLA, and Garcinia Cambogia.',
    shortDescription: 'Natural weight management with metabolism and appetite support.',
    category: 'weight', emoji: '⚖️', price: 14000, originalPrice: 17000, stock: 90, servings: 45,
    ingredients: ['Green Tea Extract 500mg', 'CLA 1000mg', 'Chromium Picolinate 200mcg', 'Garcinia Cambogia 500mg', 'L-Carnitine 500mg'],
    benefits: ['Supports fat metabolism', 'Reduces appetite', 'Boosts thermogenesis', 'Maintains lean muscle'],
    howToUse: 'Take 2 capsules twice daily, 30 minutes before meals.',
    badge: 'Sale', isActive: true, warnings: 'Not suitable for pregnant or breastfeeding women.',
    tags: ['weight loss', 'metabolism', 'slimming', 'fat burner', 'capsules'],
  },
  {
    name: 'Immunity Shield Pro',
    description: 'Advanced 7-in-1 immunity formula with Elderberry, Vitamin D3, Zinc, Quercetin, Vitamin C, Astragalus, and Echinacea.',
    shortDescription: 'Advanced 7-in-1 immunity formula for year-round protection.',
    category: 'immunity', emoji: '🛡️', price: 11000, originalPrice: null, stock: 175, servings: 60,
    ingredients: ['Elderberry Extract 200mg', 'Vitamin D3 5000IU', 'Zinc Picolinate 20mg', 'Quercetin 500mg', 'Vitamin C 1000mg', 'Astragalus 300mg', 'Echinacea 250mg'],
    benefits: ['Year-round immune protection', 'Reduces illness frequency', 'Faster recovery', 'Anti-inflammatory'],
    howToUse: 'Take 2 capsules daily with meals for maintenance.',
    badge: 'Top Rated', isFeatured: true, isActive: true,
    tags: ['immunity', 'elderberry', 'zinc', 'vitamin d', 'protection', 'capsules'],
  },
  {
    name: 'Magnesium Complex 400mg',
    description: 'Premium triple magnesium formula combining Magnesium Threonate, Glycinate, and Malate.',
    shortDescription: 'Triple magnesium blend for better sleep, focus, and muscle recovery.',
    category: 'vitamins', emoji: '💤', price: 7500, originalPrice: null, stock: 140, servings: 30,
    ingredients: ['Magnesium L-Threonate 200mg', 'Magnesium Glycinate 100mg', 'Magnesium Malate 100mg', 'Vitamin B6 10mg'],
    benefits: ['Improves sleep quality', 'Reduces anxiety', 'Muscle recovery', 'Cognitive function'],
    howToUse: 'Take 3 capsules 1–2 hours before bed.',
    badge: 'New', isActive: true, tags: ['magnesium', 'sleep', 'relaxation', 'muscle recovery', 'capsules'],
  },
];


function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function seed() {
  console.log('🌱 Starting database seed...\n');

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      family: 4,
    });
    console.log('✅ Connected to MongoDB\n');

    // ── PRODUCTS ──────────────────────────────────────────────
    console.log('📦 Seeding products...');
    let created = 0, updated = 0;

    for (const p of PRODUCTS) {
      const slug   = slugify(p.name);
      const exists = await Product.findOne({ slug });

      if (exists) {
        await Product.findOneAndUpdate({ slug }, { ...p, slug },
           { runValidators: true,
            returnDocument: 'after'
            });
        updated++;
        console.log(`  ↻  ${p.emoji} ${p.name} — updated`);
      } else {
        await Product.create({ ...p, slug });
        created++;
        console.log(`  ✅ ${p.emoji} ${p.name} — ₦${p.price.toLocaleString()}`);
      }
    }
    console.log(`\n  📦 ${created} created, ${updated} updated\n`);

    // ── SUPER ADMIN USER ──────────────────────────────────────
    console.log('👤 Seeding super admin user...');

    const adminEmail = process.env.ADMIN_EMAIL ;
    const adminPass  = process.env.ADMIN_PASSWORD ;

    const existingAdmin = await User.findOne({ email: adminEmail });

    if (existingAdmin) {
      console.log('  ↻  Super Admin already exists — updating...');
      existingAdmin.name            = 'Super Admin';
      existingAdmin.password        = adminPass;
      existingAdmin.role            = 'super_admin';
      existingAdmin.isEmailVerified = true;
      existingAdmin.isActive        = true;
      await existingAdmin.save();
      console.log(`  ✅ Super Admin updated: ${adminEmail}`);
    } else {
      const admin = new User({
        name:            'Super Admin',
        email:           adminEmail,
        password:        adminPass,
        role:            'super_admin',
        isEmailVerified: true,
        isActive:        true,
      });
      await admin.save();
      console.log(`  ✅ Super Admin created: ${adminEmail}`);
    }

    // ── PRODUCT MANAGER USER ──────────────────────────────────
    console.log('👤 Seeding product manager...');

    const pmEmail = process.env.PRODUCT_MANAGER_EMAIL ;
    const pmPass  = process.env.PRODUCT_MANAGER_PASSWORD ;

    const existingPM = await User.findOne({ email: pmEmail });

    if (existingPM) {
      console.log('  ↻  Product Manager already exists — updating...');
      existingPM.name            = 'Product Manager';
      existingPM.password        = pmPass;
      existingPM.role            = 'product_manager';
      existingPM.isEmailVerified = true;
      existingPM.isActive        = true;
      await existingPM.save();
      console.log(`  ✅ Product Manager updated: ${pmEmail}`);
    } else {
      const pm = new User({
        name:            'Product Manager',
        email:           pmEmail,
        password:        pmPass,
        role:            'product_manager',
        isEmailVerified: true,
        isActive:        true,
      });
      await pm.save();
      console.log(`  ✅ Product Manager created: ${pmEmail}`);
    }

    // ── VERIFY THE HASH WAS ACTUALLY STORED ──────────────────
    const checkAdmin = await User.findOne({ email: adminEmail }).select('+password');
    const checkPM = await User.findOne({ email: pmEmail }).select('+password');
    
    console.log(checkAdmin?.password?.startsWith('$argon2')
      ? '  🔒 Admin password is hashed in DB ✅'
      : '  ⚠️  Admin password is NOT hashed — check pre-save hook'
    );
    
    console.log(checkPM?.password?.startsWith('$argon2')
      ? '  🔒 PM password is hashed in DB ✅'
      : '  ⚠️  PM password is NOT hashed — check pre-save hook'
    );

    // ── DONE ──────────────────────────────────────────────────
    console.log('\n🎉 Seed complete!\n');
    console.log('━'.repeat(44));
    console.log(`  Super Admin email:    ${adminEmail}`);
    console.log(`  Super Admin password: ${adminPass}`);
    console.log(`  Super Admin role:     super_admin`);
    console.log('━'.repeat(44));
    console.log(`  PM email:             ${pmEmail}`);
    console.log(`  PM password:          ${pmPass}`);
    console.log(`  PM role:              product_manager`);
    console.log('━'.repeat(44));
    console.log('  ⚠️  Change passwords after first login!\n');

  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    if (err.code === 11000) {
      console.error('   Duplicate key — email already exists. Seed ran the update path instead.');
    }
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

seed();