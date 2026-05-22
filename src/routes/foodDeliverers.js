// ============================================================
// AURA. — Gestão de Motoboys / Entregadores
// FOOD-04b: CRUD entregadores, despacho, comissão, histórico
// FOOD-08 (Fase 8 — 22/05/2026): /commission-report (payout-aware),
//   PATCH /:did/payout, alias /:did/history (= /:did/log).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');

// Nota: requireAuth + requireCompanyAccess já aplicados em private.js
const guard = [requirePlan('negocio', 'expansao')];

// Cache module-level pro last_payout_at (migration 127 / armadilha_schema_pre_migration).
// Optimistic: assume true; vira false em 42703 (coluna ausente).
let HAS_LAST_PAYOUT_COL = true;

// ── helpers ──────────────────────────────────────────────────
const notFound = (res, e = 'Registro') =>
  res.status(404).json({ error: `${e} não encontrado` });

function calcCommission(deliverer, deliveryFee) {
  if (deliverer.commission_mode === 'pct') {
    return parseFloat(((deliveryFee || 0) * deliverer.commission_pct / 100).toFixed(2));
  }
  return parseFloat(deliverer.commission_fixed || 0);
}

// B9 — valida commission_mode e commission_pct em POST/PATCH.
function validateCommission(body) {
  if (body.commission_mode !== undefined &&
      !['pct', 'fixed'].includes(body.commission_mode)) {
    return 'commission_mode deve ser "pct" ou "fixed"';
  }
  if (body.commission_pct !== undefined && body.commission_pct !== null) {
    const pct = Number(body.commission_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return 'commission_pct deve ser número entre 0 e 100';
    }
  }
  if (body.commission_fixed !== undefined && body.commission_fixed !== null) {
    const fixed = Number(body.commission_fixed);
    if (!Number.isFinite(fixed) || fixed < 0) {
      return 'commission_fixed deve ser número >= 0';
    }
  }
  return null;
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
  // B9 — valida commission_*
  const cErr = validateCommission(req.body);
  if (cErr) return res.status(400).json({ error: cErr });
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
  // B9 — valida commission_* também no PATCH.
  const cErr = validateCommission(req.body);
  if (cErr) return res.status(400).json({ error: cErr });
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

// ============================================================
// FOOD-08 (Fase 8) — Commission Report (payout-aware) + Payout + History
// ============================================================

// GET /:did/commission-report?from=&to=
// Diferente do /:did/commission (legacy): retorna lista de orders + totals
// + payout block (last_payout_at + unpaid_total). Front usa pra tela
// MotoboyDrawer aba Comissao.
router.get('/:did/commission-report', guard, async (req, res) => {
  const { from, to } = req.query;
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const dateFrom = from ? new Date(from) : defaultFrom;
  const dateTo   = to   ? new Date(to)   : now;
  if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
    return res.status(400).json({ error: 'from/to devem ser ISO dates válidas' });
  }
  const fromIso = dateFrom.toISOString();
  const toIso   = dateTo.toISOString();

  try {
    // 1) Deliverer + last_payout_at (defensivo).
    let delivRow;
    if (HAS_LAST_PAYOUT_COL) {
      try {
        const { rows } = await db.query(
          `SELECT id, name, commission_mode, commission_pct, commission_fixed, last_payout_at
           FROM food_deliverers WHERE id=$1 AND company_id=$2`,
          [req.params.did, req.params.id]
        );
        if (!rows.length) return notFound(res, 'Entregador');
        delivRow = rows[0];
      } catch (e) {
        if (e.code === '42703') {
          HAS_LAST_PAYOUT_COL = false;
          console.warn('[food/deliverers/commission-report] last_payout_at ausente (migration 127 pendente)');
        } else throw e;
      }
    }
    if (!delivRow) {
      const { rows } = await db.query(
        `SELECT id, name, commission_mode, commission_pct, commission_fixed
         FROM food_deliverers WHERE id=$1 AND company_id=$2`,
        [req.params.did, req.params.id]
      );
      if (!rows.length) return notFound(res, 'Entregador');
      delivRow = { ...rows[0], last_payout_at: null };
    }

    // 2) Orders no período. Re-calcula commission_amount via CASE
    // pra honrar mudanca de regime (pct vs fixed) mesmo se o campo
    // deliverer_commission persistido estiver desatualizado.
    const { rows: ordersRows } = await db.query(
      `SELECT fo.id AS order_id, fo.delivered_at, fo.total AS total_amount,
              fo.deliverer_commission AS commission_persisted,
              CASE WHEN fd.commission_mode='pct'
                   THEN ROUND((fo.delivery_fee * COALESCE(fd.commission_pct,0) / 100.0)::NUMERIC, 2)
                   ELSE COALESCE(fd.commission_fixed, 0)
              END AS commission_amount
       FROM food_orders fo
       JOIN food_deliverers fd ON fd.id = fo.deliverer_id
       WHERE fo.company_id=$1 AND fo.deliverer_id=$2
         AND fo.delivered_at IS NOT NULL
         AND fo.delivered_at BETWEEN $3 AND $4
         AND fo.status='delivered'
       ORDER BY fo.delivered_at DESC`,
      [req.params.id, req.params.did, fromIso, toIso]
    );

    // 3) Totals
    let ordersCount   = 0;
    let totalDelivered= 0;
    let totalCommission = 0;
    for (const r of ordersRows) {
      ordersCount   += 1;
      totalDelivered+= parseFloat(r.total_amount || 0);
      // Prefere persisted se nao-nulo, senao usa recalculo.
      const c = r.commission_persisted != null
        ? parseFloat(r.commission_persisted)
        : parseFloat(r.commission_amount || 0);
      totalCommission += c;
    }

    // 4) Unpaid: comissoes em deliveries com delivered_at > last_payout_at
    // (ou todas se last_payout_at IS NULL). Calculado fora do filtro
    // from/to: representa saldo absoluto pendente, nao do periodo.
    let unpaidTotal = 0;
    let unpaidCount = 0;
    const lastPayout = delivRow.last_payout_at;
    if (HAS_LAST_PAYOUT_COL) {
      try {
        const unpaidSql = lastPayout
          ? `SELECT COUNT(*) AS cnt, COALESCE(SUM(
               CASE WHEN fd.commission_mode='pct'
                    THEN (fo.delivery_fee * COALESCE(fd.commission_pct,0) / 100.0)
                    ELSE COALESCE(fd.commission_fixed, 0)
               END
             ), 0) AS sum
             FROM food_orders fo
             JOIN food_deliverers fd ON fd.id=fo.deliverer_id
             WHERE fo.company_id=$1 AND fo.deliverer_id=$2
               AND fo.delivered_at IS NOT NULL
               AND fo.delivered_at > $3
               AND fo.status='delivered'`
          : `SELECT COUNT(*) AS cnt, COALESCE(SUM(
               CASE WHEN fd.commission_mode='pct'
                    THEN (fo.delivery_fee * COALESCE(fd.commission_pct,0) / 100.0)
                    ELSE COALESCE(fd.commission_fixed, 0)
               END
             ), 0) AS sum
             FROM food_orders fo
             JOIN food_deliverers fd ON fd.id=fo.deliverer_id
             WHERE fo.company_id=$1 AND fo.deliverer_id=$2
               AND fo.delivered_at IS NOT NULL
               AND fo.status='delivered'`;
        const unpaidParams = lastPayout
          ? [req.params.id, req.params.did, lastPayout]
          : [req.params.id, req.params.did];
        const { rows: unpaidRows } = await db.query(unpaidSql, unpaidParams);
        if (unpaidRows.length) {
          unpaidCount = parseInt(unpaidRows[0].cnt || 0, 10);
          unpaidTotal = parseFloat(unpaidRows[0].sum || 0);
        }
      } catch (e) {
        if (e.code === '42703') {
          HAS_LAST_PAYOUT_COL = false;
          console.warn('[food/deliverers/commission-report] last_payout_at ausente — payout=null');
        } else throw e;
      }
    }

    res.json({
      deliverer: {
        id: delivRow.id,
        name: delivRow.name,
        commission_mode: delivRow.commission_mode,
        commission_pct: delivRow.commission_pct,
        commission_fixed: delivRow.commission_fixed,
      },
      period: { from: fromIso, to: toIso },
      orders: ordersRows.map(r => ({
        order_id: r.order_id,
        delivered_at: r.delivered_at,
        total_amount: parseFloat(r.total_amount || 0),
        commission_amount: r.commission_persisted != null
          ? parseFloat(r.commission_persisted)
          : parseFloat(r.commission_amount || 0),
      })),
      totals: {
        orders_count: ordersCount,
        total_delivered: parseFloat(totalDelivered.toFixed(2)),
        total_commission: parseFloat(totalCommission.toFixed(2)),
      },
      payout: HAS_LAST_PAYOUT_COL
        ? {
            last_payout_at: lastPayout || null,
            unpaid_count: unpaidCount,
            unpaid_total: parseFloat(unpaidTotal.toFixed(2)),
          }
        : null,
    });
  } catch (e) {
    console.error('[food/deliverers/commission-report] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao gerar relatorio de comissao' });
  }
});

