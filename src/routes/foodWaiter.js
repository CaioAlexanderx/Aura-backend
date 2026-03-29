// ============================================================
// AURA. — FOOD-07: App Garçom + Pedido via QR da Mesa
// API para PWA mobile do garçom e auto-pedido do cliente
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');

// Nota: requireAuth + requireCompanyAccess já aplicados em private.js
const guard = [requirePlan('negocio', 'expansao')];

// ── ROTAS AUTENTICADAS (App Garçom interno) ──────────────────

router.get('/tables', guard, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        ft.*,
        COUNT(fo.id) FILTER (
          WHERE fo.status NOT IN ('delivered','cancelled')
        ) AS active_orders,
        COALESCE(SUM(fo.total) FILTER (
          WHERE fo.status NOT IN ('delivered','cancelled')
        ), 0) AS open_total,
        (SELECT reason FROM food_waiter_calls wc
         WHERE wc.table_id=ft.id AND wc.status='pending'
         ORDER BY wc.created_at DESC LIMIT 1) AS pending_call
      FROM food_tables ft
      LEFT JOIN food_orders fo ON fo.table_id = ft.id
      WHERE ft.company_id = $1
      GROUP BY ft.id
      ORDER BY ft.number`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { console.error('[food/waiter/tables]', e.message); res.status(500).json({ error: 'Erro ao buscar mesas' }); }
});

router.get('/menu', guard, async (req, res) => {
  try {
    const { rows: categories } = await db.query(
      `SELECT fc.*
       FROM food_categories fc
       JOIN food_menus fm ON fm.id = fc.menu_id
       WHERE fm.company_id=$1 AND fc.is_active=TRUE
       ORDER BY fc.sort_order`,
      [req.params.id]
    );
    const { rows: items } = await db.query(
      `SELECT fi.*,
         COALESCE(json_agg(DISTINCT fiv.*) FILTER (WHERE fiv.id IS NOT NULL), '[]') AS variations,
         COALESCE(json_agg(DISTINCT fa.*) FILTER (WHERE fa.id IS NOT NULL), '[]') AS addons
       FROM food_items fi
       LEFT JOIN food_item_variations fiv ON fiv.item_id=fi.id AND fiv.is_active=TRUE
       LEFT JOIN food_addons fa ON fa.item_id=fi.id AND fa.is_active=TRUE
       WHERE fi.company_id=$1 AND fi.is_active=TRUE AND fi.is_available=TRUE
       GROUP BY fi.id ORDER BY fi.sort_order`,
      [req.params.id]
    );
    res.json({ categories, items });
  } catch (e) { console.error('[food/waiter/menu]', e.message); res.status(500).json({ error: 'Erro ao buscar cardápio' }); }
});

router.get('/calls', guard, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT wc.*, ft.number AS table_number
      FROM food_waiter_calls wc
      JOIN food_tables ft ON ft.id = wc.table_id
      WHERE wc.company_id=$1 AND wc.status='pending'
      ORDER BY wc.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { console.error('[food/waiter/calls]', e.message); res.status(500).json({ error: 'Erro ao buscar chamadas' }); }
});

router.patch('/calls/:callId/answer', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE food_waiter_calls
       SET status='answered', answered_by=$1, answered_at=NOW()
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [req.user?.id||null, req.params.callId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Chamada não encontrada' });
    res.json(rows[0]);
  } catch (e) { console.error('[food/waiter/calls]', e.message); res.status(500).json({ error: 'Erro ao responder chamada' }); }
});

router.post('/orders', guard, async (req, res) => {
  const { table_id } = req.body;
  if (table_id) {
    const { rows } = await db.query(
      `SELECT id FROM food_tables WHERE id=$1 AND company_id=$2`,
      [table_id, req.params.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'Mesa não pertence a esta empresa' });
  }
  req.body.channel = req.body.channel || 'presencial';
  res.status(501).json({
    message: 'Use POST /companies/:id/food/orders — este endpoint é um alias documentado.',
    forward_to: `/companies/${req.params.id}/food/orders`,
  });
});

// ── ROTAS PÚBLICAS (QR Code da Mesa — sem auth) ─────────────

router.get('/public/:tableId/menu', async (req, res) => {
  try {
    const { rows: tables } = await db.query(
      `SELECT ft.*, fm.company_id, fm.name AS menu_name, fm.accepts_online_orders,
              fm.min_order_amount, c.name AS business_name
       FROM food_tables ft
       JOIN food_menus fm ON fm.company_id = ft.company_id AND fm.is_active=TRUE
       JOIN companies c ON c.id = ft.company_id
       WHERE ft.id=$1
       ORDER BY fm.created_at LIMIT 1`,
      [req.params.tableId]
    );
    if (!tables.length) return res.status(404).json({ error: 'Mesa não encontrada' });
    const table = tables[0];

    const { rows: categories } = await db.query(
      `SELECT * FROM food_categories WHERE company_id=$1 AND is_active=TRUE ORDER BY sort_order`,
      [table.company_id]
    );
    const { rows: items } = await db.query(
      `SELECT fi.*,
         COALESCE(json_agg(DISTINCT fiv.*) FILTER (WHERE fiv.id IS NOT NULL),'[]') AS variations,
         COALESCE(json_agg(DISTINCT fa.*)  FILTER (WHERE fa.id IS NOT NULL),'[]')  AS addons
       FROM food_items fi
       LEFT JOIN food_item_variations fiv ON fiv.item_id=fi.id AND fiv.is_active=TRUE
       LEFT JOIN food_addons fa ON fa.item_id=fi.id AND fa.is_active=TRUE
       WHERE fi.company_id=$1 AND fi.is_active=TRUE AND fi.is_available=TRUE
       GROUP BY fi.id ORDER BY fi.sort_order`,
      [table.company_id]
    );

    res.json({
      table: { id: table.id, number: table.number, seats: table.seats },
      business: table.business_name,
      menu: {
        name: table.menu_name,
        accepts_online_orders: table.accepts_online_orders,
        min_order_amount: table.min_order_amount,
      },
      categories,
      items,
    });
  } catch (e) { console.error('[food/waiter/public/menu]', e.message); res.status(500).json({ error: 'Erro ao buscar cardápio' }); }
});

router.post('/public/:tableId/order', async (req, res) => {
  const { items, customer_name, notes, payment_method } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'items obrigatório' });

  try {
    const { rows: tables } = await db.query(
      `SELECT ft.company_id FROM food_tables ft WHERE ft.id=$1`,
      [req.params.tableId]
    );
    if (!tables.length) return res.status(404).json({ error: 'Mesa não encontrada' });
    const companyId = tables[0].company_id;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      let subtotal = 0;
      const enriched = items.map(item => {
        const line = parseFloat(item.unit_price) * item.quantity;
        subtotal += line;
        return { ...item, total_price: line };
      });

      const { rows: pt } = await client.query(
        `SELECT COALESCE(SUM(fi.preparation_time_min * q.qty), 15) AS prep_min
         FROM (SELECT UNNEST($1::uuid[]) AS iid, UNNEST($2::int[]) AS qty) q
         LEFT JOIN food_items fi ON fi.id=q.iid`,
        [items.map(i=>i.item_id), items.map(i=>i.quantity)]
      );

      const { rows: orders } = await client.query(
        `INSERT INTO food_orders
           (company_id, table_id, channel, status, subtotal, discount,
            delivery_fee, total, notes, customer_name, payment_method,
            estimated_ready_at)
         VALUES ($1,$2,'presencial','pending',$3,0,0,$3,$4,$5,$6,
                 NOW()+($7||' minutes')::interval)
         RETURNING *`,
        [companyId, req.params.tableId, subtotal, notes||null,
         customer_name||null, payment_method||null, pt[0]?.prep_min||15]
      );
      const order = orders[0];

      for (const item of enriched) {
        await client.query(
          `INSERT INTO food_order_items
             (order_id, item_id, item_name, variation_name, quantity,
              unit_price, total_price, addons, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [order.id, item.item_id||null, item.item_name, item.variation_name||null,
           item.quantity, item.unit_price, item.total_price,
           item.addons ? JSON.stringify(item.addons) : null, item.notes||null]
        );
      }

      await client.query(
        `UPDATE food_tables SET status='occupied' WHERE id=$1`, [req.params.tableId]
      );

      await client.query(
        `INSERT INTO food_kds_events (order_id, company_id, to_status)
         VALUES ($1,$2,'pending')`, [order.id, companyId]
      );

      await client.query('COMMIT');

      res.status(201).json({
        order_id: order.id,
        status: order.status,
        total: order.total,
        estimated_ready_at: order.estimated_ready_at,
        message: 'Pedido recebido! Acompanhe pelo status.',
        tracking_url: `getaura.com.br/pedido/${order.id}`,
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch (e) { console.error('[food/waiter/public/order]', e.message); res.status(500).json({ error: 'Erro ao criar pedido' }); }
});

router.post('/public/:tableId/call', async (req, res) => {
  const { reason = 'Chamada' } = req.body;
  try {
    const { rows: tables } = await db.query(
      `SELECT company_id FROM food_tables WHERE id=$1`, [req.params.tableId]
    );
    if (!tables.length) return res.status(404).json({ error: 'Mesa não encontrada' });

    const { rows } = await db.query(
      `INSERT INTO food_waiter_calls (company_id, table_id, reason)
       VALUES ($1,$2,$3) RETURNING *`,
      [tables[0].company_id, req.params.tableId, reason]
    );
    res.status(201).json({ ok: true, call_id: rows[0].id });
  } catch (e) { console.error('[food/waiter/public/call]', e.message); res.status(500).json({ error: 'Erro ao chamar garçom' }); }
});

module.exports = router;
