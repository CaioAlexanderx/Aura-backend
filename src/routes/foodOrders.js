// ============================================================
// AURA. — Módulo Food Service
// FOOD-03: Pedidos + KDS (controle de produção)
// FOOD-04: Delivery própria + notificação WhatsApp
// FOOD-04c: Baixa de estoque automática ao entregar
// FOOD-04d: Avaliação pós-entrega via WhatsApp
// FOOD-08 (Fase 2): Gerenciar opened_at da mesa (set/clear sessão)
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');
const { buildWhatsAppMsg, notifyWhatsApp, sendReviewLink } = require('../services/foodOrderNotifications');

// Nota: requireAuth + requireCompanyAccess já aplicados em private.js
// SEC-02: requirePlan recebe strings separadas, NÃO array
const guard = [requirePlan('negocio', 'expansao')];

// B11 — Cache module-level pro hasOpenedAt (armadilha_schema_pre_migration).
// Optimistic: assume true; vira false na primeira vez que 42703 estourar.
let HAS_OPENED_AT_COL = true;

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

router.get('/', guard, async (req, res) => {
  const { status, channel, date, limit = 50, offset = 0 } = req.query;
  const cond = ['fo.company_id=$1'];
  const vals = [req.params.id];
  let i = 2;
  if (status)  { cond.push(`fo.status=$${i++}`);           vals.push(status); }
  if (channel) { cond.push(`fo.channel=$${i++}`);          vals.push(channel); }
  if (date)    { cond.push(`fo.created_at::date=$${i++}`); vals.push(date); }
  try {
    const { rows } = await db.query(
      `SELECT fo.*, ft.number AS table_number,
         fd.name AS deliverer_name,
         COALESCE(json_agg(foi.* ORDER BY foi.id) FILTER (WHERE foi.id IS NOT NULL), '[]') AS items
       FROM food_orders fo
       LEFT JOIN food_tables ft ON ft.id = fo.table_id
       LEFT JOIN food_deliverers fd ON fd.id = fo.deliverer_id
       LEFT JOIN food_order_items foi ON foi.order_id = fo.id
       WHERE ${cond.join(' AND ')}
       GROUP BY fo.id, ft.number, fd.name
       ORDER BY fo.created_at DESC
       LIMIT $${i} OFFSET $${i+1}`,
      [...vals, limit, offset]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/orders] Erro ao listar pedidos:', e.message);
    res.status(500).json({ error: 'Erro ao listar pedidos' });
  }
});

router.get('/kds', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT fo.id, fo.status, fo.channel, fo.created_at, fo.notes,
         fo.customer_name, ft.number AS table_number,
         fo.estimated_ready_at,
         fd.name AS deliverer_name,
         EXTRACT(EPOCH FROM (NOW() - fo.confirmed_at))/60 AS waiting_minutes,
         json_agg(foi.* ORDER BY foi.id) AS items
       FROM food_orders fo
       LEFT JOIN food_tables ft ON ft.id = fo.table_id
       LEFT JOIN food_deliverers fd ON fd.id = fo.deliverer_id
       LEFT JOIN food_order_items foi ON foi.order_id = fo.id
       WHERE fo.company_id=$1 AND fo.status IN ('confirmed','preparing')
       GROUP BY fo.id, ft.number, fd.name
       ORDER BY fo.confirmed_at ASC NULLS LAST`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/kds] Erro ao buscar KDS:', e.message);
    res.status(500).json({ error: 'Erro ao buscar painel KDS' });
  }
});

router.get('/stats', guard, async (req, res) => {
  const { period = 'today' } = req.query;
  const pf = { today:`created_at::date=NOW()::date`, week:`created_at>=NOW()-INTERVAL'7 days'`, month:`created_at>=NOW()-INTERVAL'30 days'` }[period] || `created_at::date=NOW()::date`;
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status NOT IN ('cancelled'))     AS total_orders,
              COUNT(*) FILTER (WHERE status='delivered')              AS delivered_orders,
              COUNT(*) FILTER (WHERE status='cancelled')              AS cancelled_orders,
              ROUND(AVG(total) FILTER (WHERE status='delivered'),2)   AS avg_ticket,
              SUM(total) FILTER (WHERE status='delivered')            AS revenue,
              AVG(EXTRACT(EPOCH FROM (ready_at - confirmed_at))/60)
                FILTER (WHERE ready_at IS NOT NULL AND confirmed_at IS NOT NULL) AS avg_prep_minutes
       FROM food_orders WHERE company_id=$1 AND ${pf}`,
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error('[food/stats] Erro ao buscar estatísticas:', e.message);
    res.status(500).json({ error: 'Erro ao buscar estatísticas' });
  }
});

