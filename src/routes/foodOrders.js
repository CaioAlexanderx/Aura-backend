// ============================================================
// AURA. — Módulo Food Service
// FOOD-03: Pedidos + KDS (controle de produção)
// FOOD-04: Delivery própria + notificação WhatsApp
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireAuth, requirePlan } = require('../middleware/auth');

const guard = [requireAuth, requirePlan(['negocio','expansao'])];

// Helpers
const notFound = (res, e='Pedido') => res.status(404).json({ error: `${e} não encontrado` });
const ORDER_TRANSITIONS = {
  pending:   ['confirmed','cancelled'],
  confirmed: ['preparing','cancelled'],
  preparing: ['ready'],
  ready:     ['delivered'],
  delivered: [],
  cancelled: []
};

// ============================================================
// FOOD-03 — PEDIDOS + KDS
// ============================================================

// GET  /companies/:id/food/orders         — listar pedidos (com filtros)
router.get('/', guard, async (req, res) => {
  const { status, channel, date, limit = 50, offset = 0 } = req.query;
  const cond = ['fo.company_id=$1'];
  const vals = [req.params.id];
  let i = 2;
  if (status)  { cond.push(`fo.status=$${i++}`);                     vals.push(status); }
  if (channel) { cond.push(`fo.channel=$${i++}`);                    vals.push(channel); }
  if (date)    { cond.push(`fo.created_at::date=$${i++}`);           vals.push(date); }

  try {
    const { rows } = await db.query(
      `SELECT fo.*,
         ft.number AS table_number,
         COALESCE(json_agg(foi.* ORDER BY foi.id) FILTER (WHERE foi.id IS NOT NULL), '[]') AS items
       FROM food_orders fo
       LEFT JOIN food_tables ft ON ft.id = fo.table_id
       LEFT JOIN food_order_items foi ON foi.order_id = fo.id
       WHERE ${cond.join(' AND ')}
       GROUP BY fo.id, ft.number
       ORDER BY fo.created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...vals, limit, offset]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET  /companies/:id/food/orders/kds     — visão KDS (pending + preparing)
router.get('/kds', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT fo.id, fo.status, fo.channel, fo.created_at, fo.notes,
         fo.customer_name, ft.number AS table_number,
         fo.estimated_ready_at,
         EXTRACT(EPOCH FROM (NOW() - fo.confirmed_at))/60 AS waiting_minutes,
         json_agg(foi.* ORDER BY foi.id) AS items
       FROM food_orders fo
       LEFT JOIN food_tables ft ON ft.id = fo.table_id
       LEFT JOIN food_order_items foi ON foi.order_id = fo.id
       WHERE fo.company_id=$1 AND fo.status IN ('confirmed','preparing')
       GROUP BY fo.id, ft.number
       ORDER BY fo.confirmed_at ASC NULLS LAST`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET  /companies/:id/food/orders/stats   — métricas do dia/semana/mês
router.get('/stats', guard, async (req, res) => {
  const { period = 'today' } = req.query;
  const periodMap = { today: `created_at::date = NOW()::date`, week: `created_at >= NOW()-INTERVAL'7 days'`, month: `created_at >= NOW()-INTERVAL'30 days'` };
  const periodFilter = periodMap[period] || periodMap.today;
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('cancelled'))         AS total_orders,
         COUNT(*) FILTER (WHERE status = 'delivered')                AS delivered_orders,
         COUNT(*) FILTER (WHERE status = 'cancelled')                AS cancelled_orders,
         ROUND(AVG(total) FILTER (WHERE status='delivered'),2)        AS avg_ticket,
         SUM(total)  FILTER (WHERE status='delivered')               AS revenue,
         AVG(EXTRACT(EPOCH FROM (ready_at - confirmed_at))/60)
           FILTER (WHERE ready_at IS NOT NULL AND confirmed_at IS NOT NULL) AS avg_prep_minutes
       FROM food_orders
       WHERE company_id=$1 AND ${periodFilter}`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET  /companies/:id/food/orders/:oid
router.get('/:oid', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT fo.*, ft.number AS table_number,
         json_agg(foi.* ORDER BY foi.id) AS items
       FROM food_orders fo
       LEFT JOIN food_tables ft ON ft.id = fo.table_id
       LEFT JOIN food_order_items foi ON foi.order_id = fo.id
       WHERE fo.id=$1 AND fo.company_id=$2
       GROUP BY fo.id, ft.number`,
      [req.params.oid, req.params.id]
    );
    if (!rows.length) return notFound(res);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /companies/:id/food/orders         — criar pedido
router.post('/', guard, async (req, res) => {
  const {
    table_id, customer_id, channel = 'presencial',
    items, notes, customer_name, customer_phone,
    delivery_address, payment_method
  } = req.body;

  if (!items?.length) return res.status(400).json({ error: 'items obrigatório' });

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Calcular totais
    let subtotal = 0;
    const enrichedItems = items.map(item => {
      const lineTotal = parseFloat(item.unit_price) * item.quantity;
      subtotal += lineTotal;
      return { ...item, total_price: lineTotal };
    });

    const delivery_fee = req.body.delivery_fee || 0;
    const discount     = req.body.discount     || 0;
    const total = subtotal + parseFloat(delivery_fee) - parseFloat(discount);

    // Tempo estimado (soma dos tempos de preparo)
    const { rows: preptimes } = await client.query(
      `SELECT COALESCE(SUM(fi.preparation_time_min * oi_qty.qty),15) AS prep_min
       FROM (SELECT UNNEST($1::uuid[]) AS iid, UNNEST($2::int[]) AS qty) oi_qty
       LEFT JOIN food_items fi ON fi.id = oi_qty.iid`,
      [items.map(i => i.item_id), items.map(i => i.quantity)]
    );
    const prepMin = preptimes[0]?.prep_min || 15;

    // Inserir pedido
    const { rows: orders } = await client.query(
      `INSERT INTO food_orders
         (company_id, table_id, customer_id, channel, subtotal, discount, delivery_fee, total,
          notes, customer_name, customer_phone, delivery_address, payment_method, estimated_ready_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW()+($14||' minutes')::interval)
       RETURNING *`,
      [req.params.id, table_id||null, customer_id||null, channel,
       subtotal, discount, delivery_fee, total,
       notes||null, customer_name||null, customer_phone||null,
       delivery_address ? JSON.stringify(delivery_address) : null,
       payment_method||null, prepMin]
    );
    const order = orders[0];

    // Inserir itens
    for (const item of enrichedItems) {
      await client.query(
        `INSERT INTO food_order_items
           (order_id, item_id, item_name, variation_name, quantity, unit_price, total_price, addons, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [order.id, item.item_id||null, item.item_name, item.variation_name||null,
         item.quantity, item.unit_price, item.total_price,
         item.addons ? JSON.stringify(item.addons) : null, item.notes||null]
      );
    }

    // Marcar mesa como occupied
    if (table_id) {
      await client.query(
        `UPDATE food_tables SET status='occupied' WHERE id=$1 AND company_id=$2`,
        [table_id, req.params.id]
      );
    }

    // KDS event
    await client.query(
      `INSERT INTO food_kds_events (order_id, company_id, to_status) VALUES ($1,$2,'pending')`,
      [order.id, req.params.id]
    );

    await client.query('COMMIT');
    res.status(201).json(order);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// PATCH /companies/:id/food/orders/:oid/status  — transição de status (KDS)
router.patch('/:oid/status', guard, async (req, res) => {
  const { status, note } = req.body;
  const client = await db.pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT status FROM food_orders WHERE id=$1 AND company_id=$2`,
      [req.params.oid, req.params.id]
    );
    if (!rows.length) return notFound(res);

    const current = rows[0].status;
    const allowed = ORDER_TRANSITIONS[current] || [];
    if (!allowed.includes(status))
      return res.status(400).json({ error: `Transição inválida: ${current} → ${status}` });

    await client.query('BEGIN');

    // Timestamps automáticos por status
    const tsMap = {
      confirmed:  'confirmed_at = NOW()',
      ready:      'ready_at = NOW()',
      delivered:  'delivered_at = NOW()',
    };
    const tsUpdate = tsMap[status] ? `, ${tsMap[status]}` : '';

    const { rows: updated } = await client.query(
      `UPDATE food_orders SET status=$1, updated_at=NOW() ${tsUpdate}
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [status, req.params.oid, req.params.id]
    );

    // Registrar evento no KDS
    await client.query(
      `INSERT INTO food_kds_events (order_id, company_id, from_status, to_status, triggered_by, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.oid, req.params.id, current, status, req.user?.id||null, note||null]
    );

    // Liberar mesa se entregue/cancelado
    if (['delivered','cancelled'].includes(status) && updated[0].table_id) {
      const { rows: otherOpen } = await client.query(
        `SELECT id FROM food_orders
         WHERE table_id=$1 AND status NOT IN ('delivered','cancelled') AND id!=$2`,
        [updated[0].table_id, req.params.oid]
      );
      if (!otherOpen.length) {
        await client.query(
          `UPDATE food_tables SET status='free' WHERE id=$1`, [updated[0].table_id]
        );
      }
    }

    await client.query('COMMIT');

    // Notificação WhatsApp (FOOD-04) — stub assíncrono
    _notifyWhatsApp(updated[0]).catch(() => {});

    res.json(updated[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// PATCH /companies/:id/food/orders/:oid/items/:iid/kds  — status por item (KDS granular)
router.patch('/:oid/items/:iid/kds', guard, async (req, res) => {
  const { kds_status } = req.body;
  if (!['pending','preparing','done'].includes(kds_status))
    return res.status(400).json({ error: 'kds_status inválido' });
  try {
    const { rows } = await db.query(
      `UPDATE food_order_items foi SET kds_status=$1
       FROM food_orders fo
       WHERE foi.id=$2 AND fo.id=foi.order_id AND fo.company_id=$3
       RETURNING foi.*`,
      [kds_status, req.params.iid, req.params.id]
    );
    if (!rows.length) return notFound(res, 'Item do pedido');
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET  /companies/:id/food/orders/kds/history  — histórico de eventos KDS
router.get('/kds/history', guard, async (req, res) => {
  const { date } = req.query;
  const dateFilter = date ? `AND ke.created_at::date=$2` : '';
  try {
    const { rows } = await db.query(
      `SELECT ke.*, fo.customer_name, fo.channel
       FROM food_kds_events ke
       JOIN food_orders fo ON fo.id = ke.order_id
       WHERE ke.company_id=$1 ${dateFilter}
       ORDER BY ke.created_at DESC LIMIT 200`,
      date ? [req.params.id, date] : [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// FOOD-04 — DELIVERY PRÓPRIA
// ============================================================

// GET  /companies/:id/food/orders/delivery  — pedidos de delivery ativos
router.get('/delivery/active', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT fo.*, ft.number AS table_number,
         json_agg(foi.* ORDER BY foi.id) AS items
       FROM food_orders fo
       LEFT JOIN food_tables ft ON ft.id = fo.table_id
       LEFT JOIN food_order_items foi ON foi.order_id = fo.id
       WHERE fo.company_id=$1
         AND fo.channel IN ('delivery_proprio','whatsapp','online')
         AND fo.status NOT IN ('delivered','cancelled')
       GROUP BY fo.id, ft.number
       ORDER BY fo.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /companies/:id/food/orders/:oid/notify  — reenviar notificação WhatsApp
router.post('/:oid/notify', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM food_orders WHERE id=$1 AND company_id=$2`,
      [req.params.oid, req.params.id]
    );
    if (!rows.length) return notFound(res);
    const sent = await _notifyWhatsApp(rows[0]);
    res.json({ sent, message: _buildWhatsAppMsg(rows[0]) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WhatsApp helpers (stub — substituir por API real pós-CNPJ) ──
const STATUS_MESSAGES = {
  confirmed:  'recebido e confirmado! Em breve começa a preparação.',
  preparing:  'em preparo na cozinha. Aguarde!',
  ready:      'pronto para retirada ou saiu para entrega.',
  delivered:  'entregue! Bom apetite. 😊',
  cancelled:  'cancelado. Em caso de dúvidas, entre em contato conosco.'
};

function _buildWhatsAppMsg(order) {
  const verb = STATUS_MESSAGES[order.status];
  if (!verb) return null;
  const id = order.id.slice(-6).toUpperCase();
  return `Olá${order.customer_name ? ', ' + order.customer_name.split(' ')[0] : ''}! 🍽️\n\nSeu pedido *#${id}* está ${verb}\n\nAcompanhe pelo link: getaura.com.br/pedido/${order.id}\n\nObrigado pela preferência! ✨`;
}

async function _notifyWhatsApp(order) {
  // Stub: integração real via WhatsApp Business API (pós-CNPJ)
  // Quando ativo, substituir por chamada à API do Meta
  const msg = _buildWhatsAppMsg(order);
  if (!msg || !order.customer_phone) return false;

  // TODO pós-CNPJ:
  // await whatsappClient.sendMessage(order.customer_phone, msg);
  console.log(`[food/whatsapp] STUB — ${order.customer_phone}: ${msg.slice(0,60)}...`);
  return true;
}

module.exports = router;
