// ============================================================
// AURA. — Módulo Food Service
// FOOD-03: Pedidos + KDS (controle de produção)
// FOOD-04: Delivery própria + notificação WhatsApp
// FOOD-04c: Baixa de estoque automática ao entregar
// FOOD-04d: Avaliação pós-entrega via WhatsApp
// FOOD-08 (Fase 2): Gerenciar opened_at da mesa (set/clear sessão)
// FOOD-07 (Fase 7): POST /:oid/close-and-emit — fecha mesa, cria sale +
//   sale_payments, opcionalmente emite NFC-e. Idempotente.
// FOOD-08 (Fase 8): KDS retorna address_summary em delivery_proprio (concatenado
//   do delivery_address JSONB) pra mostrar endereco no card. Outras mudancas
//   de Fase 8 (POST /dispatch, middleware PIN no PATCH /status) ficam em
//   foodOrdersDispatch.js, montado ANTES deste em private.js.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');
const { buildWhatsAppMsg, notifyWhatsApp, sendReviewLink } = require('../services/foodOrderNotifications');
const nuvemfiscal = require('../services/nuvemfiscal');

// Nota: requireAuth + requireCompanyAccess já aplicados em private.js
// SEC-02: requirePlan recebe strings separadas, NÃO array
const guard = [requirePlan('negocio', 'expansao')];

// B11 — Cache module-level pro hasOpenedAt (armadilha_schema_pre_migration).
// Optimistic: assume true; vira false na primeira vez que 42703 estourar.
let HAS_OPENED_AT_COL = true;

// FOOD-07 — Cache pra colunas novas da migration 122.
// Optimistic: assume true; vira false em 42703 (coluna inexistente).
// Evita try/catch por request quando a migration ainda não rodou.
let HAS_FOOD_ORDER_SALE_ID_COL = true;
let HAS_SALES_SOURCE_TYPE_COL  = true;
let HAS_NFCE_METADATA_COL      = true;

const notFound = (res, e='Pedido') => res.status(404).json({ error: `${e} não encontrado` });
const ORDER_TRANSITIONS = {
  pending:   ['confirmed','cancelled'],
  confirmed: ['preparing','cancelled'],
  preparing: ['ready'],
  ready:     ['delivered'],
  delivered: [],
  cancelled: []
};

// FOOD-07: mapeia método PDV food → tPag SEFAZ (espelha nfce.js).
// crediario → 01 (dinheiro) segue padrão `nfce_crediario_lanca_dinheiro`.
function foodPaymentToTpag(method) {
  const map = {
    dinheiro: '01', pix: '17',
    cartao_credito: '03', credito: '03', cartao: '03',
    cartao_debito: '04', debito: '04',
    crediario: '01', fiado: '01',
    outros: '99',
  };
  return map[(method || '').toLowerCase()] || '01';
}

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

