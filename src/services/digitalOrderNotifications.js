// ============================================================
// AURA. — Canal Digital: Notificações de Pedidos
//
// Eventos cobertes:
//   notifyNewOrder(...)       — novo pedido criado na storefront
//   notifyPaymentConfirmed(.) — Pix confirmado pelo webhook Asaas
//   notifyStatusChange(...)   — admin avança status do pedido
//
// Push: Expo Push API (ExponentPushToken)
// Email: via mailer.js (Resend / SMTP / dev fallback)
// ============================================================
const db = require('../config/database');
const { sendOrderConfirmationEmail, sendOrderStatusEmail } = require('./mailer');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

// ---- Expo Push ----

async function getOwnerPushTokens(company_id) {
  // Tentativa 1: tabela dedicada push_tokens
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT pt.token
      FROM push_tokens pt
      WHERE pt.user_id IN (
        SELECT user_id FROM company_members WHERE company_id = $1
      )
      AND pt.token LIKE 'ExponentPushToken[%'
    `, [company_id]);
    if (rows.length) return rows.map(r => r.token);
  } catch (_) {}

  // Tentativa 2: coluna push_token em users
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT u.push_token
      FROM users u
      JOIN company_members cm ON cm.user_id = u.id
      WHERE cm.company_id = $1
        AND u.push_token IS NOT NULL
        AND u.push_token LIKE 'ExponentPushToken[%'
    `, [company_id]);
    return rows.map(r => r.push_token);
  } catch (_) {}

  return [];
}

async function sendExpoPush(tokens, title, body, data) {
  if (!tokens || !tokens.length) return;
  try {
    const messages = tokens.map(to => ({
      to,
      sound: 'default',
      title,
      body,
      data: data || {},
      badge: 1,
    }));
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(messages),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok) console.warn('[push] Expo API error:', JSON.stringify(result));
  } catch (err) {
    console.error('[push] Expo fetch error:', err.message);
  }
}

// ---- Helpers ----

const fmt = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

async function getStoreName(company_id) {
  try {
    const { rows } = await db.query(
      `SELECT site_name FROM digital_channel_config WHERE company_id = $1`, [company_id]
    );
    return rows[0]?.site_name || 'Aura Loja';
  } catch (_) {
    return 'Aura Loja';
  }
}

// ---- Eventos públicos ----

/**
 * Notifica lojista (push) e cliente (e-mail) após novo pedido.
 * @param {object} options
 * @param {object} options.order  - objeto digital_orders (retornado pelo INSERT)
 * @param {number} options.total  - total do pedido
 * @param {string} [options.pix_payload] - payload Pix copia-e-cola
 * @param {object} [options.config] - digital_channel_config da loja
 */
async function notifyNewOrder({ order, total, pix_payload, config }) {
  const company_id = order.company_id;
  const store_name = config?.site_name || await getStoreName(company_id);
  const deliveryLabel = order.delivery_type === 'delivery' ? '🚚 Entrega' : '🏪 Retirada';

  // Push ao lojista
  const tokens = await getOwnerPushTokens(company_id);
  await sendExpoPush(
    tokens,
    `📦 Novo pedido #${order.order_number}`,
    `${order.customer_name} · ${fmt(total)} · ${deliveryLabel}`,
    { type: 'new_digital_order', order_id: order.id, order_number: order.order_number }
  );

  // E-mail ao cliente
  if (order.customer_email) {
    await sendOrderConfirmationEmail(order.customer_email, {
      order_number:   order.order_number,
      customer_name:  order.customer_name,
      total,
      pix_payload:    pix_payload || null,
      pix_expires_at: order.asaas_pix_expires_at || null,
      delivery_type:  order.delivery_type,
      store_name,
    }).catch(err => console.error('[notify] confirmation email error:', err.message));
  }
}

/**
 * Chamada pelo webhook Asaas quando PAYMENT_CONFIRMED.
 * Notifica lojista (push) e cliente (e-mail de "pedido confirmado").
 */
async function notifyPaymentConfirmed({ order }) {
  const company_id = order.company_id;
  const store_name = await getStoreName(company_id);

  // Push ao lojista: pagamento recebido
  const tokens = await getOwnerPushTokens(company_id);
  await sendExpoPush(
    tokens,
    `✅ Pagamento confirmado!`,
    `Pedido #${order.order_number} · ${order.customer_name} pagou via Pix`,
    { type: 'order_payment_confirmed', order_id: order.id, order_number: order.order_number }
  );

  // E-mail ao cliente: pedido confirmado
  if (order.customer_email) {
    await sendOrderStatusEmail(order.customer_email, {
      order_number:  order.order_number,
      customer_name: order.customer_name,
      status:        'confirmed',
      store_name,
    }).catch(err => console.error('[notify] payment confirmed email error:', err.message));
  }
}

/**
 * Chamada quando admin atualiza status via PATCH /orders/:oid/status.
 * Notifica o cliente por e-mail.
 */
async function notifyStatusChange(order) {
  // Apenas status que têm sentido notificar o cliente
  const CUSTOMER_NOTIFY_STATUSES = ['preparing', 'ready', 'delivered', 'cancelled'];
  if (!CUSTOMER_NOTIFY_STATUSES.includes(order.status)) return;
  if (!order.customer_email) return;

  const store_name = await getStoreName(order.company_id);
  await sendOrderStatusEmail(order.customer_email, {
    order_number:  order.order_number,
    customer_name: order.customer_name,
    status:        order.status,
    store_name,
  }).catch(err => console.error('[notify] status email error:', err.message));
}

module.exports = { notifyNewOrder, notifyPaymentConfirmed, notifyStatusChange };
