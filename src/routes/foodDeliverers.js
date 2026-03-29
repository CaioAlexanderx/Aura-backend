// ============================================================
// AURA. — Gestão de Motoboys / Entregadores
// FOOD-04b: CRUD entregadores, despacho, comissão, histórico
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');

// Nota: requireAuth + requireCompanyAccess já aplicados em private.js
const guard = [requirePlan('negocio', 'expansao')];

// ── helpers ──────────────────────────────────────────────────
const notFound = (res, e = 'Registro') =>
  res.status(404).json({ error: `${e} não encontrado` });

function calcCommission(deliverer, deliveryFee) {
  if (deliverer.commission_mode === 'pct') {
    return parseFloat(((deliveryFee || 0) * deliverer.commission_pct / 100).toFixed(2));
  }
  return parseFloat(deliverer.commission_fixed || 0);
}

// ============================================================
// CRUD DE ENTREGADORES
// ============================================================

router.get('/', guard, async (req, res) => {
  const { active } = req.query;
  try {
    const cond = ['company_id = $1'];
    const vals = [req.params.id];
    if (active !== undefined) { cond.push('is_active = $2'); vals.push(active !== 'false'); }
    const { rows } = await db.query(
      `SELECT * FROM food_deliverers WHERE ${cond.join(' AND ')} ORDER BY name`,
      vals
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/deliverers] Erro ao listar:', e.message);
    res.status(500).json({ error: 'Erro ao buscar entregadores' });
  }
});

router.get('/:did', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM food_deliverers WHERE id = $1 AND company_id = $2`,
      [req.params.did, req.params.id]
    );
    if (!rows.length) return notFound(res, 'Entregador');
    res.json(rows[0]);
  } catch (e) {
    console.error('[food/deliverers] Erro ao buscar:', e.message);
    res.status(500).json({ error: 'Erro ao buscar entregador' });
  }
});

router.post('/', guard, async (req, res) => {
  const {
    name, phone, vehicle_type, vehicle_plate,
    commission_pct, commission_fixed, commission_mode, notes
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name obrigatório' });
  try {
    const { rows } = await db.query(
      `INSERT INTO food_deliverers
         (company_id, name, phone, vehicle_type, vehicle_plate,
          commission_pct, commission_fixed, commission_mode, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        req.params.id, name, phone || null,
        vehicle_type || 'moto', vehicle_plate || null,
        commission_pct  || 0,
        commission_fixed || 0,
        commission_mode  || 'fixed',
        notes || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[food/deliverers] Erro ao criar:', e.message);
    res.status(500).json({ error: 'Erro ao criar entregador' });
  }
});

router.patch('/:did', guard, async (req, res) => {
  const fields = [
    'name','phone','vehicle_type','vehicle_plate',
    'commission_pct','commission_fixed','commission_mode',
    'is_active','notes',
  ];
  const updates = [];
  const vals    = [];
  let i = 1;
  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = $${i++}`);
      vals.push(req.body[f]);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  updates.push(`updated_at = NOW()`);
  vals.push(req.params.did, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE food_deliverers SET ${updates.join(', ')}
       WHERE id = $${i} AND company_id = $${i + 1} RETURNING *`,
      vals
    );
    if (!rows.length) return notFound(res, 'Entregador');
    res.json(rows[0]);
  } catch (e) {
    console.error('[food/deliverers] Erro ao atualizar:', e.message);
    res.status(500).json({ error: 'Erro ao atualizar entregador' });
  }
});

