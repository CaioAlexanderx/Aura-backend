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
// Empresa de teste nao dispara notificacao real: o pedido de teste
// tocaria o celular de alguem. Ver services/lojaDeTeste.js.
const { ehLojaDeTeste, anotarBloqueio } = require('./lojaDeTeste');
const {
  sendOrderStatusEmail,
  sendOwnerNewOrderEmail,
} = require('./mailer');
const { vitrineV2Ligada } = require('./vitrineV2');

/**
 * O link do pedido para o e-mail de confirmacao da cliente do Studio
 * (Fase 2 da vitrine, 25/09/2026). A loja comum nao tem pagina de pedido
 * e segue sem link.
 *
 *   - loja na vitrine nova (chave `vitrine_v2`): a confirmacao persistente
 *     no endereco da loja, `<loja>/pedido/<token>`;
 *   - loja na vitrine de hoje: o acompanhamento, que ja existe e funciona.
 *
 * A pagina nova so vira o link do e-mail com a chave ligada porque a
 * chave e o que garante que o app que a desenha ja esta no ar naquela
 * loja. Quando a chave sair (fim da Fase 5), sai com ela.
 *
 * Best-effort: qualquer falha (coluna ausente, loja sem config) vira
 * e-mail sem botao, nunca e-mail que nao sai.
 */
