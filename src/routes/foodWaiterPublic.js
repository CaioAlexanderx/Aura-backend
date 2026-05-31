// ============================================================
// AURA. — FOOD-07: Rotas PUBLICAS do garcom (QR Code da Mesa)
// ============================================================
// Split de foodWaiter.js: estas rotas sao montadas em /food/table
// (publico, sem auth, sem requirePlan) e por isso NAO podem
// compartilhar router com as rotas autenticadas /companies/:id/food/waiter.
//
// Inclui:
//   - GET  /public/:tableId/menu   -> cardapio publico (sem cost_price)
//   - POST /public/:tableId/order  -> auto-pedido (rate-limit + validacao)
//   - POST /public/:tableId/call   -> chamada de garcom (rate-limit)
// ============================================================
const router    = require('express').Router({ mergeParams: true });
const rateLimit = require('express-rate-limit');
const db        = require('../config/database');

// ── Rate limit: 5 requests/min por IP+mesa ───────────────────
// Limita spam de pedido/chamada de garcom de um mesmo cliente.
const publicLimiter = rateLimit({
  windowMs: 60_000,
  max:      5,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `${req.ip}:${req.params.tableId}`,
  message: { error: 'Muitas requisicoes — aguarde 1 minuto.' },
  skip: (req) => process.env.NODE_ENV === 'test',
});

