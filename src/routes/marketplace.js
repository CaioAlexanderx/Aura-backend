// ============================================================
// AURA. — MKT-03: Marketplace Integrations
// Connections, order sync, product mapping
// Mounted at: /companies/:id/marketplaces
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');

const PLATFORMS = {
  mercado_livre: { name: 'Mercado Livre', color: '#FFE600', fee_pct: 16 },
  shopee:        { name: 'Shopee', color: '#EE4D2D', fee_pct: 18 },
  amazon:        { name: 'Amazon', color: '#FF9900', fee_pct: 15 },
  magalu:        { name: 'Magazine Luiza', color: '#0086FF', fee_pct: 16 },
  americanas:    { name: 'Americanas', color: '#EE1233', fee_pct: 16 },
  shein:         { name: 'Shein', color: '#000000', fee_pct: 20 },
};

// ===== CONNECTIONS =====

router.get('/connections', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT mc.*,
              (SELECT COUNT(*)::int FROM marketplace_orders mo WHERE mo.connection_id=mc.id) AS total_orders,
              (SELECT COUNT(*)::int FROM marketplace_product_map pm WHERE pm.connection_id=mc.id) AS mapped_products
       FROM marketplace_connections mc
       WHERE mc.company_id=$1 ORDER BY mc.created_at`, [req.params.id]
    );
    res.json({ total: rows.length, connections: rows, available_platforms: PLATFORMS });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar conexoes' }); }
});

router.post('/connections', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { platform, store_name, store_id, access_token } = req.body;
  if (!platform || !PLATFORMS[platform]) return res.status(400).json({ error: 'Plataforma invalida. Opcoes: ' + Object.keys(PLATFORMS).join(', ') });
  try {
    const { rows } = await db.query(
      `INSERT INTO marketplace_connections (company_id, platform, store_name, store_id, access_token, status)
       VALUES ($1,$2,$3,$4,$5,'ativo') RETURNING *`,
      [req.params.id, platform, store_name||null, store_id||null, access_token||null]
    );
    logAuditAction(req.user.id, req.params.id, 'marketplace_connected', `Connected to ${PLATFORMS[platform].name}`);
    res.status(201).json({ connection: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao conectar marketplace' }); }
});

router.patch('/connections/:connId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const allowed = ['store_name', 'status', 'sync_products', 'sync_orders', 'sync_stock', 'access_token'];
  const fields = [], values = []; let idx = 1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key}=$${idx++}`); values.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo' });
  fields.push('updated_at=NOW()'); values.push(req.params.connId, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE marketplace_connections SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Conexao nao encontrada' });
    res.json({ connection: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar conexao' }); }
});

// ===== ORDERS =====

router.get('/orders', requireAuth, async (req, res) => {
  const { platform, status, start, end } = req.query;
  try {
    const params = [req.params.id];
    let where = 'WHERE mo.company_id=$1';
    if (platform) { params.push(platform); where += ` AND mo.platform=$${params.length}`; }
    if (status) { params.push(status); where += ` AND mo.status=$${params.length}`; }
    if (start) { params.push(start); where += ` AND mo.created_at>=$${params.length}`; }
    if (end) { params.push(end); where += ` AND mo.created_at<=$${params.length}`; }

    const { rows } = await db.query(
      `SELECT mo.*, mc.store_name
       FROM marketplace_orders mo
       JOIN marketplace_connections mc ON mc.id=mo.connection_id
       ${where} ORDER BY mo.created_at DESC LIMIT 100`, params
    );

    // Stats per platform
    const { rows: stats } = await db.query(
      `SELECT platform,
              COUNT(*)::int AS total_orders,
              COUNT(*) FILTER (WHERE status='entregue')::int AS delivered,
              COUNT(*) FILTER (WHERE status IN ('novo','pago','separando','enviado'))::int AS active,
              COALESCE(SUM(total),0)::numeric AS gmv,
              COALESCE(SUM(net_revenue),0)::numeric AS net_revenue,
              COALESCE(SUM(marketplace_fee),0)::numeric AS total_fees
       FROM marketplace_orders WHERE company_id=$1 GROUP BY platform`, [req.params.id]
    );

    res.json({ total: rows.length, orders: rows, stats });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar pedidos' }); }
});

// Import orders (webhook or manual sync)
router.post('/orders/import', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { connection_id, orders } = req.body;
  if (!connection_id || !orders?.length) return res.status(400).json({ error: 'connection_id e orders obrigatorios' });

  try {
    const { rows: conns } = await db.query(
      'SELECT platform FROM marketplace_connections WHERE id=$1 AND company_id=$2', [connection_id, req.params.id]
    );
    if (!conns.length) return res.status(404).json({ error: 'Conexao nao encontrada' });
    const platform = conns[0].platform;
    const feePct = PLATFORMS[platform]?.fee_pct || 15;

    let imported = 0, duplicates = 0;
    for (const order of orders) {
      const total = parseFloat(order.total || 0);
      const shippingCost = parseFloat(order.shipping_cost || 0);
      const fee = Math.round(total * feePct) / 100;
      const netRevenue = Math.round((total - fee - shippingCost) * 100) / 100;

      try {
        await db.query(
          `INSERT INTO marketplace_orders
             (company_id, connection_id, platform, external_id, status, customer_name, customer_doc,
              shipping_address, items, subtotal, shipping_cost, marketplace_fee, total, net_revenue,
              payment_method, tracking_code, external_data)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [req.params.id, connection_id, platform, order.external_id, order.status||'novo',
           order.customer_name||null, order.customer_doc||null,
           order.shipping_address ? JSON.stringify(order.shipping_address) : null,
           JSON.stringify(order.items||[]), order.subtotal||total,
           shippingCost, fee, total, netRevenue,
           order.payment_method||null, order.tracking_code||null,
           order.external_data ? JSON.stringify(order.external_data) : '{}']
        );
        imported++;
      } catch (err) {
        if (err.code === '23505') duplicates++;
        else throw err;
      }
    }

    await db.query('UPDATE marketplace_connections SET last_sync=NOW() WHERE id=$1', [connection_id]);
    logAuditAction(req.user.id, req.params.id, 'marketplace_import', `${platform}: ${imported} orders imported, ${duplicates} duplicates`);
    res.status(201).json({ imported, duplicates });
  } catch (err) {
    console.error('marketplace import error:', err);
    res.status(500).json({ error: 'Erro ao importar pedidos' });
  }
});

router.patch('/orders/:orderId', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { status, tracking_code, nfce_id } = req.body;
  const fields = [], values = []; let idx = 1;
  if (status) {
    fields.push(`status=$${idx++}`); values.push(status);
    const tsMap = { pago: 'paid_at', enviado: 'shipped_at', entregue: 'delivered_at', cancelado: 'cancelled_at' };
    if (tsMap[status]) fields.push(`${tsMap[status]}=NOW()`);
  }
  if (tracking_code) { fields.push(`tracking_code=$${idx++}`); values.push(tracking_code); }
  if (nfce_id) { fields.push(`nfce_id=$${idx++}`); values.push(nfce_id); }
  if (!fields.length) return res.status(400).json({ error: 'Nenhum campo' });
  fields.push('updated_at=NOW()'); values.push(req.params.orderId, req.params.id);
  try {
    const { rows } = await db.query(
      `UPDATE marketplace_orders SET ${fields.join(',')} WHERE id=$${idx++} AND company_id=$${idx} RETURNING *`, values
    );
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    res.json({ order: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar pedido' }); }
});

// ===== PRODUCT MAPPING =====

router.get('/product-map/:connId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT pm.*, p.name AS product_name, p.price AS aura_price, p.stock_quantity
       FROM marketplace_product_map pm
       JOIN products p ON p.id=pm.product_id
       WHERE pm.connection_id=$1 AND pm.company_id=$2
       ORDER BY p.name`, [req.params.connId, req.params.id]
    );
    res.json({ total: rows.length, mappings: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar mapeamento' }); }
});

router.post('/product-map', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { connection_id, product_id, external_id, external_sku, external_url, price_markup } = req.body;
  if (!connection_id || !product_id || !external_id) return res.status(400).json({ error: 'connection_id, product_id e external_id obrigatorios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO marketplace_product_map (company_id, connection_id, product_id, external_id, external_sku, external_url, price_markup)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, connection_id, product_id, external_id, external_sku||null, external_url||null, price_markup||0]
    );
    res.status(201).json({ mapping: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Produto ja mapeado nesta conexao' });
    res.status(500).json({ error: 'Erro ao mapear produto' });
  }
});

module.exports = router;