// PATCH /:did/payout
// Body: { until?: ISO date }   default: NOW()
// Marca last_payout_at e retorna deliverer atualizado.
router.patch('/:did/payout', guard, async (req, res) => {
  if (!HAS_LAST_PAYOUT_COL) {
    return res.status(503).json({
      error: 'Coluna last_payout_at ausente — aplique migration 127 antes',
      code: 'MIGRATION_PENDING',
    });
  }
  const { until } = req.body || {};
  let untilDate = null;
  if (until) {
    untilDate = new Date(until);
    if (isNaN(untilDate.getTime())) {
      return res.status(400).json({ error: 'until deve ser ISO date valida' });
    }
  }
  try {
    const { rows } = await db.query(
      `UPDATE food_deliverers
         SET last_payout_at = $1, updated_at = NOW()
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [untilDate || new Date(), req.params.did, req.params.id]
    );
    if (!rows.length) return notFound(res, 'Entregador');
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '42703') {
      HAS_LAST_PAYOUT_COL = false;
      return res.status(503).json({
        error: 'Coluna last_payout_at ausente — aplique migration 127 antes',
        code: 'MIGRATION_PENDING',
      });
    }
    console.error('[food/deliverers/payout] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao marcar payout' });
  }
});

// GET /:did/history — alias semantico de /:did/log
// Front usa /history na aba Historico do MotoboyDrawer (Fase 8).
// Estrutura: itens do food_dispatch_log (assigned/unassigned) + dados do pedido.
router.get('/:did/history', guard, async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT dl.id, dl.order_id, dl.deliverer_id, dl.commission_calc, dl.action,
              dl.note, dl.created_at,
              fo.customer_name, fo.total AS order_total, fo.status AS order_status,
              fo.delivered_at
       FROM food_dispatch_log dl
       LEFT JOIN food_orders fo ON fo.id = dl.order_id
       WHERE dl.company_id = $1
         AND (dl.deliverer_id = $2)
       ORDER BY dl.created_at DESC
       LIMIT $3 OFFSET $4`,
      [req.params.id, req.params.did, limit, offset]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/deliverers/history] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar historico do entregador' });
  }
});

module.exports = router;