// ── GET /public/:tableId/menu — cardapio publico ─────────────
// SELECT explicito SEM cost_price (B6 — nao expor custo).
router.get('/public/:tableId/menu', async (req, res) => {
  try {
    const { rows: tables } = await db.query(
      `SELECT ft.*, fm.company_id, fm.name AS menu_name, fm.accepts_online_orders,
              fm.min_order_amount,
              COALESCE(c.trade_name, c.legal_name) AS business_name
       FROM food_tables ft
       JOIN food_menus fm ON fm.company_id = ft.company_id AND fm.is_active=TRUE
       JOIN companies c ON c.id = ft.company_id
       WHERE ft.id=$1
       ORDER BY fm.created_at LIMIT 1`,
      [req.params.tableId]
    );
    if (!tables.length) return res.status(404).json({ error: 'Mesa nao encontrada' });
    const table = tables[0];

    const { rows: categories } = await db.query(
      `SELECT id, menu_id, company_id, name, sort_order, is_active
       FROM food_categories WHERE company_id=$1 AND is_active=TRUE ORDER BY sort_order`,
      [table.company_id]
    );
    // SELECT explicito de food_items, food_item_variations e food_addons
    // — NUNCA inclui cost_price (B6).
    const { rows: items } = await db.query(
      `SELECT
         fi.id, fi.company_id, fi.category_id, fi.name, fi.description, fi.price,
         fi.photo_url, fi.preparation_time_min, fi.serves, fi.tags, fi.sort_order,
         fi.is_active, fi.is_available,
         COALESCE(json_agg(DISTINCT jsonb_build_object(
           'id', fiv.id, 'name', fiv.name, 'price_delta', fiv.price_delta,
           'is_required', fiv.is_required, 'sort_order', fiv.sort_order
         )) FILTER (WHERE fiv.id IS NOT NULL),'[]') AS variations,
         COALESCE(json_agg(DISTINCT jsonb_build_object(
           'id', fa.id, 'name', fa.name, 'price', fa.price, 'max_qty', fa.max_qty
         )) FILTER (WHERE fa.id IS NOT NULL),'[]')  AS addons
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
  } catch (e) {
    console.error('[food/table/public/menu]', e.message);
    res.status(500).json({ error: 'Erro ao buscar cardapio' });
  }
});

// ── POST /public/:tableId/order — auto-pedido com validacao ──
router.post('/public/:tableId/order', publicLimiter, async (req, res) => {
  const { items, customer_name, notes, payment_method } = req.body;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'items obrigatorio' });

  try {
    // Carrega mesa + cardapio para validar accepts_online_orders (B4).
    const { rows: tables } = await db.query(
      `SELECT ft.company_id, fm.accepts_online_orders, fm.is_active AS menu_active
       FROM food_tables ft
       LEFT JOIN food_menus fm ON fm.company_id = ft.company_id AND fm.is_active=TRUE
       WHERE ft.id=$1
       ORDER BY fm.created_at LIMIT 1`,
      [req.params.tableId]
    );
    if (!tables.length) return res.status(404).json({ error: 'Mesa nao encontrada' });
    const { company_id: companyId, accepts_online_orders, menu_active } = tables[0];
    if (!menu_active) {
      return res.status(422).json({ error: 'Cardapio inativo — peca para o garcom anotar.' });
    }
    if (accepts_online_orders === false) {
      return res.status(422).json({ error: 'Auto-pedido desabilitado — peca para o garcom anotar.' });
    }

    // Valida cada item: ativo + disponivel + qty > 0 (B4).
    const itemIds = items.map(i => i.item_id).filter(Boolean);
    if (itemIds.length !== items.length) {
      return res.status(422).json({ error: 'Todo item precisa de item_id.' });
    }
    const { rows: dbItems } = await db.query(
      `SELECT id, name, price, is_active, is_available
       FROM food_items WHERE company_id=$1 AND id = ANY($2::uuid[])`,
      [companyId, itemIds]
    );
    const dbItemsById = new Map(dbItems.map(it => [it.id, it]));
    for (const it of items) {
      const dbi = dbItemsById.get(it.item_id);
      if (!dbi) return res.status(422).json({ error: `Item ${it.item_id} nao encontrado` });
      if (!dbi.is_active || !dbi.is_available) {
        return res.status(422).json({ error: `Item ${dbi.name} nao esta disponivel` });
      }
      if (!Number.isFinite(it.quantity) || it.quantity <= 0) {
        return res.status(422).json({ error: `Quantidade invalida para ${dbi.name}` });
      }
    }

    // Carrega variations envolvidas para calcular unit_price real (B7).
    const variationIds = items.map(i => i.variation_id).filter(Boolean);
    let variationsById = new Map();
    if (variationIds.length) {
      const { rows: dbVars } = await db.query(
        `SELECT id, item_id, name, price_delta
         FROM food_item_variations
         WHERE company_id=$1 AND id = ANY($2::uuid[]) AND is_active=TRUE`,
        [companyId, variationIds]
      );
      variationsById = new Map(dbVars.map(v => [v.id, v]));
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      let subtotal = 0;
      const enriched = items.map(item => {
        const dbi = dbItemsById.get(item.item_id);
        const variation = item.variation_id ? variationsById.get(item.variation_id) : null;
        // B7: unit_price calculado no backend — body é ignorado.
        const realUnitPrice = parseFloat(dbi.price) + parseFloat(variation?.price_delta || 0);
        const line = realUnitPrice * item.quantity;
        subtotal += line;
        return {
          ...item,
          item_name:       dbi.name,
          variation_name:  variation?.name || null,
          unit_price:      realUnitPrice,
          total_price:     line,
        };
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
  } catch (e) {
    console.error('[food/table/public/order]', e.message);
    res.status(500).json({ error: 'Erro ao criar pedido' });
  }
});

// ── POST /public/:tableId/call — chamada de garcom ──────────
router.post('/public/:tableId/call', publicLimiter, async (req, res) => {
  const { reason = 'Chamada' } = req.body;
  try {
    const { rows: tables } = await db.query(
      `SELECT company_id FROM food_tables WHERE id=$1`, [req.params.tableId]
    );
    if (!tables.length) return res.status(404).json({ error: 'Mesa nao encontrada' });

    const { rows } = await db.query(
      `INSERT INTO food_waiter_calls (company_id, table_id, reason)
       VALUES ($1,$2,$3) RETURNING *`,
      [tables[0].company_id, req.params.tableId, reason]
    );
    res.status(201).json({ ok: true, call_id: rows[0].id });
  } catch (e) {
    console.error('[food/table/public/call]', e.message);
    res.status(500).json({ error: 'Erro ao chamar garcom' });
  }
});

module.exports = router;