async function linkDoPedidoDaVitrine(order) {
  // So o Studio tem pagina de pedido. `vertical` vem da linha recarregada
  // (NOTIFY_FIELDS) ou do RETURNING * — pedido sem ela nao e do Studio
  // para este fim, e a loja comum nao paga uma consulta a mais.
  if (!order || !order.id || order.vertical !== 'studio') return null;
  try {
    const { rows } = await db.query(
      `SELECT o.public_token, o.vertical, dcc.slug, dcc.custom_domain, dcc.custom_domain_status,
              COALESCE(c.studio_settings, '{}'::jsonb) AS studio_settings
         FROM digital_orders o
         JOIN digital_channel_config dcc ON dcc.company_id = o.company_id
         JOIN companies c ON c.id = o.company_id
        WHERE o.id = $1
        LIMIT 1`,
      [order.id]
    );
    const r = rows[0];
    if (!r || r.vertical !== 'studio' || !r.public_token) return null;
    if (vitrineV2Ligada(r.studio_settings)) {
      // Import tardio: storefrontBuilder carrega meio mundo, e este modulo
      // e requerido por webhooks que nao precisam dele no caminho comum.
      const { urlDaLoja } = require('./storefrontBuilder');
      return { url: `${urlDaLoja(r)}/pedido/${r.public_token}`, rotulo: 'Ver meu pedido' };
    }
    const app = process.env.APP_PUBLIC_URL || '';
    if (!/^https:\/\//.test(app)) return null;
    return { url: `${app}/acompanhar/${r.public_token}`, rotulo: 'Acompanhar meu pedido' };
  } catch (err) {
    console.error('[notify] link do pedido indisponivel:', err.message);
    return null;
  }
}

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

/**
 * Quem recebe o e-mail de pedido novo (tq-88), pela preferência pedido_loja
 * da empresa (services/emailPreferencias), lida na hora:
 *   - desligado: ninguém;
 *   - pedido_destino 'enderecos' ("só os e-mails da tela"): os endereços
 *     confirmados marcados;
 *   - 'equipe' ou sem escolha: todos os company_members, como sempre foi.
 * Falha ao ler a preferência: o comportamento de sempre (a equipe toda).
 */
async function destinatariosDoPedido(company_id) {
  try {
    const { destinoDoPedido } = require('./emailPreferencias');
    const d = await destinoDoPedido(db, company_id);
    if (!d.ligado) return [];
    if (d.destino === 'enderecos') return d.emails || [];
  } catch (err) {
    console.error('[notify] preferencia de pedido indisponivel:', err.message);
  }
  return getOwnerEmails(company_id);
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

// 17/08/2026: guarda contra `undefined`/null. Antes, um `total` ausente
// virava `Number(undefined).toFixed(2)` = "NaN" e o lojista recebia
// "R$ NaN" no push e no e-mail. Ver loadOrderForNotify() abaixo.
const fmt = (v) => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return 'R$ —';
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
};

// Colunas que as notificações realmente consomem.
const NOTIFY_FIELDS =
  'id, company_id, order_number, customer_name, customer_email, ' +
  'customer_phone, total, delivery_type, payment_method, ' +
  // migration 288 — sem estas duas o caminho de recarga perde justamente
  // o que o lojista precisa saber num pedido delivery_type='courier'.
  'courier_name, courier_plate, ' +
  // Fase 2 da vitrine Studio: decide se o e-mail da cliente leva o link
  // do pedido (linkDoPedidoDaVitrine) sem uma consulta a mais na loja comum.
  'vertical';

/**
 * 17/08/2026 — POR QUE ISSO EXISTE:
 * Cada caller de notifyPaymentConfirmed montava o `order` com um SELECT
 * próprio, e 3 dos 5 esqueciam `total`, `delivery_type` e `customer_phone`:
 *   - digitalOrders.js  (approve-payment)
 *   - webhookMp.js      (Pix e cartão)
 *   - webhookAsaas.js
 * Resultado: push "R$ NaN", e-mail do lojista com Total "R$ NaN", modalidade
 * sempre "🏪 Retirada" (o ternário cai no else quando o campo é undefined) e
 * bloco de WhatsApp sumindo. Nunca apareceu em produção porque nenhum pedido
 * chegava a `confirmed` — o botão de aprovar Pix estava quebrado no app
 * (aura-app#686).
 *
 * A correção é o notificador deixar de confiar no que o caller passa e
 * recarregar a linha canônica pelo id. Assim um caller novo não precisa
 * lembrar da lista de colunas — o contrato passa a ser só `order.id`.
 */
async function loadOrderForNotify(order) {
  if (!order || !order.id) return order || null;

  // Caller já trouxe a linha completa (INSERT ... RETURNING *): não vai ao banco.
  const complete =
    order.company_id !== undefined &&
    order.total !== undefined &&
    order.delivery_type !== undefined &&
    order.customer_phone !== undefined;
  if (complete) return order;

  try {
    const { rows } = await db.query(
      `SELECT ${NOTIFY_FIELDS} FROM digital_orders WHERE id = $1`,
      [order.id]
    );
    // rows[0] vence nos campos que ele traz; overrides do caller que NÃO
    // estão em NOTIFY_FIELDS (ex.: `status` forçado pelo webhookAsaas)
    // continuam valendo.
    return rows.length ? { ...order, ...rows[0] } : order;
  } catch (err) {
    console.error('[notify] falha ao recarregar pedido pra notificação:', err.message);
    return order;
  }
}

// Nome, WhatsApp e logo da vitrine (digital_channel_config). WhatsApp e logo
// vão no e-mail ao cliente final (tq-75, variante "loja": a marca e o
// WhatsApp são os da loja, nunca os da Aura). Uma consulta só.
async function getStoreInfo(company_id) {
  try {
    const { rows } = await db.query(
      `SELECT site_name, whatsapp, logo_url FROM digital_channel_config WHERE company_id = $1`, [company_id]
    );
    const r = rows[0] || {};
    return { name: r.site_name || 'Aura Loja', whatsapp: r.whatsapp || null, logo_url: r.logo_url || null };
  } catch (_) {
    return { name: 'Aura Loja', whatsapp: null, logo_url: null };
  }
}

async function getStoreName(company_id) {
  return (await getStoreInfo(company_id)).name;
}

// E-mail da própria loja (companies.email), para o Reply-To dos e-mails
// ao cliente final (tq-72): a resposta do cliente vai para a loja, não para
// a Aura. Sem e-mail (2/3 dos cadastros novos não têm), o mailer usa
// noreply@. Best-effort: falha vira null, nunca e-mail que não sai.
async function getStoreEmail(company_id) {
  try {
    const { rows } = await db.query(
      `SELECT email FROM companies WHERE id = $1`, [company_id]
    );
    const email = rows[0] && rows[0].email ? String(rows[0].email).trim() : '';
    return email || null;
  } catch (_) {
    return null;
  }
}

// ---- Eventos públicos ----

/**
 * Chamada quando pagamento é confirmado: webhook MP (Pix/Cartão),
 * approve-payment manual ou pedido on_delivery (já nasce confirmado).
 *
 * Dispara 3 notificações em paralelo:
 *   1. Push ao lojista  — "📦 Novo pedido #X confirmado!" (Studio: sem emoji)
 *   2. E-mail ao lojista — template com resumo do pedido
 *   3. E-mail ao cliente — "Pedido confirmado ✅"
 */
async function notifyPaymentConfirmed({ order: input }) {
  // Recarrega a linha canônica: callers passam recortes diferentes do pedido.
  const order = await loadOrderForNotify(input);
  if (!order) return;

  const company_id = order.company_id;

  // A trava fica ANTES de tudo: se e um pedido de teste, do outro lado
  // dos tres envios abaixo ha um celular e duas caixas de e-mail reais.
  if (await ehLojaDeTeste(company_id)) {
    anotarBloqueio(`pedido #${order.order_number} confirmado`, company_id);
    return;
  }

  const store = await getStoreInfo(company_id);
  const store_name = store.name;

  // 'courier' (migration 288) precisa de rótulo próprio: sem ele o pedido
  // que um motoboy de app vai buscar chega como "🏪 Retirada", e o lojista
  // só descobre que há um terceiro no meio ao abrir o pedido. Nome e placa
  // vão no push porque é a informação de que ele precisa no balcão, na hora.
  //
  // Studio sem emoji (achado A16 do QA da vitrine, 26/09/2026): o fluxo
  // do Studio fala com a voz da loja, em texto. A loja comum fica como
  // estava — a regra é da vitrine Studio, não dos outros verticais.
  const comEmoji = order.vertical !== 'studio';
  const ic = (emoji) => (comEmoji ? `${emoji} ` : '');
  const deliveryLabel =
    order.delivery_type === 'delivery' ? `${ic('🚚')}Entrega` :
    order.delivery_type === 'courier'
      ? `${ic('🛵')}Retirada por app`
        + (order.courier_name  ? ` · ${order.courier_name}` : '')
        + (order.courier_plate ? ` (${order.courier_plate})` : '')
      : `${ic('🏪')}Retirada`;
  const paymentLabel  = order.payment_method === 'pix'         ? 'Pix' :
                        order.payment_method === 'card'        ? 'Cartão' : 'Na entrega';

  // 1. Push ao lojista
  const tokens = await getOwnerPushTokens(company_id);
  await sendExpoPush(
    tokens,
    comEmoji
      ? `📦 Pedido #${order.order_number} confirmado!`
      : `Pedido #${order.order_number} confirmado`,
    `${order.customer_name} · ${fmt(order.total)} · ${paymentLabel} · ${deliveryLabel}`,
    { type: 'order_payment_confirmed', order_id: order.id, order_number: order.order_number }
  );

  // 2. E-mail ao lojista
  const ownerEmails = await destinatariosDoPedido(company_id);
  await Promise.all(ownerEmails.map(email =>
    sendOwnerNewOrderEmail(email, {
      order_number:    order.order_number,
      customer_name:   order.customer_name,
      customer_phone:  order.customer_phone,
      total:           order.total,
      delivery_type:   order.delivery_type,
      store_name,
      payment_method:  order.payment_method,
      company_id,
    }).catch(err => console.error('[notify] owner email error:', err.message))
  ));

  // 3. E-mail ao cliente — no Studio, com o link do pedido (Fase 2).
  if (order.customer_email) {
    const link = await linkDoPedidoDaVitrine(order);
    const store_email = await getStoreEmail(company_id);
    await sendOrderStatusEmail(order.customer_email, {
      order_number:  order.order_number,
      customer_name: order.customer_name,
      status:        'confirmed',
      store_name,
      store_email,
      store_whatsapp: store.whatsapp,
      store_logo_url: store.logo_url,
      ...(link ? { link } : {}),
    }).catch(err => console.error('[notify] customer confirmed email error:', err.message));
  }
}

/**
 * Chamada quando admin atualiza status via PATCH /orders/:oid/status.
 * Notifica o cliente por e-mail para os status que fazem sentido notificar.
 */
async function notifyStatusChange(order) {
  const CUSTOMER_NOTIFY_STATUSES = ['preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'];
  if (!CUSTOMER_NOTIFY_STATUSES.includes(order.status)) return;
  if (!order.customer_email) return;
  if (await ehLojaDeTeste(order.company_id)) {
    anotarBloqueio(`mudanca de status para "${order.status}"`, order.company_id);
    return;
  }

  const store = await getStoreInfo(order.company_id);
  const store_email = await getStoreEmail(order.company_id);
  await sendOrderStatusEmail(order.customer_email, {
    order_number:  order.order_number,
    customer_name: order.customer_name,
    status:        order.status,
    store_name:    store.name,
    store_email,
    store_whatsapp: store.whatsapp,
    store_logo_url: store.logo_url,
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

/**
 * Pedido com Pix MANUAL acabou de nascer (10/09/2026).
 *
 * No Pix manual ninguém confirma o pagamento sozinho: é a lojista quem
 * confere o extrato. O e-mail ao dono só saía em notifyPaymentConfirmed —
 * que, no Pix manual, é disparado pela própria lojista ao clicar em
 * "Confirmar pagamento". O aviso chegava depois de ela já saber.
 *
 * Só o e-mail ao dono: a cliente ainda não tem nada confirmado, e o aviso
 * no navegador vem pelo evento 'loja_pedido_novo' (services/lojaEvents.js).
 */
async function notifyManualPixOrder({ order: input }) {
  const order = await loadOrderForNotify(input);
  if (!order) return;

  if (await ehLojaDeTeste(order.company_id)) {
    anotarBloqueio(`pedido #${order.order_number} aguardando Pix`, order.company_id);
    return;
  }

  const store_name = await getStoreName(order.company_id);
  const ownerEmails = await destinatariosDoPedido(order.company_id);
  await Promise.all(ownerEmails.map(email =>
    sendOwnerNewOrderEmail(email, {
      order_number:         order.order_number,
      customer_name:        order.customer_name,
      customer_phone:       order.customer_phone,
      total:                order.total,
      delivery_type:        order.delivery_type,
      store_name,
      payment_method:       order.payment_method,
      company_id:           order.company_id,
      aguardando_pagamento: true,
    }).catch(err => console.error('[notify] manual pix owner email error:', err.message))
  ));
}

/**
 * Pedido de pagar na entrega que espera o aceite da lojista (tq-44,
 * 29/10/2026). So o e-mail ao dono, como no Pix manual: a cliente ainda nao
 * tem nada confirmado, e o sino/navegador vem de 'loja_pedido_novo'.
 */
async function notifyPedidoAAceitar({ order: input }) {
  const order = await loadOrderForNotify(input);
  if (!order) return;

  if (await ehLojaDeTeste(order.company_id)) {
    anotarBloqueio(`pedido #${order.order_number} esperando aceite`, order.company_id);
    return;
  }

  const { ROTULOS } = require('./pagarNaEntrega');
  const store_name = await getStoreName(order.company_id);
  const ownerEmails = await destinatariosDoPedido(order.company_id);
  await Promise.all(ownerEmails.map(email =>
    sendOwnerNewOrderEmail(email, {
      order_number:      order.order_number,
      customer_name:     order.customer_name,
      customer_phone:    order.customer_phone,
      total:             order.total,
      delivery_type:     order.delivery_type,
      store_name,
      payment_method:    order.payment_method,
      company_id:        order.company_id,
      aguardando_aceite: true,
      forma_na_entrega:  ROTULOS[input && input.pay_on_delivery_method] || null,
    }).catch(err => console.error('[notify] pedido a aceitar owner email error:', err.message))
  ));
}

module.exports = {
  notifyNewOrder, notifyPaymentConfirmed, notifyStatusChange, notifyManualPixOrder, notifyPedidoAAceitar,
  linkDoPedidoDaVitrine,
};
