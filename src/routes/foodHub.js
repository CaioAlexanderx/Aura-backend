// Fase 10 (22/05/2026) -- Hub de Pedidos: endpoint agregador multi-canal.
//
// Une food_orders (presencial, delivery_proprio, ifood-stub, 99food-stub, whatsapp)
// + digital_orders (Canal Digital) em formato unificado pro frontend renderizar
// uma unica fila de pedidos abertos.
//
// iFood + 99food rodam em modo stub: adapters nao chamam API externa ainda;
// o GET /channels reporta connection_status: 'pending_approval' ate test stores
// aprovarem. Quando aprovar, codigo de webhook insere food_orders com
// external_channel = 'ifood'/'99food' e o Hub passa a listar automaticamente.
//
// Defensivo: armadilha_schema_pre_migration -- migration 128 pode nao ter rodado;
// erro 42703 (coluna inexistente) cai em fallback graceful retornando lista vazia
// + migration_pending: 128. Cache module-level evita repetir o probe.

const express = require('express');
const db = require('../config/database');
const router = express.Router({ mergeParams: true });

// Cache module-level pros campos da migration 128.
// Optimistic: assume presente, flip pra false no primeiro 42703.
let HAS_HUB_COLS = true;
let HAS_DIGITAL_ORDERS = true;