router.get('/kds/history', guard, async (req, res) => {
  const { date } = req.query;
  const df = date ? `AND ke.created_at::date=$2` : '';
  try {
    const { rows } = await db.query(
      `SELECT ke.*, fo.customer_name, fo.channel
       FROM food_kds_events ke
       JOIN food_orders fo ON fo.id=ke.order_id
       WHERE ke.company_id=$1 ${df}
       ORDER BY ke.created_at DESC LIMIT 200`,
      date ? [req.params.id, date] : [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/kds/history] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar histórico KDS' });
  }
});

router.get('/delivery/active', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT fo.*, ft.number AS table_number, fd.name AS deliverer_name,
         json_agg(foi.* ORDER BY foi.id) AS items
       FROM food_orders fo
       LEFT JOIN food_tables ft ON ft.id=fo.table_id
       LEFT JOIN food_deliverers fd ON fd.id=fo.deliverer_id
       LEFT JOIN food_order_items foi ON foi.order_id=fo.id
       WHERE fo.company_id=$1
         AND fo.channel IN ('delivery_proprio','whatsapp','online')
         AND fo.status NOT IN ('delivered','cancelled')
       GROUP BY fo.id, ft.number, fd.name
       ORDER BY fo.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[food/delivery] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao buscar entregas ativas' });
  }
});

