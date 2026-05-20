// ============================================================
// AURA. — Rotas Públicas do Food (storefront)
// FOOD-10 (Fase 5): POST público de pedido pelo slug + zonas
//
// Montado em routes/index.js sob /food (sem auth).
// Convive com food.js que também está montado em /food — rotas mais
// específicas aqui não conflitam com as de food.js.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// GET /food/menu/public/:slug/zones — lista zonas de entrega
router.get('/menu/public/:slug/zones', async (req, res) => {
  try {
    const { rows: menus } = await db.query(
      `SELECT fm.company_id FROM food_menus fm
       WHERE fm.slug=$1 AND fm.is_active=TRUE LIMIT 1`,
      [req.params.slug]
    );
    if (!menus.length) return res.status(404).json({ error: 'Cardápio não encontrado' });
    const { rows: zones } = await db.query(
      `SELECT id, name, fee, min_time_min, max_time_min FROM food_delivery_zones
       WHERE company_id=$1 AND is_active=TRUE ORDER BY fee`,
      [menus[0].company_id]
    );
    res.json(zones);
  } catch (e) {
    console.error('[foodPublic/zones] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar zonas de entrega' });
  }
});

// POST /food/menu/public/:slug/order — cria pedido público sem mesa
router.post('/menu/public/:slug/order', async (req, res) => {
  const { items, customer_name, customer_phone, delivery_address,
          delivery_zone_id, notes, payment_method } = req.body;
  if (!items?.length)   return res.status(400).json({ error: 'items obrigatório' });
  if (!customer_name)   return res.status(400).json({ error: 'customer_name obrigatório' });
  if (!customer_phone)  return res.status(400).json({ error: 'customer_phone obrigatório' });

  try {
    // 1. Encontrar menu (só ativo + accepts_online_orders)
    const { rows: menus } = await db.query(
      `SELECT fm.*, c.id AS company_id FROM food_menus fm
       JOIN companies c ON c.id = fm.company_id
       WHERE fm.slug=$1 AND fm.is_active=TRUE AND fm.accepts_online_orders=TRUE LIMIT 1`,
      [req.params.slug]
    );
    if (!menus.length) return res.status(404).json({ error: 'Cardápio não encontrado ou não aceita pedidos online' });
    const menu = menus[0];
    const companyId = menu.company_id;

    // 2. Subtotal + valida min_order_amount
    let subtotal = 0;
    const enriched = items.map(it => {
      const t = parseFloat(it.unit_price) * it.quantity;
      subtotal += t;
      return { ...it, total_price: t };
    });
    if (menu.min_order_amount && subtotal < parseFloat(menu.min_order_amount)) {
      return res.status(400).json({ error: 'Pedido mínimo é R$ ' + Number(menu.min_order_amount).toFixed(2) });
    }

    // 3. Delivery fee da zone selecionada (opcional)
    let deliveryFee = 0;
    if (delivery_zone_id) {
      const { rows: zones } = await db.query(
        `SELECT fee FROM food_delivery_zones
         WHERE id=$1 AND company_id=$2 AND is_active=TRUE`,
        [delivery_zone_id, companyId]
      );
      if (zones.length) deliveryFee = parseFloat(zones[0].fee);
    }

    const total = subtotal + deliveryFee;

    // 4. Tempo estimado de preparo (soma items)
    const { rows: pt } = await db.query(
      `SELECT COALESCE(SUM(fi.preparation_time_min * q.qty), 20) AS prep_min
       FROM (SELECT UNNEST($1::uuid[]) AS iid, UNNEST($2::int[]) AS qty) q
       LEFT JOIN food_items fi ON fi.id=q.iid`,
      [items.map(i => i.item_id), items.map(i => i.quantity)]
    );
    const prepMin = pt[0]?.prep_min || 20;

    // 5. Cria pedido + items + kds_event (atomic)
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const { rows: orders } = await client.query(
        `INSERT INTO food_orders
           (company_id, channel, status, subtotal, discount, delivery_fee, total,
            notes, customer_name, customer_phone, delivery_address, payment_method,
            estimated_ready_at)
         VALUES ($1, 'online', 'pending', $2, 0, $3, $4, $5, $6, $7, $8, $9,
                 NOW() + ($10 || ' minutes')::interval)
         RETURNING *`,
        [companyId, subtotal, deliveryFee, total, notes || null,
         customer_name, customer_phone,
         delivery_address ? JSON.stringify(delivery_address) : null,
         payment_method || null, prepMin]
      );
      const order = orders[0];

      for (const it of enriched) {
        await client.query(
          `INSERT INTO food_order_items
             (order_id, item_id, item_name, variation_name, quantity, unit_price, total_price, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [order.id, it.item_id || null, it.item_name, it.variation_name || null,
           it.quantity, it.unit_price, it.total_price, it.notes || null]
        );
      }

      await client.query(
        `INSERT INTO food_kds_events (order_id, company_id, to_status) VALUES ($1,$2,'pending')`,
        [order.id, companyId]
      );

      await client.query('COMMIT');

      res.status(201).json({
        order_id:            order.id,
        status:              order.status,
        subtotal:            parseFloat(subtotal.toFixed(2)),
        delivery_fee:        parseFloat(deliveryFee.toFixed(2)),
        total:               parseFloat(total.toFixed(2)),
        estimated_ready_at:  order.estimated_ready_at,
        tracking_url:        'getaura.com.br/pedido/' + order.id,
        message:             'Pedido recebido! Você receberá WhatsApp quando for confirmado.',
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error('[foodPublic/order] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao criar pedido' });
  }
});

module.exports = router;