router.delete('/:did', guard, async (req, res) => {
  try {
    await db.query(
      `UPDATE food_deliverers SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [req.params.did, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[food/deliverers] Erro ao remover:', e.message);
    res.status(500).json({ error: 'Erro ao remover entregador' });
  }
});

// ============================================================
// DESPACHO — atribuir / remover entregador de um pedido
// ============================================================

router.post('/dispatch', guard, async (req, res) => {
  const { order_id, deliverer_id, note } = req.body;
  if (!order_id || !deliverer_id)
    return res.status(400).json({ error: 'order_id e deliverer_id obrigatórios' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: orders } = await client.query(
      `SELECT id, status, delivery_fee FROM food_orders
       WHERE id = $1 AND company_id = $2`,
      [order_id, req.params.id]
    );
    if (!orders.length) { await client.query('ROLLBACK'); return notFound(res, 'Pedido'); }
    const order = orders[0];
    if (['delivered', 'cancelled'].includes(order.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Pedido já ${order.status} — não pode ser despachado` });
    }

    const { rows: deliverers } = await client.query(
      `SELECT * FROM food_deliverers WHERE id = $1 AND company_id = $2 AND is_active = TRUE`,
      [deliverer_id, req.params.id]
    );
    if (!deliverers.length) { await client.query('ROLLBACK'); return notFound(res, 'Entregador'); }
    const deliverer = deliverers[0];

    const commission = calcCommission(deliverer, order.delivery_fee);

    const { rows: prev } = await client.query(
      `SELECT deliverer_id FROM food_orders WHERE id = $1`, [order_id]
    );
    if (prev[0]?.deliverer_id && prev[0].deliverer_id !== deliverer_id) {
      await client.query(
        `INSERT INTO food_dispatch_log (order_id, company_id, deliverer_id, commission_calc, action, note)
         VALUES ($1,$2,$3,0,'unassigned','Substituído por novo entregador')`,
        [order_id, req.params.id, prev[0].deliverer_id]
      );
    }

    const { rows: updated } = await client.query(
      `UPDATE food_orders
       SET deliverer_id = $1, deliverer_commission = $2,
           dispatched_at = COALESCE(dispatched_at, NOW()), updated_at = NOW()
       WHERE id = $3 AND company_id = $4 RETURNING *`,
      [deliverer_id, commission, order_id, req.params.id]
    );

    await client.query(
      `INSERT INTO food_dispatch_log (order_id, company_id, deliverer_id, commission_calc, action, note)
       VALUES ($1,$2,$3,$4,'assigned',$5)`,
      [order_id, req.params.id, deliverer_id, commission, note || null]
    );

    await client.query('COMMIT');
    res.json({
      order: updated[0],
      deliverer: deliverer.name,
      commission_calc: commission,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[food/dispatch] Erro ao despachar:', e.message);
    res.status(500).json({ error: 'Erro ao despachar entregador' });
  } finally { client.release(); }
});

router.delete('/dispatch/:orderId', guard, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT deliverer_id FROM food_orders WHERE id = $1 AND company_id = $2`,
      [req.params.orderId, req.params.id]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return notFound(res, 'Pedido'); }
    if (rows[0].deliverer_id) {
      await client.query(
        `INSERT INTO food_dispatch_log (order_id, company_id, deliverer_id, commission_calc, action)
         VALUES ($1,$2,$3,0,'unassigned')`,
        [req.params.orderId, req.params.id, rows[0].deliverer_id]
      );
    }
    await client.query(
      `UPDATE food_orders
       SET deliverer_id = NULL, deliverer_commission = NULL, updated_at = NOW()
       WHERE id = $1 AND company_id = $2`,
      [req.params.orderId, req.params.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[food/dispatch] Erro ao remover despacho:', e.message);
    res.status(500).json({ error: 'Erro ao remover despacho' });
  } finally { client.release(); }
});

// ============================================================
// HISTÓRICO E COMISSÕES
// ============================================================

router.get('/:did/orders', guard, async (req, res) => {
  const { start, end, status, limit = 50, offset = 0 } = req.query;
  const cond = ['fo.company_id = $1', 'fo.deliverer_id = $2'];
  const vals = [req.params.id, req.params.did];
  let i = 3;
  if (start)  { cond.push(`fo.created_at >= $${i++}`); vals.push(start); }
  if (end)    { cond.push(`fo.created_at <= $${i++}`); vals.push(end); }
  if (status) { cond.push(`fo.status = $${i++}`);      vals.push(status); }
  try {
    const { rows } = await db.query(
      `SELECT fo.id, fo.status, fo.channel, fo.total, fo.delivery_fee,
              fo.deliverer_commission, fo.dispatched_at, fo.delivered_at,
              fo.customer_name, fo.created_at,
              ft.number AS table_number
       FROM food_orders fo
       LEFT JOIN food_tables ft ON ft.id = fo.table_id
       WHERE ${cond.join(' AND ')}
       ORDER BY fo.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...vals, limit, offset]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/deliverers/orders] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar pedidos do entregador' });
  }
});

