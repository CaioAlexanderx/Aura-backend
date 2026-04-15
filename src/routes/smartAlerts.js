// ============================================================
// AURA. — Smart Alerts Engine
// Generates + manages financial/operational alerts
// ============================================================
var router = require('express').Router({ mergeParams: true });
var db = require('../config/database');
var { requireAuth } = require('../middleware/auth');

// GET /alerts — scan and return current alerts
router.get('/', requireAuth, async function(req, res) {
  var cid = req.params.id;
  try {
    var alerts = [];

    // 1. Cash flow risk — projected negative in 30 days
    var cashflow = (await db.query(
      "SELECT" +
      " COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS income_30d," +
      " COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS expense_30d" +
      " FROM transactions WHERE company_id=$1 AND created_at >= NOW()-INTERVAL '30 days'", [cid])).rows[0];
    var netCash = parseFloat(cashflow.income_30d) - parseFloat(cashflow.expense_30d);
    if (netCash < 0) {
      alerts.push({ type: 'cashflow_negative', severity: 'critical', title: 'Fluxo de caixa negativo', message: 'Nos ultimos 30 dias, as despesas superaram a receita em R$ ' + Math.abs(netCash).toFixed(2) + '.', data: { net: netCash, income: parseFloat(cashflow.income_30d), expense: parseFloat(cashflow.expense_30d) } });
    } else if (netCash < parseFloat(cashflow.expense_30d) * 0.2) {
      alerts.push({ type: 'cashflow_tight', severity: 'warning', title: 'Caixa apertado', message: 'A margem do caixa esta abaixo de 20% das despesas. Reserva de seguranca insuficiente.', data: { net: netCash, margin_pct: parseFloat(cashflow.expense_30d) > 0 ? Math.round(netCash / parseFloat(cashflow.expense_30d) * 100) : 0 } });
    }

    // 2. Revenue drop — last 7 days vs previous 7 days
    var weekComp = (await db.query(
      "SELECT" +
      " COALESCE(SUM(amount) FILTER(WHERE created_at >= NOW()-INTERVAL '7 days'),0) AS this_week," +
      " COALESCE(SUM(amount) FILTER(WHERE created_at >= NOW()-INTERVAL '14 days' AND created_at < NOW()-INTERVAL '7 days'),0) AS prev_week" +
      " FROM transactions WHERE company_id=$1 AND type='income' AND created_at >= NOW()-INTERVAL '14 days'", [cid])).rows[0];
    var thisWeek = parseFloat(weekComp.this_week);
    var prevWeek = parseFloat(weekComp.prev_week);
    if (prevWeek > 0 && thisWeek < prevWeek * 0.7) {
      var dropPct = Math.round((1 - thisWeek / prevWeek) * 100);
      alerts.push({ type: 'revenue_drop', severity: 'warning', title: 'Queda nas vendas', message: 'Receita caiu ' + dropPct + '% em relacao a semana anterior (R$ ' + thisWeek.toFixed(2) + ' vs R$ ' + prevWeek.toFixed(2) + ').', data: { this_week: thisWeek, prev_week: prevWeek, drop_pct: dropPct } });
    }

    // 3. Low-margin products selling a lot
    try {
      var lowMargin = (await db.query(
        "SELECT p.name, COUNT(si.id)::int AS vendas," +
        " CASE WHEN SUM(si.total_price) > 0 THEN ROUND(((SUM(si.total_price)-SUM(si.unit_cost*si.quantity))/SUM(si.total_price)*100)::numeric,1) ELSE 0 END AS margem" +
        " FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id" +
        " WHERE s.company_id=$1 AND s.created_at >= NOW()-INTERVAL '30 days' AND si.unit_cost > 0" +
        " GROUP BY p.name HAVING COUNT(si.id) >= 3" +
        " AND CASE WHEN SUM(si.total_price)>0 THEN ((SUM(si.total_price)-SUM(si.unit_cost*si.quantity))/SUM(si.total_price)*100) ELSE 0 END < 10" +
        " ORDER BY vendas DESC LIMIT 5", [cid])).rows;
      lowMargin.forEach(function(p) {
        alerts.push({ type: 'low_margin_product', severity: 'info', title: 'Margem baixa: ' + p.name, message: p.name + ' tem margem de ' + p.margem + '% com ' + p.vendas + ' vendas nos ultimos 30 dias. Considere reajustar o preco.', data: { product: p.name, margin: parseFloat(p.margem), sales: p.vendas } });
      });
    } catch (_) {}

    // 4. Stock running low
    try {
      var lowStock = (await db.query(
        "SELECT name, stock_qty, min_stock FROM products" +
        " WHERE company_id=$1 AND is_active=true AND track_stock=true" +
        " AND stock_qty <= COALESCE(min_stock, 5) AND stock_qty > 0" +
        " ORDER BY stock_qty ASC LIMIT 10", [cid])).rows;
      lowStock.forEach(function(p) {
        alerts.push({ type: 'low_stock', severity: 'warning', title: 'Estoque baixo: ' + p.name, message: p.name + ' tem apenas ' + p.stock_qty + ' unidades (minimo: ' + (p.min_stock || 5) + ').', data: { product: p.name, qty: parseInt(p.stock_qty), min: parseInt(p.min_stock || 5) } });
      });
      var outStock = (await db.query(
        "SELECT name FROM products WHERE company_id=$1 AND is_active=true AND track_stock=true AND stock_qty <= 0 LIMIT 10", [cid])).rows;
      if (outStock.length > 0) {
        alerts.push({ type: 'out_of_stock', severity: 'critical', title: outStock.length + ' produto(s) sem estoque', message: outStock.map(function(p) { return p.name; }).join(', '), data: { count: outStock.length, products: outStock.map(function(p) { return p.name; }) } });
      }
    } catch (_) {}

    // 5. Expense spike — category with 2x+ increase
    try {
      var expSpike = (await db.query(
        "SELECT category," +
        " COALESCE(SUM(amount) FILTER(WHERE created_at >= date_trunc('month',NOW())),0) AS this_month," +
        " COALESCE(SUM(amount) FILTER(WHERE created_at >= date_trunc('month',NOW())-INTERVAL '1 month' AND created_at < date_trunc('month',NOW())),0) AS prev_month" +
        " FROM transactions WHERE company_id=$1 AND type='expense'" +
        " AND created_at >= date_trunc('month',NOW())-INTERVAL '1 month'" +
        " GROUP BY category" +
        " HAVING COALESCE(SUM(amount) FILTER(WHERE created_at >= date_trunc('month',NOW())-INTERVAL '1 month' AND created_at < date_trunc('month',NOW())),0) > 0" +
        " AND COALESCE(SUM(amount) FILTER(WHERE created_at >= date_trunc('month',NOW())),0) > COALESCE(SUM(amount) FILTER(WHERE created_at >= date_trunc('month',NOW())-INTERVAL '1 month' AND created_at < date_trunc('month',NOW())),0) * 2" +
        " ORDER BY this_month DESC LIMIT 3", [cid])).rows;
      expSpike.forEach(function(e) {
        var increase = Math.round((parseFloat(e.this_month) / parseFloat(e.prev_month) - 1) * 100);
        alerts.push({ type: 'expense_spike', severity: 'info', title: 'Aumento em ' + (e.category || 'Outros'), message: 'A categoria "' + (e.category || 'Outros') + '" aumentou ' + increase + '% este mes (R$ ' + parseFloat(e.this_month).toFixed(2) + ' vs R$ ' + parseFloat(e.prev_month).toFixed(2) + ').', data: { category: e.category, this_month: parseFloat(e.this_month), prev_month: parseFloat(e.prev_month), increase_pct: increase } });
      });
    } catch (_) {}

    // 6. Dormant customers count
    try {
      var dormant = (await db.query(
        "SELECT COUNT(*)::int AS cnt FROM customers" +
        " WHERE company_id=$1 AND last_purchase_at IS NOT NULL" +
        " AND last_purchase_at < NOW()-INTERVAL '60 days'", [cid])).rows[0];
      if (dormant.cnt > 0) {
        alerts.push({ type: 'dormant_customers', severity: 'info', title: dormant.cnt + ' cliente(s) inativos', message: dormant.cnt + ' clientes nao compram ha mais de 60 dias. Considere uma campanha de reativacao.', data: { count: dormant.cnt } });
      }
    } catch (_) {}

    // Sort by severity
    var severityOrder = { critical: 0, warning: 1, info: 2 };
    alerts.sort(function(a, b) { return (severityOrder[a.severity] || 9) - (severityOrder[b.severity] || 9); });

    res.json({ alerts: alerts, total: alerts.length, generated_at: new Date().toISOString() });
  } catch (err) { console.error('smart alerts error:', err); res.status(500).json({ error: 'Erro ao gerar alertas' }); }
});

