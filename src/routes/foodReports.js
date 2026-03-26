// ============================================================
// AURA. — FOOD-05: Relatórios Food Service
// Itens mais vendidos · horário de pico · desperdício · dashboard
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireAuth, requirePlan } = require('../middleware/auth');

const guard = [requireAuth, requirePlan(['negocio','expansao'])];
const periodFilter = (p) => ({
  today: `fo.created_at::date = NOW()::date`,
  week:  `fo.created_at >= NOW() - INTERVAL '7 days'`,
  month: `fo.created_at >= NOW() - INTERVAL '30 days'`,
  year:  `fo.created_at >= NOW() - INTERVAL '365 days'`,
}[p] || `fo.created_at::date = NOW()::date`);

// GET /companies/:id/food/reports/top-items?period=today|week|month&limit=10
router.get('/top-items', guard, async (req, res) => {
  const { period = 'month', limit = 10 } = req.query;
  try {
    const { rows } = await db.query(`
      SELECT
        foi.item_id,
        foi.item_name,
        SUM(foi.quantity)                          AS total_qty,
        SUM(foi.total_price)                       AS total_revenue,
        COUNT(DISTINCT foi.order_id)               AS order_count,
        ROUND(AVG(foi.unit_price)::NUMERIC, 2)     AS avg_price,
        fi.cost_price,
        CASE WHEN fi.price > 0
          THEN ROUND(((fi.price - COALESCE(fi.cost_price,0)) / fi.price * 100)::NUMERIC, 1)
          ELSE NULL END                            AS margin_pct
      FROM food_order_items foi
      JOIN food_orders fo ON fo.id = foi.order_id
      LEFT JOIN food_items fi ON fi.id = foi.item_id
      WHERE fo.company_id = $1
        AND fo.status NOT IN ('cancelled')
        AND ${periodFilter(period)}
      GROUP BY foi.item_id, foi.item_name, fi.cost_price, fi.price
      ORDER BY total_qty DESC
      LIMIT $2`,
      [req.params.id, limit]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/food/reports/peak-hours?period=week
// Retorna contagem de pedidos por hora do dia
router.get('/peak-hours', guard, async (req, res) => {
  const { period = 'week' } = req.query;
  try {
    const { rows } = await db.query(`
      SELECT
        EXTRACT(HOUR FROM fo.created_at AT TIME ZONE 'America/Sao_Paulo') AS hour,
        COUNT(*)            AS order_count,
        SUM(fo.total)       AS revenue,
        ROUND(AVG(fo.total)::NUMERIC, 2) AS avg_ticket
      FROM food_orders fo
      WHERE fo.company_id = $1
        AND fo.status NOT IN ('cancelled')
        AND ${periodFilter(period)}
      GROUP BY hour
      ORDER BY hour`,
      [req.params.id]
    );
    // Preenche horas sem movimento com zero
    const byHour = Object.fromEntries(rows.map(r => [parseInt(r.hour), r]));
    const full = Array.from({ length: 24 }, (_, h) => byHour[h] || {
      hour: h, order_count: 0, revenue: 0, avg_ticket: 0
    });
    res.json(full);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/food/reports/daily?days=30
// Faturamento diário dos últimos N dias
router.get('/daily', guard, async (req, res) => {
  const { days = 30 } = req.query;
  try {
    const { rows } = await db.query(`
      SELECT
        fo.created_at::date          AS date,
        COUNT(*)                     AS order_count,
        SUM(fo.total)                AS revenue,
        ROUND(AVG(fo.total)::NUMERIC, 2) AS avg_ticket
      FROM food_orders fo
      WHERE fo.company_id = $1
        AND fo.status NOT IN ('cancelled')
        AND fo.created_at >= NOW() - ($2 || ' days')::INTERVAL
      GROUP BY date
      ORDER BY date`,
      [req.params.id, days]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/food/reports/channels?period=month
// Receita por canal (presencial, delivery, iFood, etc.)
router.get('/channels', guard, async (req, res) => {
  const { period = 'month' } = req.query;
  try {
    const { rows } = await db.query(`
      SELECT
        fo.channel,
        COUNT(*)                     AS order_count,
        SUM(fo.total)                AS revenue,
        ROUND(AVG(fo.total)::NUMERIC, 2) AS avg_ticket
      FROM food_orders fo
      WHERE fo.company_id = $1
        AND fo.status NOT IN ('cancelled')
        AND ${periodFilter(period)}
      GROUP BY fo.channel
      ORDER BY revenue DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/food/reports/waste?start=&end=
router.get('/waste', guard, async (req, res) => {
  const { start, end, limit = 50 } = req.query;
  const conds = ['company_id = $1'];
  const vals  = [req.params.id];
  let i = 2;
  if (start) { conds.push(`recorded_at >= $${i++}`); vals.push(start); }
  if (end)   { conds.push(`recorded_at <= $${i++}`); vals.push(end); }
  try {
    const { rows } = await db.query(
      `SELECT * FROM food_waste_logs WHERE ${conds.join(' AND ')}
       ORDER BY recorded_at DESC LIMIT $${i}`,
      [...vals, limit]
    );
    // Totais
    const { rows: totals } = await db.query(
      `SELECT SUM(total_cost) AS total_waste_cost, COUNT(*) AS entries
       FROM food_waste_logs WHERE ${conds.join(' AND ')}`,
      vals
    );
    res.json({ entries: rows, summary: totals[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /companies/:id/food/reports/waste
router.post('/waste', guard, async (req, res) => {
  const { item_id, ingredient_name, quantity, unit, unit_cost, reason } = req.body;
  if (!ingredient_name || quantity == null || unit_cost == null)
    return res.status(400).json({ error: 'ingredient_name, quantity e unit_cost obrigatórios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO food_waste_logs
         (company_id, item_id, ingredient_name, quantity, unit, unit_cost, reason, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, item_id||null, ingredient_name, quantity,
       unit||'un', unit_cost, reason||null, req.user?.id||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /companies/:id/food/reports/waste/:wid
router.delete('/waste/:wid', guard, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM food_waste_logs WHERE id=$1 AND company_id=$2`,
      [req.params.wid, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/food/reports/dashboard?period=today
// Resumo executivo — tudo numa chamada só
router.get('/dashboard', guard, async (req, res) => {
  const { period = 'today' } = req.query;
  const cid = req.params.id;
  const pf  = periodFilter(period);
  try {
    const [stats, topItems, channels, waste, peakHour] = await Promise.all([
      db.query(`
        SELECT COUNT(*) FILTER (WHERE status NOT IN ('cancelled')) AS total_orders,
               SUM(total) FILTER (WHERE status='delivered')       AS revenue,
               ROUND(AVG(total) FILTER (WHERE status='delivered')::NUMERIC,2) AS avg_ticket,
               COUNT(*) FILTER (WHERE status='cancelled')         AS cancelled
        FROM food_orders WHERE company_id=$1 AND ${pf}`, [cid]),

      db.query(`
        SELECT foi.item_name, SUM(foi.quantity) AS qty
        FROM food_order_items foi
        JOIN food_orders fo ON fo.id=foi.order_id
        WHERE fo.company_id=$1 AND fo.status NOT IN ('cancelled') AND ${pf}
        GROUP BY foi.item_name ORDER BY qty DESC LIMIT 5`, [cid]),

      db.query(`
        SELECT channel, COUNT(*) AS orders, SUM(total) AS revenue
        FROM food_orders WHERE company_id=$1 AND status NOT IN ('cancelled') AND ${pf}
        GROUP BY channel ORDER BY revenue DESC`, [cid]),

      db.query(`
        SELECT COALESCE(SUM(total_cost),0) AS waste_cost
        FROM food_waste_logs WHERE company_id=$1
          AND recorded_at::date = NOW()::date`, [cid]),

      db.query(`
        SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Sao_Paulo') AS hour,
               COUNT(*) AS orders
        FROM food_orders WHERE company_id=$1 AND status NOT IN ('cancelled') AND ${pf}
        GROUP BY hour ORDER BY orders DESC LIMIT 1`, [cid]),
    ]);

    res.json({
      period,
      stats:      stats.rows[0],
      top_items:  topItems.rows,
      channels:   channels.rows,
      waste_cost: parseFloat(waste.rows[0]?.waste_cost || 0),
      peak_hour:  peakHour.rows[0] ? parseInt(peakHour.rows[0].hour) : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