router.get('/:did/commission', guard, async (req, res) => {
  const { start, end } = req.query;
  const dateStart = start || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const dateEnd   = end   || new Date().toISOString();
  try {
    const { rows: d } = await db.query(
      `SELECT name, commission_mode, commission_pct, commission_fixed
       FROM food_deliverers WHERE id = $1 AND company_id = $2`,
      [req.params.did, req.params.id]
    );
    if (!d.length) return notFound(res, 'Entregador');

    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'delivered')        AS deliveries,
         COUNT(*) FILTER (WHERE status = 'cancelled')        AS cancelled,
         SUM(deliverer_commission) FILTER (WHERE status = 'delivered') AS total_commission,
         SUM(delivery_fee)         FILTER (WHERE status = 'delivered') AS total_delivery_fees,
         ROUND(AVG(deliverer_commission) FILTER (WHERE status = 'delivered')::NUMERIC, 2) AS avg_commission,
         MIN(dispatched_at) AS first_dispatch,
         MAX(dispatched_at) AS last_dispatch
       FROM food_orders
       WHERE company_id = $1
         AND deliverer_id = $2
         AND created_at BETWEEN $3 AND $4`,
      [req.params.id, req.params.did, dateStart, dateEnd]
    );
    res.json({
      deliverer: d[0],
      period: { start: dateStart, end: dateEnd },
      ...rows[0],
      total_commission: parseFloat(rows[0].total_commission || 0),
    });
  } catch (e) {
    console.error('[food/deliverers/commission] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar comissão' });
  }
});

router.get('/commission/summary', guard, async (req, res) => {
  const { start, end } = req.query;
  const dateStart = start || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const dateEnd   = end   || new Date().toISOString();
  try {
    const { rows } = await db.query(
      `SELECT
         fd.id, fd.name, fd.vehicle_type,
         fd.commission_mode, fd.commission_pct, fd.commission_fixed,
         COUNT(fo.id)  FILTER (WHERE fo.status = 'delivered')   AS deliveries,
         SUM(fo.deliverer_commission)
           FILTER (WHERE fo.status = 'delivered')               AS total_commission,
         SUM(fo.delivery_fee)
           FILTER (WHERE fo.status = 'delivered')               AS total_fees
       FROM food_deliverers fd
       LEFT JOIN food_orders fo
         ON fo.deliverer_id = fd.id
         AND fo.created_at BETWEEN $2 AND $3
       WHERE fd.company_id = $1 AND fd.is_active = TRUE
       GROUP BY fd.id
       ORDER BY total_commission DESC NULLS LAST`,
      [req.params.id, dateStart, dateEnd]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/deliverers/commission/summary] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar resumo de comissões' });
  }
});

router.get('/:did/log', guard, async (req, res) => {
  const { limit = 50 } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT dl.*, fo.customer_name, fo.total, fo.status AS order_status
       FROM food_dispatch_log dl
       JOIN food_orders fo ON fo.id = dl.order_id
       WHERE dl.company_id = $1 AND dl.deliverer_id = $2
       ORDER BY dl.created_at DESC LIMIT $3`,
      [req.params.id, req.params.did, limit]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/deliverers/log] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar histórico de despachos' });
  }
});

module.exports = router;