// GET /alerts/history — past triggered alerts
router.get('/history', requireAuth, async function(req, res) {
  var cid = req.params.id;
  var { limit = 50, unread_only } = req.query;
  try {
    var where = 'company_id=$1';
    if (unread_only === 'true') where += ' AND is_read=false';
    var { rows } = await db.query(
      'SELECT * FROM alert_history WHERE ' + where + ' ORDER BY created_at DESC LIMIT $2',
      [cid, Math.min(parseInt(limit) || 50, 200)]);
    var { rows: countRows } = await db.query(
      'SELECT COUNT(*)::int AS unread FROM alert_history WHERE company_id=$1 AND is_read=false', [cid]);
    res.json({ alerts: rows, unread_count: countRows[0]?.unread || 0 });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// PATCH /alerts/history/:alertId/read — mark as read
router.patch('/history/:alertId/read', requireAuth, async function(req, res) {
  var cid = req.params.id;
  var alertId = req.params.alertId;
  try {
    await db.query('UPDATE alert_history SET is_read=true WHERE id=$1 AND company_id=$2', [alertId, cid]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// POST /alerts/history/read-all — mark all as read
router.post('/history/read-all', requireAuth, async function(req, res) {
  var cid = req.params.id;
  try {
    var { rowCount } = await db.query('UPDATE alert_history SET is_read=true WHERE company_id=$1 AND is_read=false', [cid]);
    res.json({ ok: true, marked: rowCount });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// GET /alerts/config — alert preferences
router.get('/config', requireAuth, async function(req, res) {
  var cid = req.params.id;
  try {
    var { rows } = await db.query('SELECT * FROM financial_alerts WHERE company_id=$1 ORDER BY alert_type', [cid]);
    res.json({ config: rows });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// PUT /alerts/config — upsert alert config
router.put('/config', requireAuth, async function(req, res) {
  var cid = req.params.id;
  var { alert_type, is_enabled, threshold, notify_push, notify_email, cooldown_hours } = req.body;
  if (!alert_type) return res.status(400).json({ error: 'alert_type obrigatorio' });
  try {
    var { rows } = await db.query(
      'INSERT INTO financial_alerts (company_id, alert_type, is_enabled, threshold, notify_push, notify_email, cooldown_hours)' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7)' +
      ' ON CONFLICT (company_id, alert_type) DO UPDATE SET is_enabled=EXCLUDED.is_enabled, threshold=EXCLUDED.threshold, notify_push=EXCLUDED.notify_push, notify_email=EXCLUDED.notify_email, cooldown_hours=EXCLUDED.cooldown_hours' +
      ' RETURNING *',
      [cid, alert_type, is_enabled !== false, threshold || null, notify_push !== false, notify_email === true, cooldown_hours || 24]);
    res.json(rows[0]);
  } catch (err) {
    // If unique constraint doesn't exist, try without ON CONFLICT
    try {
      await db.query('UPDATE financial_alerts SET is_enabled=$3, threshold=$4 WHERE company_id=$1 AND alert_type=$2',
        [cid, alert_type, is_enabled !== false, threshold || null]);
      res.json({ alert_type, is_enabled: is_enabled !== false });
    } catch (err2) { res.status(500).json({ error: 'Erro' }); }
  }
});

module.exports = router;
