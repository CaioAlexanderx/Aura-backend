// ============================================================
// AURA Studio · Rotas F6 (Bulk Events) + F7 (Hub)
// Mount em private.js no mesmo prefixo /studio.
// Migration 133 (25/05/2026).
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');

// ─── Desconto por quantidade ─────────────────────────────────
// A tabela saiu daqui em 03/09/2026 (S0 da vitrine Studio): a loja
// publica passou a cotar lote tambem, e escada de preco com duas
// implementacoes e a conta do cliente divergindo da conta da lojista.
// Uma regra, dois leitores — ver services/studioLote.js.
const { cotarLote } = require('../services/studioLote');

/**
 * A escada da LOJISTA para um produto: a regra dele, ou a global da loja.
 *
 * 04/09/2026 — o lote lia uma tabela fixa nossa; a pagina do produto lia
 * a dela. Uma escada so, e ela e a que a lojista configurou. Sem regra,
 * `null`: cotarLote entende como "sem desconto".
 */
async function faixasDaLojista(cid, productId) {
  try {
    const { rows } = await db.query(
      `SELECT product_id, qty_tiers FROM studio_pricing_rules
        WHERE company_id = $1 AND is_active IS NOT FALSE AND qty_tiers IS NOT NULL
          AND (product_id = $2 OR product_id IS NULL)`,
      [cid, productId || null]
    );
    const propria = productId ? rows.find((r) => r.product_id === productId) : null;
    const global = rows.find((r) => r.product_id == null);
    return (propria || global || {}).qty_tiers ?? null;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════
// F6 — Bulk Events
// ═══════════════════════════════════════════════════════════

// GET /studio/bulk-events — lista eventos
router.get('/bulk-events', async function(req, res) {
  const { status, limit = 100 } = req.query;
  const params = [req.params.id];
  let where = 'company_id = $1';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  try {
    const r = await db.query(
      `SELECT id, event_name, event_date, customer_name, customer_phone,
              product_name_snapshot, total_qty, total_amount, discount_pct,
              delivery_deadline, status, created_at
         FROM studio_bulk_events
        WHERE ${where}
        ORDER BY COALESCE(event_date, delivery_deadline, created_at::date) DESC
        LIMIT $${params.length + 1}`,
      [...params, Math.min(parseInt(limit) || 100, 300)]
    );
    res.json({ events: r.rows });
  } catch (err) {
    console.error('[studio/bulk-events:GET]', err.message);
    res.status(500).json({ error: 'Erro ao listar eventos' });
  }
});

// GET /studio/bulk-events/:eid — detalhe + items
router.get('/bulk-events/:eid', async function(req, res) {
  try {
    const eventRes = await db.query(
      `SELECT e.*, p.name AS product_current_name, p.price AS product_current_price
         FROM studio_bulk_events e
         LEFT JOIN products p ON p.id = e.product_id
        WHERE e.id = $1 AND e.company_id = $2 LIMIT 1`,
      [req.params.eid, req.params.id]
    );
    if (!eventRes.rows.length) return res.status(404).json({ error: 'Evento não encontrado' });

    const itemsRes = await db.query(
      `SELECT id, line_number, recipient_name, customization, notes
         FROM studio_bulk_event_items
        WHERE event_id = $1 ORDER BY line_number`,
      [req.params.eid]
    );

    res.json({ event: eventRes.rows[0], items: itemsRes.rows });
  } catch (err) {
    console.error('[studio/bulk-events/:eid]', err.message);
    res.status(500).json({ error: 'Erro ao buscar evento' });
  }
});

// POST /studio/bulk-events — cria evento + items em transação
// body: { event_name, event_date?, customer_name?, customer_phone?, customer_email?,
//         product_id, base_unit_price, delivery_deadline?, notes?,
//         items: [{ recipient_name?, customization?, notes? }] }
router.post('/bulk-events', async function(req, res) {
  const {
    event_name, event_date, customer_name, customer_phone, customer_email,
    product_id, base_unit_price, delivery_deadline, notes, items, status,
  } = req.body;
  if (!event_name || !String(event_name).trim()) return res.status(400).json({ error: 'event_name obrigatório' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items obrigatórios (pelo menos 1)' });
  if (items.length > 1000) return res.status(400).json({ error: 'máximo 1000 items por evento' });

  // Captura snapshot do nome do produto (defensivo)
  let productNameSnapshot = null;
  if (product_id) {
    const pRes = await db.query(`SELECT name FROM products WHERE id = $1 AND company_id = $2`, [product_id, req.params.id]);
    if (!pRes.rows.length) return res.status(404).json({ error: 'Produto não encontrado' });
    productNameSnapshot = pRes.rows[0].name;
  }

  const totalQty       = items.length;
  const basePrice      = parseFloat(base_unit_price) || 0;
  // A MESMA conta da loja publica, com a MESMA escada — a da lojista.
  const cot            = cotarLote(totalQty, basePrice, await faixasDaLojista(req.params.id, product_id));
  const discountPct    = cot.discount_pct;
  const totalAmount    = cot.total_amount;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const eventRes = await client.query(
      `INSERT INTO studio_bulk_events
         (company_id, event_name, event_date, customer_name, customer_phone, customer_email,
          product_id, product_name_snapshot, base_unit_price, total_qty, total_amount,
          discount_pct, delivery_deadline, notes, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [req.params.id, String(event_name).trim(),
       event_date || null, customer_name || null, customer_phone || null, customer_email || null,
       product_id || null, productNameSnapshot, basePrice, totalQty, totalAmount,
       discountPct, delivery_deadline || null, notes || null,
       (status === 'confirmed' ? 'confirmed' : 'draft'), req.user?.id || null]
    );
    const event = eventRes.rows[0];

    // Insere items em chunks (até 100 por insert pra perf razoável)
    const CHUNK = 100;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const placeholders = [];
      const params2 = [event.id];
      let pIdx = 2;
      chunk.forEach((it, idx) => {
        placeholders.push(`($1, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
        params2.push(i + idx + 1, it.recipient_name || null,
                     it.customization ? JSON.stringify(it.customization) : null,
                     it.notes || null);
      });
      await client.query(
        `INSERT INTO studio_bulk_event_items (event_id, line_number, recipient_name, customization, notes)
         VALUES ${placeholders.join(', ')}`,
        params2
      );
    }

    await client.query('COMMIT');
    res.status(201).json({
      event,
      item_count: items.length,
      pricing: { base_unit_price: basePrice, discount_pct: discountPct, total_amount: totalAmount },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[studio/bulk-events:POST]', err.message);
    res.status(500).json({ error: 'Erro ao criar evento' });
  } finally { client.release(); }
});

// PATCH /studio/bulk-events/:eid — atualiza metadados (não items)
router.patch('/bulk-events/:eid', async function(req, res) {
  const fields = ['event_name', 'event_date', 'customer_name', 'customer_phone', 'customer_email',
                  'delivery_deadline', 'notes', 'status'];
  const upd = [], vals = [];
  let idx = 1;
  for (const f of fields) {
    if (req.body[f] !== undefined) { upd.push(`${f} = $${idx++}`); vals.push(req.body[f]); }
  }
  if (!upd.length) return res.status(400).json({ error: 'nada pra atualizar' });
  upd.push('updated_at = NOW()');
  vals.push(req.params.eid, req.params.id);
  try {
    const r = await db.query(
      `UPDATE studio_bulk_events SET ${upd.join(', ')}
        WHERE id = $${idx++} AND company_id = $${idx} RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Evento não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar evento' }); }
});

// DELETE /studio/bulk-events/:eid — soft delete (vira cancelled)
router.delete('/bulk-events/:eid', async function(req, res) {
  try {
    const r = await db.query(
      `UPDATE studio_bulk_events SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND status != 'delivered'
        RETURNING id`,
      [req.params.eid, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Evento não encontrado ou já entregue' });
    res.json({ cancelled: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao cancelar evento' }); }
});

// GET /studio/bulk-events/pricing/preview?qty=X&unit_price=Y&product_id=Z
// Calcula preço escalonado sem persistir
router.get('/bulk-events/pricing/preview', async function(req, res) {
  // A mesma conta que a loja publica faz em /storefront/:slug/studio/bulk-quote,
  // com a escada da lojista. Sem product_id cai na regra global da loja.
  try {
    const faixas = await faixasDaLojista(req.params.id, req.query.product_id || null);
    res.json(cotarLote(req.query.qty, req.query.unit_price, faixas));
  } catch (err) {
    console.error('[studio/bulk-events/preview]', err.message);
    res.status(500).json({ error: 'Erro ao calcular o lote' });
  }
});

// ═══════════════════════════════════════════════════════════
// F7 — Hub Studio (visão unificada)
// ═══════════════════════════════════════════════════════════

// GET /studio/hub/stats — KPIs agregados (view materializada-like)
router.get('/hub/stats', async function(req, res) {
  try {
    const kpiRes = await db.query(
      `SELECT * FROM studio_hub_kpis WHERE company_id = $1 LIMIT 1`,
      [req.params.id]
    );
    const bulkRes = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('draft','confirmed','in_production')) AS active_count,
         COUNT(*) FILTER (WHERE delivery_deadline IS NOT NULL
                          AND delivery_deadline < CURRENT_DATE + INTERVAL '7 days'
                          AND status IN ('confirmed','in_production')) AS deadline_7d
         FROM studio_bulk_events WHERE company_id = $1`,
      [req.params.id]
    );
    const inputsRes = await db.query(
      `SELECT COUNT(*) AS low_stock_count
         FROM studio_inputs
        WHERE company_id = $1 AND is_active = true
          AND stock_min IS NOT NULL AND stock_qty < stock_min`,
      [req.params.id]
    );

    const kpis = kpiRes.rows[0] || {};
    res.json({
      orders: {
        pending_art:    parseInt(kpis.pending_art_count)    || 0,
        approved:       parseInt(kpis.approved_count)       || 0,
        in_production:  parseInt(kpis.in_production_count)  || 0,
        ready:          parseInt(kpis.ready_count)          || 0,
        delivered_7d:   parseInt(kpis.delivered_7d)         || 0,
        overdue:        parseInt(kpis.overdue_count)        || 0,
        orders_today:   parseInt(kpis.orders_today)         || 0,
        orders_7d:      parseInt(kpis.orders_7d)            || 0,
        total:          parseInt(kpis.total_orders)         || 0,
      },
      revenue: {
        today: parseFloat(kpis.revenue_today) || 0,
        last_7d: parseFloat(kpis.revenue_7d)  || 0,
      },
      bulk: {
        active:      parseInt(bulkRes.rows[0].active_count)  || 0,
        deadline_7d: parseInt(bulkRes.rows[0].deadline_7d)   || 0,
      },
      inputs: {
        low_stock_count: parseInt(inputsRes.rows[0].low_stock_count) || 0,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[studio/hub/stats]', err.message);
    res.status(500).json({ error: 'Erro ao buscar KPIs' });
  }
});

// GET /studio/hub/orders — lista unificada (digital_orders + bulk_events em um único feed)
// query: ?source=all|orders|bulk (default all), limit
router.get('/hub/orders', async function(req, res) {
  const { source = 'all', limit = 100 } = req.query;
  const lim = Math.min(parseInt(limit) || 100, 300);

  try {
    const items = [];

    if (source === 'all' || source === 'orders') {
      const r = await db.query(
        `SELECT o.id, 'order'::text AS kind, o.created_at, o.total AS amount,
                o.studio_production_status AS status,
                o.customer_name AS name,
                (SELECT COUNT(*) FROM digital_order_items oi WHERE oi.order_id = o.id) AS qty
           FROM digital_orders o
          WHERE o.company_id = $1 AND o.vertical = 'studio'
          ORDER BY o.created_at DESC
          LIMIT $2`,
        [req.params.id, lim]
      );
      items.push(...r.rows);
    }

    if (source === 'all' || source === 'bulk') {
      const r = await db.query(
        `SELECT id, 'bulk'::text AS kind, created_at, total_amount AS amount,
                status, event_name AS name, total_qty AS qty
           FROM studio_bulk_events
          WHERE company_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [req.params.id, lim]
      );
      items.push(...r.rows);
    }

    // ordenar todos por created_at desc
    items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ items: items.slice(0, lim) });
  } catch (err) {
    console.error('[studio/hub/orders]', err.message);
    res.status(500).json({ error: 'Erro ao listar feed do hub' });
  }
});

// GET /studio/hub/alerts — alertas acionáveis (priorizados)
router.get('/hub/alerts', async function(req, res) {
  try {
    const alerts = [];

    // 1. Insumos críticos
    const lowStockRes = await db.query(
      `SELECT name, stock_qty, stock_min, unit FROM studio_inputs
        WHERE company_id = $1 AND is_active = true
          AND stock_min IS NOT NULL AND stock_qty < stock_min
        ORDER BY (stock_qty / NULLIF(stock_min, 0)) NULLS LAST
        LIMIT 5`,
      [req.params.id]
    );
    for (const r of lowStockRes.rows) {
      alerts.push({
        severity: 'warning',
        kind: 'low_stock',
        title: `${r.name} abaixo do estoque mínimo`,
        sub: `Resta ${r.stock_qty} ${r.unit} (mínimo ${r.stock_min})`,
        href: '/studio/insumos',
      });
    }

    // 2. Pedidos atrasados (>3d sem ir pra ready)
    const overdueRes = await db.query(
      `SELECT id, customer_name, created_at
         FROM digital_orders
        WHERE company_id = $1 AND vertical = 'studio'
          AND studio_production_status NOT IN ('delivered','ready','cancelled')
          AND created_at < NOW() - INTERVAL '3 days'
        ORDER BY created_at
        LIMIT 5`,
      [req.params.id]
    );
    for (const r of overdueRes.rows) {
      alerts.push({
        severity: 'danger',
        kind: 'overdue',
        title: `Pedido #${r.id.slice(0, 8).toUpperCase()} atrasado`,
        sub: `${r.customer_name || 'Sem cadastro'} · há ${Math.round((Date.now() - new Date(r.created_at).getTime()) / 86400000)} dias`,
        href: '/studio/producao',
      });
    }

    // 3. Aprovações pendentes >24h
    const approvalRes = await db.query(
      `SELECT a.id, a.created_at, o.customer_name
         FROM studio_approval_links a
         JOIN digital_orders o ON o.id = a.order_id
        WHERE a.company_id = $1 AND a.status = 'pending'
          AND a.created_at < NOW() - INTERVAL '24 hours'
          AND a.expires_at > NOW()
        ORDER BY a.created_at
        LIMIT 5`,
      [req.params.id]
    );
    for (const r of approvalRes.rows) {
      alerts.push({
        severity: 'info',
        kind: 'pending_approval',
        title: `Aprovação pendente há ${Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600000)}h`,
        sub: `${r.customer_name || 'Cliente'} ainda não respondeu — envie lembrete`,
        href: '/studio/producao',
      });
    }

    // 4. Eventos com deadline próximo
    const eventRes = await db.query(
      `SELECT id, event_name, delivery_deadline
         FROM studio_bulk_events
        WHERE company_id = $1
          AND status IN ('confirmed', 'in_production')
          AND delivery_deadline IS NOT NULL
          AND delivery_deadline < CURRENT_DATE + INTERVAL '5 days'
        ORDER BY delivery_deadline
        LIMIT 5`,
      [req.params.id]
    );
    for (const r of eventRes.rows) {
      const daysLeft = Math.ceil((new Date(r.delivery_deadline).getTime() - Date.now()) / 86400000);
      alerts.push({
        severity: daysLeft <= 1 ? 'danger' : 'warning',
        kind: 'event_deadline',
        title: `Evento "${r.event_name}" — entrega em ${daysLeft} dia${daysLeft === 1 ? '' : 's'}`,
        sub: `Deadline: ${r.delivery_deadline}`,
        href: '/studio/pedidos?tab=bulk',
      });
    }

    res.json({ alerts, count: alerts.length });
  } catch (err) {
    console.error('[studio/hub/alerts]', err.message);
    res.status(500).json({ error: 'Erro ao listar alertas' });
  }
});

module.exports = router;
