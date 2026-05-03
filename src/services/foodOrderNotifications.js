// ============================================================
// AURA. — Food Service: notificações WhatsApp
// Extraído de src/routes/foodOrders.js
// ============================================================
const db = require('../config/database');

const STATUS_MESSAGES = {
  confirmed: 'recebido e confirmado! Em breve começa a preparação.',
  preparing: 'em preparo na cozinha. Aguarde!',
  ready:     'pronto para retirada ou saiu para entrega.',
  delivered: 'entregue! Bom apetite. 😊',
  cancelled: 'cancelado. Em caso de dúvidas, entre em contato.',
};

function buildWhatsAppMsg(order) {
  const verb = STATUS_MESSAGES[order.status];
  if (!verb) return null;
  const id   = order.id.slice(-6).toUpperCase();
  const name = order.customer_name ? ', ' + order.customer_name.split(' ')[0] : '';
  return `Olá${name}! 🍽️\n\nSeu pedido *#${id}* está ${verb}\n\nAcompanhe: getaura.com.br/pedido/${order.id}\n\nObrigado pela preferência! ✨`;
}

async function notifyWhatsApp(order) {
  const msg = buildWhatsAppMsg(order);
  if (!msg || !order.customer_phone) return false;
  // TODO pós-CNPJ: await whatsappClient.sendMessage(order.customer_phone, msg);
  console.log(`[food/whatsapp] STUB — ${order.customer_phone}: ${msg.slice(0,60)}...`);
  return true;
}

async function sendReviewLink(order, companyId) {
  if (!order.customer_phone) return false;
  const { rows } = await db.query(
    `SELECT review_sent_at FROM food_orders WHERE id=$1`, [order.id]
  );
  if (rows[0]?.review_sent_at) return false;

  const id   = order.id.slice(-6).toUpperCase();
  const name = order.customer_name ? ', ' + order.customer_name.split(' ')[0] : '';
  const reviewUrl = `getaura.com.br/avaliar/${order.id}`;
  const msg = `Olá${name}! 🙏\n\nEsperamos que tenha gostado do pedido *#${id}*!\n\nAvalie o seu pedido (leva 30 segundos):\n👉 ${reviewUrl}\n\nSua opinião é muito importante para nós! ⭐`;

  // TODO pós-CNPJ: await whatsappClient.sendMessage(order.customer_phone, msg);
  console.log(`[food/review] STUB — ${order.customer_phone}: ${msg.slice(0,60)}...`);

  await db.query(
    `UPDATE food_orders SET review_sent_at=NOW() WHERE id=$1`, [order.id]
  );
  return true;
}

module.exports = { buildWhatsAppMsg, notifyWhatsApp, sendReviewLink };
