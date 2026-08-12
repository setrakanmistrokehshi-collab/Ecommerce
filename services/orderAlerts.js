const { sendTransactionalEmail } = require("../services/brevoService");

async function sendOrderAlertToAdmin(order, customer) {
  const itemsList = order.items
    .map((i) => `<li>${i.quantity} × ${i.name} — ₦${i.price}</li>`)
    .join('');

  const { street, city, state, country } = order.shippingAddress || {};
  const formattedAddress = [street, city, state, country].filter(Boolean).join(', ');

  return sendTransactionalEmail({
    to: { email: process.env.BREVO_ADMIN_ALERT_EMAIL, name: 'VitaCore Admin' },
    subject: `🛒 New order #${order.orderNumber} — ₦${order.total}`,
    htmlContent: `
      <h3>New order received</h3>
      <p><strong>Customer:</strong> ${customer.name} (${customer.email}, ${customer.phone || 'no phone'})</p>
      <p><strong>Order total:</strong> ₦${order.total}</p>
      <p><strong>Payment:</strong> ${order.paymentMethod} — ${order.paymentStatus}</p>
      <ul>${itemsList}</ul>
      <p><strong>Ship to:</strong> ${formattedAddress || 'No address provided'}</p>
      <p><a href="${process.env.ADMIN_DASHBOARD_URL}/orders/${order._id}">Open in admin dashboard</a></p>
    `,
    tags: ['order-alert', 'internal'],
  });
}

// Low-stock alert — reuse the same pattern for any internal trigger
async function sendLowStockAlert(product) {
  return sendTransactionalEmail({
    to: { email: process.env.BREVO_ADMIN_ALERT_EMAIL, name: 'winnersHealth Admin' },
    subject: `⚠️ Low stock: ${product.name} (${product.stock} left)`,
    htmlContent: `<p><strong>${product.name}</strong> is down to ${product.stock} units. Restock soon.</p>`,
    tags: ['stock-alert', 'internal'],
  });
}
module.exports = { sendOrderAlertToAdmin, sendLowStockAlert };