function markMissing(err) {
  if (err && err.code === '42703') {
    HAS_HUB_COLS = false;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GET /companies/:id/food/hub/orders
// Lista pedidos abertos de todos canais em formato unificado.
// Query params: channels=csv (presencial,canal_digital,ifood,99food,whatsapp)
//               status=csv  (pending,accepted,preparing,ready,dispatched,...)
//               limit=int   (default 100, max 500)
// ---------------------------------------------------------------------------
router.get('/orders', async (req, res) => {
  const companyId = req.params.id;
  const channels = (req.query.channels || '').split(',').filter(Boolean);
  const statuses = (req.query.status || '').split(',').filter(Boolean);
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);

  try {
    const params = [companyId];
    let whereCh = '';
    if (channels.length && HAS_HUB_COLS) {
      params.push(channels);
      whereCh = `AND (fo.external_channel = ANY($${params.length}) OR fo.channel = ANY($${params.length}))`;
    } else if (channels.length) {
      params.push(channels);
      whereCh = `AND fo.channel = ANY($${params.length})`;
    }
    let whereSt = '';
    if (statuses.length) {
      params.push(statuses);
      whereSt = `AND fo.status = ANY($${params.length})`;
    }

    const hubCols = HAS_HUB_COLS
      ? `fo.external_channel, fo.external_order_id, fo.channel_metadata, fo.auto_accepted_at,`
      : `NULL::TEXT AS external_channel, NULL::TEXT AS external_order_id, NULL::JSONB AS channel_metadata, NULL::TIMESTAMPTZ AS auto_accepted_at,`;

    const sql = `
      SELECT
        fo.id, fo.status, fo.channel,
        ${hubCols}
        fo.total_amount, fo.created_at, fo.confirmed_at, fo.ready_at, fo.delivered_at,
        fo.customer_name, fo.customer_address, fo.customer_phone,
        fo.deliverer_id, fo.deliverer_pin, fo.dispatched_at,
        fo.sale_id,
        fd.name AS deliverer_name,
        (
          SELECT json_agg(json_build_object(
            'id', foi.id,
            'name', foi.item_name,
            'variation', foi.variation_name,
            'quantity', foi.quantity,
            'total', foi.total_price
          ))
          FROM food_order_items foi WHERE foi.order_id = fo.id
        ) AS items,
        (
          SELECT ne.id FROM nfce_emissions ne
          WHERE ne.sale_id = fo.sale_id AND ne.status = 'emitida'
          LIMIT 1
        ) AS nfce_emission_id
      FROM food_orders fo
      LEFT JOIN food_deliverers fd ON fd.id = fo.deliverer_id
      WHERE fo.company_id = $1
        AND fo.status NOT IN ('delivered', 'cancelled')
        ${whereCh}
        ${whereSt}
      ORDER BY fo.created_at DESC
      LIMIT ${limit}
    `;

    let foodRows = [];
    try {
      const r = await db.query(sql, params);
      foodRows = r.rows;
    } catch (e) {
      if (markMissing(e)) {
        console.warn('[food/hub/orders] migration 128 nao aplicada, retry sem novas colunas');
        // Recursao simples: refaz sem hub cols
        const sql2 = sql
          .replace(/fo\.external_channel, fo\.external_order_id, fo\.channel_metadata, fo\.auto_accepted_at,/, 'NULL::TEXT AS external_channel, NULL::TEXT AS external_order_id, NULL::JSONB AS channel_metadata, NULL::TIMESTAMPTZ AS auto_accepted_at,')
          .replace(/AND \(fo\.external_channel = ANY\(\$\d+\) OR fo\.channel = ANY\(\$\d+\)\)/, '');
        const r2 = await db.query(sql2, params);
        foodRows = r2.rows;
      } else {
        throw e;
      }
    }

    // Carrega digital_orders abertos (channel digital). Try/catch 42P01 caso
    // tabela ainda nao exista em algum ambiente.
    let digital = [];
    if (HAS_DIGITAL_ORDERS) {
      try {
        const dr = await db.query(
          `SELECT id, status, total_amount, created_at, customer_name, customer_phone, items_json
           FROM digital_orders
           WHERE company_id = $1
             AND status IN ('pending_payment','awaiting_approval','accepted','preparing','ready')
           ORDER BY created_at DESC LIMIT 100`,
          [companyId]
        );
        digital = dr.rows.map((o) => ({
          id: o.id,
          status: o.status,
          channel: 'canal_digital',
          external_channel: 'canal_digital',
          total_amount: o.total_amount,
          created_at: o.created_at,
          customer_name: o.customer_name,
          customer_phone: o.customer_phone,
          customer_address: null,
          items: o.items_json || [],
          nfce_emission_id: null,
          source: 'digital_orders',
        }));
      } catch (e) {
        if (e.code === '42P01') {
          HAS_DIGITAL_ORDERS = false;
        } else {
          throw e;
        }
      }
    }

    res.json({
      orders: [
        ...foodRows.map((o) => ({ ...o, source: 'food_orders' })),
        ...digital,
      ],
      total: foodRows.length + digital.length,
      filters: { channels, statuses },
      ...(HAS_HUB_COLS ? {} : { migration_pending: 128 }),
    });
  } catch (err) {
    if (err && err.code === '42703') {
      console.warn('[food/hub/orders] migration 128 nao aplicada, fallback');
      HAS_HUB_COLS = false;
      return res.json({ orders: [], total: 0, filters: { channels, statuses }, migration_pending: 128 });
    }
    console.error('[food/hub/orders]', err);
    res.status(500).json({ error: 'Erro ao carregar Hub' });
  }
});

// ---------------------------------------------------------------------------
// GET /companies/:id/food/hub/stats
// KPIs do dia (pedidos, faturamento, prep medio, em rota) pro KPI strip.
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  const companyId = req.params.id;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [orderStats, revenue, prep, rota] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS today_orders,
                COUNT(*) FILTER (WHERE status NOT IN ('delivered','cancelled')) AS open_orders
         FROM food_orders WHERE company_id = $1 AND created_at >= $2`,
        [companyId, today]
      ),
      db.query(
        `SELECT COALESCE(SUM(total_amount), 0) AS today_revenue
         FROM food_orders WHERE company_id = $1
           AND created_at >= $2 AND status = 'delivered'`,
        [companyId, today]
      ),
      db.query(
        `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (ready_at - confirmed_at))/60), 0)::int AS avg_prep_min
         FROM food_orders WHERE company_id = $1
           AND ready_at IS NOT NULL AND confirmed_at IS NOT NULL
           AND created_at >= $2`,
        [companyId, today]
      ),
      db.query(
        `SELECT COUNT(*) AS in_route
         FROM food_orders WHERE company_id = $1
           AND dispatched_at IS NOT NULL AND delivered_at IS NULL`,
        [companyId]
      ),
    ]);

    res.json({
      today_orders: parseInt(orderStats.rows[0].today_orders, 10),
      open_orders: parseInt(orderStats.rows[0].open_orders, 10),
      today_revenue: parseFloat(revenue.rows[0].today_revenue),
      avg_prep_min: parseInt(prep.rows[0].avg_prep_min, 10),
      in_route: parseInt(rota.rows[0].in_route, 10),
    });
  } catch (err) {
    if (err && err.code === '42703') {
      return res.json({
        today_orders: 0,
        open_orders: 0,
        today_revenue: 0,
        avg_prep_min: 0,
        in_route: 0,
        migration_pending: 128,
      });
    }
    console.error('[food/hub/stats]', err);
    res.status(500).json({ error: 'Erro stats Hub' });
  }
});

// ---------------------------------------------------------------------------
// GET /companies/:id/food/hub/channels
// Estado de cada canal conectado (count hoje + status conexao).
// iFood + 99food: connected:false / connection_status:'pending_approval'
// ate aprovacao API real -- swap quando test store passar.
// ---------------------------------------------------------------------------
router.get('/channels', async (req, res) => {
  const companyId = req.params.id;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Tenta com external_channel; se 42703, fallback so com fo.channel.
    let groupExpr = HAS_HUB_COLS
      ? 'COALESCE(external_channel, channel)'
      : 'channel';

    let channelCounts;
    try {
      channelCounts = await db.query(
        `SELECT
           ${groupExpr} AS ch,
           COUNT(*) AS count_today,
           COUNT(*) FILTER (WHERE status NOT IN ('delivered','cancelled')) AS count_open
         FROM food_orders
         WHERE company_id = $1 AND created_at >= $2
         GROUP BY ${groupExpr}`,
        [companyId, today]
      );
    } catch (e) {
      if (markMissing(e)) {
        groupExpr = 'channel';
        channelCounts = await db.query(
          `SELECT
             channel AS ch,
             COUNT(*) AS count_today,
             COUNT(*) FILTER (WHERE status NOT IN ('delivered','cancelled')) AS count_open
           FROM food_orders
           WHERE company_id = $1 AND created_at >= $2
           GROUP BY channel`,
          [companyId, today]
        );
      } else {
        throw e;
      }
    }

    let digitalCount = 0;
    if (HAS_DIGITAL_ORDERS) {
      try {
        const dr = await db.query(
          `SELECT COUNT(*)::int AS count FROM digital_orders WHERE company_id = $1 AND created_at >= $2`,
          [companyId, today]
        );
        digitalCount = parseInt(dr.rows[0].count, 10);
      } catch (e) {
        if (e.code === '42P01') {
          HAS_DIGITAL_ORDERS = false;
        } else {
          throw e;
        }
      }
    }

    const byCh = Object.fromEntries(channelCounts.rows.map((r) => [r.ch, r]));
    const pick = (key, field) => parseInt((byCh[key] && byCh[key][field]) || 0, 10);

    res.json({
      channels: [
        {
          key: 'presencial',
          label: 'Presencial',
          connected: true,
          count_today: pick('presencial', 'count_today'),
          count_open: pick('presencial', 'count_open'),
        },
        {
          key: 'canal_digital',
          label: 'Canal Digital',
          connected: true,
          count_today: digitalCount,
          count_open: 0,
        },
        {
          key: 'ifood',
          label: 'iFood',
          connected: false,
          connection_status: 'pending_approval',
          count_today: pick('ifood', 'count_today'),
          count_open: pick('ifood', 'count_open'),
        },
        {
          key: '99food',
          label: '99Food',
          connected: false,
          connection_status: 'pending_approval',
          count_today: pick('99food', 'count_today'),
          count_open: pick('99food', 'count_open'),
        },
        {
          key: 'whatsapp',
          label: 'WhatsApp',
          connected: false,
          connection_status: 'hub_social_needed',
          count_today: pick('whatsapp', 'count_today'),
          count_open: pick('whatsapp', 'count_open'),
        },
      ],
      ...(HAS_HUB_COLS ? {} : { migration_pending: 128 }),
    });
  } catch (err) {
    if (err && err.code === '42703') {
      return res.json({ channels: [], migration_pending: 128 });
    }
    console.error('[food/hub/channels]', err);
    res.status(500).json({ error: 'Erro channels Hub' });
  }
});

module.exports = router;
