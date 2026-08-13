const { sendTransactionalEmail } = require("../services/brevoService");

// Order confirmation to the customer — replace templateId with the ID
// from your Brevo dashboard (Templates page, number after "#").
async function sendOrderConfirmation(order, customer) {
  return sendTransactionalEmail({
    to: { email: customer.email, name: customer.name },
    subject: `Order #${order.orderNumber} confirmed`,
    templateId: Number(process.env.BREVO_TEMPLATE_ORDER_CONFIRMATION),
    params: {
      customerName: customer.name,
      orderNumber: order.orderNumber,
      orderTotal: order.total,
      items: order.items.map((i) => ({
        name: i.name,
        qty: i.quantity,
        price: i.price,
      })),
      deliveryAddress: order.shippingAddress,
      estimatedDelivery: order.estimatedDelivery,
    },
    tags: ['order-confirmation'],
  });
}

// Shipping / status update
async function sendShippingUpdate(order, customer, trackingCode) {
  return sendTransactionalEmail({
    to: { email: customer.email, name: customer.name },
    subject: `Your order #${order.orderNumber} has shipped`,
    templateId: Number(process.env.BREVO_TEMPLATE_SHIPPING_UPDATE),
    params: {
      customerName: customer.name,
      orderNumber: order.orderNumber,
      trackingCode,
      estimatedArrival: order.estimatedDelivery,
    },
    tags: ['shipping-update'],
  });
}

// Password reset (static HTML, no template needed)
async function sendPasswordReset(user, resetLink) {
  return sendTransactionalEmail({
    to: { email: user.email, name: user.name },
    subject: 'Reset your Winners-health password',
    htmlContent: `
      <p>Hi ${user.name},</p>
      <p>Click below to reset your password. This link expires in 30 minutes.</p>
      <p><a href="${resetLink}">${resetLink}</a></p>
      <p>If you didn't request this, ignore this email.</p>
    `,
    tags: ['password-reset'],
  });
}

module.exports = { sendOrderConfirmation, sendShippingUpdate, sendPasswordReset };