router.get('/:oid', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT fo.*, ft.number AS table_number, fd.name AS deliverer_name,
         json_agg(foi.* ORDER BY foi.id) AS items
       FROM food_orders fo
       LEFT JOIN food_tables ft ON ft.id=fo.table_id
       LEFT JOIN food_deliverers fd ON fd.id=fo.deliverer_id
       LEFT JOIN food_order_items foi ON foi.order_id=fo.id
       WHERE fo.id=$1 AND fo.company_id=$2
       GROUP BY fo.id, ft.number, fd.name`,
      [req.params.oid, req.params.id]
    );
    if (!rows.length) return notFound(res);
    res.json(rows[0]);
  } catch (e) {
    console.error('[food/order] Erro ao buscar pedido:', e.message);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

router.post('/', guard, async (req, res) => {
  const { table_id, customer_id, channel = 'presencial', items, notes,
          customer_name, customer_phone, delivery_address, payment_method } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'items obrigatório' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // B7 — Backend valida unit_price via lookup (não confia no body).
    // Carrega items + variations referenciados e re-calcula o preço real.
    const itemIds = items.map(i => i.item_id).filter(Boolean);
    let dbItemsById = new Map();
    if (itemIds.length) {
      const { rows: dbItems } = await client.query(
        `SELECT id, name, price FROM food_items
         WHERE company_id=$1 AND id = ANY($2::uuid[])`,
        [req.params.id, itemIds]
      );
      dbItemsById = new Map(dbItems.map(it => [it.id, it]));
    }
    const variationIds = items.map(i => i.variation_id).filter(Boolean);
    let variationsById = new Map();
    if (variationIds.length) {
      const { rows: dbVars } = await client.query(
        `SELECT id, name, price_delta FROM food_item_variations
         WHERE company_id=$1 AND id = ANY($2::uuid[])`,
        [req.params.id, variationIds]
      );
      variationsById = new Map(dbVars.map(v => [v.id, v]));
    }

    let subtotal = 0;
    const enrichedItems = items.map(item => {
      // Se item_id foi enviado e existe no DB, usa o preço de la (B7).
      const dbItem = item.item_id ? dbItemsById.get(item.item_id) : null;
      const variation = item.variation_id ? variationsById.get(item.variation_id) : null;
      let realUnitPrice;
      if (dbItem) {
        realUnitPrice = parseFloat(dbItem.price) + parseFloat(variation?.price_delta || 0);
        // Warning se diverge do body em >1 centavo.
        if (item.unit_price !== undefined &&
            Math.abs(parseFloat(item.unit_price) - realUnitPrice) > 0.01) {
          console.warn(`[food/order] unit_price divergente — item ${item.item_id}: body=${item.unit_price} real=${realUnitPrice}`);
        }
      } else {
        // Item sem item_id (texto livre) — confia no body como fallback.
        realUnitPrice = parseFloat(item.unit_price || 0);
      }
      const lineTotal = realUnitPrice * item.quantity;
      subtotal += lineTotal;
      return {
        ...item,
        item_name:      item.item_name || dbItem?.name,
        variation_name: item.variation_name || variation?.name || null,
        unit_price:     realUnitPrice,
        total_price:    lineTotal,
      };
    });

    const delivery_fee = req.body.delivery_fee || 0;
    const discount     = req.body.discount     || 0;
    const total = subtotal + parseFloat(delivery_fee) - parseFloat(discount);

    const { rows: pt } = await client.query(
      `SELECT COALESCE(SUM(fi.preparation_time_min * q.qty),15) AS prep_min
       FROM (SELECT UNNEST($1::uuid[]) AS iid, UNNEST($2::int[]) AS qty) q
       LEFT JOIN food_items fi ON fi.id=q.iid`,
      [items.map(i => i.item_id), items.map(i => i.quantity)]
    );
    const prepMin = pt[0]?.prep_min || 15;

    const { rows: orders } = await client.query(
      `INSERT INTO food_orders
         (company_id, table_id, customer_id, channel, subtotal, discount, delivery_fee, total,
          notes, customer_name, customer_phone, delivery_address, payment_method, estimated_ready_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()+($14||' minutes')::interval)
       RETURNING *`,
      [req.params.id, table_id||null, customer_id||null, channel, subtotal, discount, delivery_fee,
       total, notes||null, customer_name||null, customer_phone||null,
       delivery_address ? JSON.stringify(delivery_address) : null, payment_method||null, prepMin]
    );
    const order = orders[0];

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

    // FOOD-08 (Fase 2): marca mesa como occupied + abre sessão (opened_at) se NULL.
    // B11: cache module-level HAS_OPENED_AT_COL evita try/catch toda request.
    if (table_id) {
      if (HAS_OPENED_AT_COL) {
        try {
          await client.query(
            `UPDATE food_tables
             SET status='occupied',
                 opened_at=COALESCE(opened_at, NOW())
             WHERE id=$1 AND company_id=$2`,
            [table_id, req.params.id]
          );
        } catch (eOpen) {
          if (eOpen.code === '42703') {
            HAS_OPENED_AT_COL = false;
            await client.query(
              `UPDATE food_tables SET status='occupied' WHERE id=$1 AND company_id=$2`,
              [table_id, req.params.id]
            );
          } else { throw eOpen; }
        }
      } else {
        await client.query(
          `UPDATE food_tables SET status='occupied' WHERE id=$1 AND company_id=$2`,
          [table_id, req.params.id]
        );
      }
    }
    await client.query(
      `INSERT INTO food_kds_events (order_id, company_id, to_status) VALUES ($1,$2,'pending')`,
      [order.id, req.params.id]
    );
    await client.query('COMMIT');
    res.status(201).json(order);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[food/order] Erro ao criar pedido:', e.message);
    res.status(500).json({ error: 'Erro ao criar pedido' });
  } finally { client.release(); }
});

// PATCH /:oid/status — KDS + baixa de estoque automática ao entregar
router.patch('/:oid/status', guard, async (req, res) => {
  const { status, note } = req.body;
  const client = await db.connect();
  try {
    const { rows } = await client.query(
      `SELECT fo.*, json_agg(foi.* ORDER BY foi.id) AS items
       FROM food_orders fo
       LEFT JOIN food_order_items foi ON foi.order_id=fo.id
       WHERE fo.id=$1 AND fo.company_id=$2
       GROUP BY fo.id`,
      [req.params.oid, req.params.id]
    );
    if (!rows.length) return notFound(res);

    const order   = rows[0];
    const current = order.status;
    const allowed = ORDER_TRANSITIONS[current] || [];
    if (!allowed.includes(status))
      return res.status(400).json({ error: `Transição inválida: ${current} → ${status}` });

    await client.query('BEGIN');

    const tsMap = { confirmed:'confirmed_at=NOW()', ready:'ready_at=NOW()', delivered:'delivered_at=NOW()' };
    const tsUpdate = tsMap[status] ? `, ${tsMap[status]}` : '';

    const { rows: updated } = await client.query(
      `UPDATE food_orders SET status=$1, updated_at=NOW() ${tsUpdate}
       WHERE id=$2 AND company_id=$3 RETURNING *`,
      [status, req.params.oid, req.params.id]
    );

    await client.query(
      `INSERT INTO food_kds_events (order_id, company_id, from_status, to_status, triggered_by, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.oid, req.params.id, current, status, req.user?.id||null, note||null]
    );

    // Liberar mesa quando todos os pedidos da mesa vão pra delivered/cancelled
    if (['delivered','cancelled'].includes(status) && updated[0].table_id) {
      const { rows: others } = await client.query(
        `SELECT id FROM food_orders
         WHERE table_id=$1 AND status NOT IN ('delivered','cancelled') AND id!=$2`,
        [updated[0].table_id, req.params.oid]
      );
      if (!others.length) {
        // FOOD-08 (Fase 2): libera mesa + fecha sessão (opened_at=NULL).
        // B11: cache HAS_OPENED_AT_COL.
        if (HAS_OPENED_AT_COL) {
          try {
            await client.query(
              `UPDATE food_tables SET status='free', opened_at=NULL WHERE id=$1`,
              [updated[0].table_id]
            );
          } catch (eClose) {
            if (eClose.code === '42703') {
              HAS_OPENED_AT_COL = false;
              await client.query(
                `UPDATE food_tables SET status='free' WHERE id=$1`,
                [updated[0].table_id]
              );
            } else { throw eClose; }
          }
        } else {
          await client.query(
            `UPDATE food_tables SET status='free' WHERE id=$1`,
            [updated[0].table_id]
          );
        }
      }
    }

    // FOOD-04c: Baixa de estoque automática ao entregar
    // B5: SELECT FOR UPDATE no produto para evitar race condition; se produto
    // foi deletado, loga e pula (não falha a entrega).
    if (status === 'delivered' && order.items?.length) {
      for (const orderItem of order.items) {
        if (!orderItem.item_id) continue;
        const { rows: recipes } = await client.query(
          `SELECT fr.product_id, fr.quantity AS unit_qty
           FROM food_recipes fr
           WHERE fr.item_id=$1 AND fr.product_id IS NOT NULL`,
          [orderItem.item_id]
        );
        for (const recipe of recipes) {
          const totalDeduct = recipe.unit_qty * orderItem.quantity;

          // B5 — lock the product row antes do UPDATE.
          const { rows: lockedProducts } = await client.query(
            `SELECT id, stock_quantity FROM products
             WHERE id=$1 AND company_id=$2 FOR UPDATE`,
            [recipe.product_id, req.params.id]
          );
          if (!lockedProducts.length) {
            console.warn(`[food/order/status] Produto ${recipe.product_id} não encontrado/deletado — pulando baixa.`);
            continue;
          }

          await client.query(
            `UPDATE products
             SET stock_quantity = GREATEST(0, stock_quantity - $1),
                 updated_at = NOW()
             WHERE id=$2 AND company_id=$3`,
            [totalDeduct, recipe.product_id, req.params.id]
          );
          await client.query(
            `INSERT INTO stock_movements
               (product_id, company_id, type, quantity, reference_id, reference_type, notes)
             VALUES ($1,$2,'out',$3,$4,'food_order','Baixa automática — pedido entregue')
             ON CONFLICT DO NOTHING`,
            [recipe.product_id, req.params.id, totalDeduct, req.params.oid]
          );
        }
      }
    }

    await client.query('COMMIT');

    // FOOD-04d: WhatsApp
    notifyWhatsApp(updated[0]).catch(() => {});
    if (status === 'delivered') {
      sendReviewLink(updated[0], req.params.id).catch(() => {});
    }

    res.json(updated[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[food/order/status] Erro ao atualizar status:', e.message);
    res.status(500).json({ error: 'Erro ao atualizar status do pedido' });
  } finally { client.release(); }
});

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
  } catch (e) {
    console.error('[food/kds/item] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao atualizar status do item' });
  }
});

router.post('/:oid/notify', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM food_orders WHERE id=$1 AND company_id=$2`,
      [req.params.oid, req.params.id]
    );
    if (!rows.length) return notFound(res);
    const sent = await notifyWhatsApp(rows[0]);
    res.json({ sent, message: buildWhatsAppMsg(rows[0]) });
  } catch (e) {
    console.error('[food/notify] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao enviar notificação' });
  }
});

module.exports = router;
