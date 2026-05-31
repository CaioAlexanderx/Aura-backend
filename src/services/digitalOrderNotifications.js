// ============================================================
// AURA. — Canal Digital: Notificações de Pedidos
//
// Eventos cobertos:
//   notifyPaymentConfirmed(.) — pagamento confirmado (Pix/Cartão/Na Entrega)
//                               → push ao lojista + email ao lojista + email ao cliente
//   notifyStatusChange(...)   — admin avança status (preparing/ready/delivered/cancelled)
//                               → email ao cliente
//
// notifyNewOrder() está mantida por compatibilidade de assinatura mas é
// intencionalmente no-op para Pix e Cartão. Apenas on_delivery chama
// notifyPaymentConfirmed diretamente (pedido já nasce confirmado).
//
// Push: Expo Push API (ExponentPushToken)
// Email: via mailer.js (Resend / SMTP / dev fallback)
// ============================================================
const db = require('../config/database');
const {
  sendOrderStatusEmail,
  sendOwnerNewOrderEmail,
} = require('./mailer');

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

async function getOwnerEmails(company_id) {
  try {
    const { rows } = await db.query(`
      SELECT DISTINCT u.email
      FROM users u
      JOIN company_members cm ON cm.user_id = u.id
      WHERE cm.company_id = $1
        AND u.email IS NOT NULL
        AND u.email <> ''
    `, [company_id]);
    return rows.map(r => r.email);
  } catch (_) {
    return [];
  }
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
 * Chamada quando pagamento é confirmado: webhook MP (Pix/Cartão),
 * approve-payment manual ou pedido on_delivery (já nasce confirmado).
 *
 * Dispara 3 notificações em paralelo:
 *   1. Push ao lojista  — "📦 Novo pedido #X confirmado!"
 *   2. E-mail ao lojista — template com resumo do pedido
 *   3. E-mail ao cliente — "Pedido confirmado ✅"
 */
async function notifyPaymentConfirmed({ order }) {
  const company_id = order.company_id;
  const store_name = await getStoreName(company_id);

  const deliveryLabel = order.delivery_type === 'delivery' ? '🚚 Entrega' : '🏪 Retirada';
  const paymentLabel  = order.payment_method === 'pix'         ? 'Pix' :
                        order.payment_method === 'card'        ? 'Cartão' : 'Na entrega';

  // 1. Push ao lojista
  const tokens = await getOwnerPushTokens(company_id);
  await sendExpoPush(
    tokens,
    `📦 Pedido #${order.order_number} confirmado!`,
    `${order.customer_name} · ${fmt(order.total)} · ${paymentLabel} · ${deliveryLabel}`,
    { type: 'order_payment_confirmed', order_id: order.id, order_number: order.order_number }
  );

  // 2. E-mail ao lojista
  const ownerEmails = await getOwnerEmails(company_id);
  await Promise.all(ownerEmails.map(email =>
    sendOwnerNewOrderEmail(email, {
      order_number:    order.order_number,
      customer_name:   order.customer_name,
      customer_phone:  order.customer_phone,
      total:           order.total,
      delivery_type:   order.delivery_type,
      store_name,
      payment_method:  order.payment_method,
    }).catch(err => console.error('[notify] owner email error:', err.message))
  ));

  // 3. E-mail ao cliente
  if (order.customer_email) {
    await sendOrderStatusEmail(order.customer_email, {
      order_number:  order.order_number,
      customer_name: order.customer_name,
      status:        'confirmed',
      store_name,
    }).catch(err => console.error('[notify] customer confirmed email error:', err.message));
  }
}

/**
 * Chamada quando admin atualiza status via PATCH /orders/:oid/status.
 * Notifica o cliente por e-mail para os status que fazem sentido notificar.
 */
async function notifyStatusChange(order) {
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

/**
 * Mantida por compatibilidade — intencionalmente no-op para Pix e Cartão.
 * Para on_delivery, storefront.js chama notifyPaymentConfirmed diretamente.
 * @deprecated Não adicionar nova lógica aqui.
 */
async function notifyNewOrder() {
  // No-op. Notificações movidas para notifyPaymentConfirmed().
}

module.exports = { notifyNewOrder, notifyPaymentConfirmed, notifyStatusChange };