// FOOD-08 (Fase 8): address_summary computado no SQL pra delivery_proprio.
// Concatena street/number/district/city quando presentes em delivery_address
// JSONB. JSONB ->> retorna NULL se chave ausente; concat_ws ignora NULLs.
router.get('/kds', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT fo.id, fo.status, fo.channel, fo.created_at, fo.notes,
         fo.customer_name, ft.number AS table_number,
         fo.estimated_ready_at,
         fd.name AS deliverer_name,
         EXTRACT(EPOCH FROM (NOW() - fo.confirmed_at))/60 AS waiting_minutes,
         CASE WHEN fo.channel = 'delivery_proprio'
              THEN NULLIF(TRIM(BOTH ', ' FROM concat_ws(', ',
                     concat_ws(' ',
                       NULLIF(fo.delivery_address->>'street', ''),
                       NULLIF(fo.delivery_address->>'number', '')
                     ),
                     NULLIF(fo.delivery_address->>'district', ''),
                     NULLIF(fo.delivery_address->>'city', '')
                   )), '')
              ELSE NULL
         END AS address_summary,
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
// FOOD-08 (Fase 8): foodOrdersDispatch.js (montado ANTES) intercepta esta
// rota quando status='delivered' e valida PIN do entregador antes de seguir.
// Aqui nada mudou.
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

// ============================================================
// FOOD-07 (Fase 7) — POST /:oid/close-and-emit
//
// Fecha o pedido food: cria sale + sale_payments + atualiza food_order.sale_id,
// opcionalmente emite NFC-e. Idempotente — segundo POST retorna 409 com sale_id
// existente.
//
// Decisões base (memory `projeto_aura_food_polish_22mai2026`):
//   1. NFC-e emissão manual via toggle pdv_settings.food_nfce_manual_enabled
//      (cliente pilota quando ligar). Body.emit_nfce override.
//   2. Caixa: cria sale_payments derivado (Opção A — preserva fonte canônica
//      sales.total_amount). source_type='food' permite separar em relatórios.
//   3. Taxa de serviço (gorjeta garçom): NÃO entra no NFC-e nem em
//      sales.total_amount (relatório de venda). Mostrada separada e somada
//      à parte do pagamento — payments cobrem subtotal, taxa é extra.
//   4. Throttle via pg_advisory_xact_lock previne dupla emissão concorrente
//      (segue padrão `caixa_dois_bugs_09mai2026`).
//
// Body:
//   payments: [{ method, amount, tendered? }]   // soma >= subtotal
//   service_fee_pct?: number                    // override do default
//   emit_nfce?: boolean                         // override do settings
//   customer?: { tax_id?, name?, email? }       // pra NFC-e com CPF
//
// Retorno:
//   { sale_id, sale_payments, food_order, nfce, service_fee_amount, total_paid }
//   nfce = null se não solicitado | { emission_id, status, qr_url?, key?, error_message? }
// ============================================================
router.post('/:oid/close-and-emit', guard, async (req, res) => {
  const {
    payments,
    service_fee_pct: bodyFeePct,
    emit_nfce: bodyEmitNfce,
    customer: bodyCustomer,
  } = req.body || {};

  if (!Array.isArray(payments) || payments.length === 0) {
    return res.status(400).json({ error: 'payments[] obrigatório (array com ao menos um pagamento)' });
  }
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i];
    if (!p?.method) return res.status(400).json({ error: `payments[${i}].method obrigatório` });
    const amt = Number(p.amount);
    if (!isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: `payments[${i}].amount inválido (${p.amount})` });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Throttle: previne dupla emissão concorrente do mesmo food_order.
    // hashtext('food-close-' + oid) é determinístico — duas requests
    // concorrentes serializam neste lock.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('food-close-' || $1::text))`,
      [req.params.oid]
    );

    // Carrega pedido + items + company
    const { rows: orderRows } = await client.query(
      `SELECT fo.*, ft.number AS table_number
       FROM food_orders fo
       LEFT JOIN food_tables ft ON ft.id=fo.table_id
       WHERE fo.id=$1 AND fo.company_id=$2 FOR UPDATE`,
      [req.params.oid, req.params.id]
    );
    if (!orderRows.length) {
      await client.query('ROLLBACK');
      return notFound(res);
    }
    const order = orderRows[0];

    // Idempotência: se já tem sale_id, retorna 409 com referência.
    // HAS_FOOD_ORDER_SALE_ID_COL: optimistic — assume true; vira false em 42703.
    let existingSaleId = null;
    if (HAS_FOOD_ORDER_SALE_ID_COL) {
      try {
        existingSaleId = order.sale_id || null;
      } catch (e) {
        if (e?.code === '42703') HAS_FOOD_ORDER_SALE_ID_COL = false;
        else throw e;
      }
    }
    if (existingSaleId) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Pedido já fechado',
        sale_id: existingSaleId,
        food_order_id: order.id,
      });
    }

    // Items reais — recalcula preço pra não confiar em valor congelado.
    const { rows: itemRows } = await client.query(
      `SELECT foi.id, foi.item_id, foi.item_name, foi.variation_name,
              foi.quantity, foi.unit_price, foi.total_price, foi.addons, foi.notes
       FROM food_order_items foi
       WHERE foi.order_id=$1
       ORDER BY foi.id`,
      [req.params.oid]
    );
    if (!itemRows.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Pedido sem itens — não pode fechar' });
    }

    // Recalcula subtotal a partir dos items reais (preço atual dos food_items
    // + price_delta de variation). Se item foi deletado, usa total_price persistido.
    const itemIds = itemRows.map(i => i.item_id).filter(Boolean);
    const dbItemsById = new Map();
    if (itemIds.length) {
      const { rows: dbItems } = await client.query(
        `SELECT id, name, price FROM food_items
         WHERE company_id=$1 AND id = ANY($2::uuid[])`,
        [req.params.id, itemIds]
      );
      for (const it of dbItems) dbItemsById.set(it.id, it);
    }

    let subtotal = 0;
    const enrichedItems = itemRows.map(it => {
      const dbItem = it.item_id ? dbItemsById.get(it.item_id) : null;
      // Pra fechamento, usa o total_price persistido (snapshot do pedido).
      // Re-cálculo só faria sentido pra correção de erros — fora de scope da Fase 7.
      const lineTotal = parseFloat(it.total_price) || 0;
      subtotal += lineTotal;
      return {
        id: it.id,
        item_id: it.item_id,
        item_name: it.item_name || dbItem?.name,
        variation_name: it.variation_name,
        quantity: Number(it.quantity),
        unit_price: parseFloat(it.unit_price) || 0,
        total_price: lineTotal,
        addons: it.addons,
        notes: it.notes,
      };
    });
    subtotal = Math.round(subtotal * 100) / 100;

    // Company + pdv_settings (defensivo)
    const { rows: companies } = await client.query(
      `SELECT id, tax_id, cnpj, trade_name, legal_name, pdv_settings,
              address_street, address_number, address_district,
              address_city, address_state, address_zip
       FROM companies WHERE id=$1`,
      [req.params.id]
    );
    if (!companies.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Empresa não encontrada' });
    }
    const company = companies[0];
    const settings = company.pdv_settings || {};

    // Taxa de serviço (gorjeta) — separada do total fiscal.
    const defaultFeePct = Number(settings?.food_service_fee_pct ?? 0);
    const feePct = bodyFeePct !== undefined ? Number(bodyFeePct) : defaultFeePct;
    const safeFeePct = isFinite(feePct) && feePct >= 0 && feePct <= 30 ? feePct : 0;
    const serviceFeeAmount = Math.round(subtotal * (safeFeePct / 100) * 100) / 100;
    const totalDue = Math.round((subtotal + serviceFeeAmount) * 100) / 100;

    // Soma dos pagamentos deve cobrir subtotal + service_fee_amount (gorjeta).
    // (Cliente que opta pagar a gorjeta paga o total cheio; sem gorjeta,
    // só paga subtotal.) A taxa de serviço NÃO entra no NFC-e.
    let sumPaid = 0;
    for (const p of payments) sumPaid += Number(p.amount);
    sumPaid = Math.round(sumPaid * 100) / 100;
    if (sumPaid + 0.005 < totalDue) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Soma dos pagamentos (R$ ${sumPaid.toFixed(2)}) menor que total devido (R$ ${totalDue.toFixed(2)})`,
        subtotal, service_fee_amount: serviceFeeAmount, total_due: totalDue,
      });
    }

    // Cria sale — total_amount = subtotal (sem service_fee, pra não inflar
    // relatórios de venda. Gorjeta vai pro garçom, não pra receita).
    // source_type='food' permite filtros (gracioso se coluna não existe).
    const customerName  = bodyCustomer?.name  || order.customer_name || null;
    const customerPhone = order.customer_phone || null;
    const customerTaxId = bodyCustomer?.tax_id ? String(bodyCustomer.tax_id).replace(/\D/g,'') : null;
    const customerEmail = bodyCustomer?.email || null;

    let saleInsertSql = `
      INSERT INTO sales
        (company_id, total_amount, status, payment_method,
         customer_name, customer_phone, customer_tax_id, customer_email,
         notes, created_at`;
    const saleInsertVals = [
      req.params.id, subtotal, 'completed',
      payments[0]?.method || null,
      customerName, customerPhone, customerTaxId, customerEmail,
      `Pedido food #${order.id.slice(-6).toUpperCase()} | Mesa ${order.table_number || '—'}`,
    ];
    let saleSql, saleParams;
    if (HAS_SALES_SOURCE_TYPE_COL) {
      saleSql = saleInsertSql + `, source_type)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW(), $10)
                 RETURNING *`;
      saleParams = [...saleInsertVals, 'food'];
    } else {
      saleSql = saleInsertSql + `)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
                 RETURNING *`;
      saleParams = saleInsertVals;
    }

    let saleRow;
    try {
      const { rows } = await client.query(saleSql, saleParams);
      saleRow = rows[0];
    } catch (e) {
      // 42703 = undefined column. Provável: source_type ainda não migrado.
      if (e?.code === '42703' && HAS_SALES_SOURCE_TYPE_COL) {
        HAS_SALES_SOURCE_TYPE_COL = false;
        const { rows } = await client.query(
          saleInsertSql + `)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
           RETURNING *`,
          saleInsertVals
        );
        saleRow = rows[0];
      } else {
        throw e;
      }
    }

    // Cria sale_payments (um por método). Cuidado: caixa soma sale_payments
    // diretamente (memory caixa_dois_bugs_09mai2026 + caixa_cancel_deleta_payments)
    // — então NÃO criar duplicado pra mesmo sale_id.
    const salePayments = [];
    for (const p of payments) {
      const amt = Math.round(Number(p.amount) * 100) / 100;
      const tendered = p.tendered !== undefined ? Math.round(Number(p.tendered) * 100) / 100 : null;
      const { rows: spRows } = await client.query(
        `INSERT INTO sale_payments
           (sale_id, company_id, method, amount, created_at)
         VALUES ($1,$2,$3,$4, NOW())
         RETURNING *`,
        [saleRow.id, req.params.id, p.method, amt]
      );
      salePayments.push({ ...spRows[0], tendered });
    }

    // Linka food_order → sale (idempotente: WHERE sale_id IS NULL).
    // Se a coluna não existe ainda (migration não aplicada), pula com warn.
    if (HAS_FOOD_ORDER_SALE_ID_COL) {
      try {
        await client.query(
          `UPDATE food_orders
              SET sale_id=$1, updated_at=NOW()
            WHERE id=$2 AND company_id=$3 AND sale_id IS NULL`,
          [saleRow.id, req.params.oid, req.params.id]
        );
      } catch (eLink) {
        if (eLink.code === '42703') {
          HAS_FOOD_ORDER_SALE_ID_COL = false;
          console.warn('[food/close-and-emit] food_orders.sale_id ainda não migrado — pulando link');
        } else {
          throw eLink;
        }
      }
    }

    // Decisão emit_nfce
    const settingsEmitDefault = !!settings?.food_nfce_manual_enabled;
    const shouldEmit = bodyEmitNfce !== undefined ? !!bodyEmitNfce : settingsEmitDefault;

    let nfceResult = null;

    if (shouldEmit) {
      // Antes do commit: NFC-e é best-effort. Se SEFAZ falhar, sale fica
      // criada (status='completed') e retornamos 200 com nfce.status='failed'.
      // Cliente pode reemitir via /companies/:id/nfce/emit depois.
      //
      // Estratégia: cria registro em nfce_emissions com status='processando',
      // chama nuvemfiscal.emitNfce, atualiza status. Replica o happy path
      // do /companies/:id/nfce/emit em nfce.js mas focado em food.
      try {
        // Busca config NFC-e
        const { rows: configs } = await client.query(
          'SELECT * FROM nfce_config WHERE company_id=$1',
          [req.params.id]
        );

        if (!configs.length || !configs[0].is_active) {
          nfceResult = {
            status: 'failed',
            error_message: 'NFC-e não configurada (Configurações > Nota Fiscal). Mesa fechada sem nota fiscal.',
          };
        } else {
          const config = configs[0];

          // Numeração + chave provisória (mesma lógica do /nfce/emit)
          const numeroNF = config.next_number;
          const serieNF  = config.serie_nfce;
          const cUF = String(nuvemfiscal.ufToCodigo(config.uf || company.address_state)).padStart(2, '0');
          const now = new Date();
          const yy = String(now.getFullYear()).slice(2);
          const mm = String(now.getMonth() + 1).padStart(2, '0');
          const modelo = '65';
          const chaveAcessoTmp =
            `${cUF}${yy}${mm}${'0'.repeat(14)}${modelo}${String(serieNF).padStart(3, '0')}` +
            `${String(numeroNF).padStart(9, '0')}1${'0'.repeat(8)}1`;

          // Items pra Nuvem Fiscal — sem NCM próprio (food_items não tem ncm
          // cadastrado ainda). Mantém '00000000' que a SEFAZ rejeita em prod;
          // homologação aceita. Sucessor (Fase 8) adiciona food_items.ncm.
          const nfItems = enrichedItems.map(it => ({
            code:        it.item_id || `FOOD-${it.id}`,
            name:        it.item_name + (it.variation_name ? ` (${it.variation_name})` : ''),
            description: it.item_name + (it.variation_name ? ` (${it.variation_name})` : ''),
            ncm:         '21069090',  // NCM genérico de alimento preparado (cliente customiza por food_item depois)
            cfop:        '5102',
            unit:        'UN',
            quantity:    it.quantity,
            price:       it.unit_price,
          }));

          // Payments pra Nuvem Fiscal — soma deve bater com subtotal (NÃO totalDue;
          // taxa de serviço fora do NFC-e). Se sum(payments) > subtotal (caso onde
          // cliente pagou subtotal + gorjeta), proporciona pagamento de subtotal só.
          const nfPayments = [];
          let remainingForNfce = subtotal;
          for (const p of payments) {
            if (remainingForNfce <= 0) break;
            const amtForNfce = Math.min(Number(p.amount), remainingForNfce);
            nfPayments.push({
              method: foodPaymentToTpag(p.method),
              value: Math.round(amtForNfce * 100) / 100,
            });
            remainingForNfce -= amtForNfce;
          }
          // Ajuste de centavo final
          if (Math.abs(remainingForNfce) > 0.005 && nfPayments.length) {
            nfPayments[nfPayments.length - 1].value += remainingForNfce;
            nfPayments[nfPayments.length - 1].value = Math.round(nfPayments[nfPayments.length - 1].value * 100) / 100;
          }

          // Insere nfce_emissions com metadata.food_order_id (defensivo)
          let emissionRow;
          const baseInsertCols = `
            (company_id, sale_id, numero, serie, chave_acesso, status,
             customer_cpf, customer_name, items, total_products, total_discount, total_nfce,
             payment_method, payment_change, emitted_by, tipo`;
          const baseInsertVals = `
            ($1,$2,$3,$4,$5,'processando',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15`;
          const baseInsertParams = [
            req.params.id, saleRow.id, numeroNF, serieNF, chaveAcessoTmp,
            customerTaxId, customerName, JSON.stringify(enrichedItems),
            subtotal, 0, subtotal,
            JSON.stringify(nfPayments), 0,
            req.user?.id || null, 'nfce',
          ];
          if (HAS_NFCE_METADATA_COL) {
            try {
              const { rows: emRows } = await client.query(
                baseInsertCols + `, metadata) ` +
                `VALUES ` + baseInsertVals + `, $16::jsonb) ` +
                `RETURNING *`,
                [...baseInsertParams, JSON.stringify({ food_order_id: req.params.oid, source: 'food' })]
              );
              emissionRow = emRows[0];
            } catch (eIns) {
              if (eIns.code === '42703') {
                HAS_NFCE_METADATA_COL = false;
                const { rows: emRows } = await client.query(
                  baseInsertCols + `) VALUES ` + baseInsertVals + `) RETURNING *`,
                  baseInsertParams
                );
                emissionRow = emRows[0];
              } else {
                throw eIns;
              }
            }
          } else {
            const { rows: emRows } = await client.query(
              baseInsertCols + `) VALUES ` + baseInsertVals + `) RETURNING *`,
              baseInsertParams
            );
            emissionRow = emRows[0];
          }

          // Chama Nuvem Fiscal (ou stub em homologação)
          if (config.ambiente === 'homologacao' && process.env.NUVEM_FISCAL_FORCE !== 'true') {
            const protocolo = 'HOMOLOG-' + String(numeroNF).padStart(6, '0');
            await client.query(
              `UPDATE nfce_emissions SET status='autorizada', protocolo=$1, authorized_at=NOW() WHERE id=$2`,
              [protocolo, emissionRow.id]
            );
            await client.query(
              `UPDATE nfce_config SET next_number=next_number+1, updated_at=NOW() WHERE company_id=$1`,
              [req.params.id]
            );
            nfceResult = {
              status: 'autorizada',
              emission_id: emissionRow.id,
              protocolo,
              key: chaveAcessoTmp,
              homologacao: true,
            };
          } else {
            // Produção real — best-effort dentro do BEGIN.
            // Se erro, sale fica criada (sem rollback global), nfce_emissions
            // fica como 'erro' e retornamos nfce.status='failed'.
            try {
              const provResult = await nuvemfiscal.emitNfce(
                { ...company, cnpj: company.tax_id || company.cnpj,
                  legal_name: company.legal_name, trade_name: company.trade_name,
                  address_street: company.address_street, address_number: company.address_number,
                  address_neighborhood: company.address_district,
                  address_city: company.address_city, address_state: company.address_state,
                  address_zip: company.address_zip,
                  inscricao_estadual: config.inscricao_estadual },
                {
                  items: nfItems,
                  total_value: subtotal,
                  payments: nfPayments,
                  recipient_cpf: customerTaxId,
                  recipient_name: customerName,
                  recipient_email: customerEmail,
                  serie: serieNF,
                  numero: numeroNF,
                  observacoes: `Pedido food #${order.id.slice(-6).toUpperCase()} | Mesa ${order.table_number || '—'}`,
                  reference: `nfce-food-${emissionRow.id}`,
                }
              );

              const provStatus = provResult?.status === 'autorizado' || provResult?.status === 'autorizada'
                ? 'autorizada'
                : 'processando';
              const provChave = provResult?.chave || provResult?.chave_acesso || chaveAcessoTmp;
              const provId = provResult?.id || null;

              await client.query(
                `UPDATE nfce_emissions
                    SET status=$1, nuvemfiscal_id=$2,
                        chave_acesso=COALESCE($3, chave_acesso),
                        authorized_at=$4
                  WHERE id=$5`,
                [provStatus, provId, provChave,
                 provStatus === 'autorizada' ? new Date() : null,
                 emissionRow.id]
              );

              if (provStatus !== 'rejeitada') {
                await client.query(
                  `UPDATE nfce_config SET next_number=next_number+1, updated_at=NOW() WHERE company_id=$1`,
                  [req.params.id]
                );
              }

              nfceResult = {
                status: provStatus,
                emission_id: emissionRow.id,
                nuvemfiscal_id: provId,
                key: provChave,
              };
            } catch (sefazErr) {
              console.error('[food/close-and-emit] Nuvem Fiscal emit error:', sefazErr.message);
              await client.query(
                `UPDATE nfce_emissions SET status='erro', error_message=$1 WHERE id=$2`,
                [String(sefazErr.message).slice(0, 5000), emissionRow.id]
              );
              nfceResult = {
                status: 'failed',
                emission_id: emissionRow.id,
                error_message: sefazErr.message,
              };
              // NÃO rolla back — sale e sale_payments continuam válidos.
              // Cliente decide se reemite via /nfce/emit ou cancela manual.
            }
          }
        }
      } catch (nfErr) {
        console.error('[food/close-and-emit] Erro inesperado NFC-e:', nfErr.message);
        nfceResult = { status: 'failed', error_message: nfErr.message };
      }
    }

    await client.query('COMMIT');

    res.json({
      sale_id: saleRow.id,
      food_order_id: order.id,
      sale_payments: salePayments,
      total_paid: sumPaid,
      subtotal,
      service_fee_amount: serviceFeeAmount,
      service_fee_pct: safeFeePct,
      total_due: totalDue,
      nfce: nfceResult,
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[food/close-and-emit] Erro:', e.message);
    res.status(500).json({ error: 'Erro ao fechar pedido', detail: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
