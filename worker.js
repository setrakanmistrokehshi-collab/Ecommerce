/**
 * Runs a cron job to expire old unpaid orders safely.
 */

const dns = require("node:dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

require("dotenv").config();
const cron = require("node-cron");
const mongoose = require("mongoose");

// ─── CONFIG ────────────────────────────────────────────────

const PENDING_EXPIRY_MINUTES = parseInt(
  process.env.ORDER_EXPIRY_MINUTES || "60"
);

// ─── MONGOOSE MODEL ────────────────────────────────────────

const Order = mongoose.model(
  "Order",
  new mongoose.Schema({}, { strict: false, collection: "orders" })
);

// ─── EXPIRY LOGIC ──────────────────────────────────────────

async function expirePendingOrders() {
  const cutoff = new Date(
    Date.now() - PENDING_EXPIRY_MINUTES * 60 * 1000
  );

  const result = await Order.updateMany(
    {
      // ✅ ONLY safe orders
      status: "pending",
      paymentStatus: { $ne: "paid" }, // 🔥 prevents deleting paid orders
      createdAt: { $lt: cutoff },
    },
    {
      $set: {
        status: "expired",
        expiredAt: new Date(),
      },
    }
  );

  console.log(
    `[Worker] Expired ${result.modifiedCount} order(s)`
  );
}

// ─── CRON SCHEDULE ─────────────────────────────────────────

// ⚠️ FIX: */60 is invalid behavior in cron
// Runs every 60 minutes correctly:
cron.schedule("0 * * * *", async () => {
  try {
    console.log("[Worker] Running expiry job...");
    await expirePendingOrders();
  } catch (err) {
    console.error("[Worker] Job failed:", err.message);
  }
});

// ─── STARTUP ───────────────────────────────────────────────

async function start() {
  await mongoose.connect(process.env.MONGODB_URI);

  console.log("[Worker] MongoDB connected");
  console.log("[Worker] Cron started (runs every 60 minutes at minute 0)");
}

start().catch((err) => {
  console.error("[Worker] Boot failed:", err.message);
  process.exit(1);
});