// ============================================================
// AURA. — Cash Flow Projection 30/60/90 days
// Projeta fluxo de caixa baseado em historico + recorrentes
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows: monthlyAvg } = await db.query(
      `SELECT AVG(receita)::numeric(12,2) AS avg_receita, AVG(despesa)::numeric(12,2) AS avg_despesa, COUNT(*) AS meses
       FROM (SELECT COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita, COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa
         FROM transactions WHERE company_id=$1 AND created_at >= date_trunc('month',NOW()) - INTERVAL '6 months' AND created_at < date_trunc('month',NOW())
         GROUP BY date_trunc('month',created_at)) m`, [cid]);
    const { rows: curM } = await db.query(
      `SELECT COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita, COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa,
         COUNT(DISTINCT DATE(created_at)) FILTER(WHERE type='income') AS dias_venda
       FROM transactions WHERE company_id=$1 AND created_at >= date_trunc('month',NOW()) AND created_at < date_trunc('month',NOW()) + INTERVAL '1 month'`, [cid]);
    const { rows: velR } = await db.query(
      `SELECT (SELECT COALESCE(AVG(d),0) FROM (SELECT SUM(amount) AS d FROM transactions WHERE company_id=$1 AND type='income' AND created_at>=NOW()-INTERVAL '7 days' GROUP BY DATE(created_at)) x) AS avg_7d,
         (SELECT COALESCE(AVG(d),0) FROM (SELECT SUM(amount) AS d FROM transactions WHERE company_id=$1 AND type='income' AND created_at>=NOW()-INTERVAL '30 days' GROUP BY DATE(created_at)) x) AS avg_30d`, [cid]);
    const { rows: recurring } = await db.query('SELECT type,description,amount,category,day_of_month FROM recurring_transactions WHERE company_id=$1 AND is_active=TRUE ORDER BY type', [cid]);
    const { rows: history } = await db.query(
      `SELECT TO_CHAR(date_trunc('month',created_at),'YYYY-MM') AS month, TO_CHAR(date_trunc('month',created_at),'Mon/YY') AS label,
         COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita, COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa
       FROM transactions WHERE company_id=$1 AND created_at >= date_trunc('month',NOW()) - INTERVAL '6 months' GROUP BY month,label ORDER BY month`, [cid]);

    const avg = monthlyAvg[0] || {}; const c = curM[0] || {}; const v = velR[0] || {};
    const avgR = parseFloat(avg.avg_receita) || 0; const avgD = parseFloat(avg.avg_despesa) || 0;
    const a7 = parseFloat(v.avg_7d) || 0; const a30 = parseFloat(v.avg_30d) || 0;
    const trend = a30 > 0 ? ((a7 - a30) / a30 * 100) : 0;
    const tf = 1 + Math.max(Math.min(trend / 100, 0.3), -0.3);
    const now = new Date(); const dim = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate(); const dom = now.getDate();
    const cR = parseFloat(c.receita) || 0; const cD = parseFloat(c.despesa) || 0;
    const dv = parseInt(c.dias_venda) || Math.max(dom - 2, 1); const projM = (cR / dv) * dim;
    const rI = recurring.filter(r => r.type === 'income').reduce((s, r) => s + parseFloat(r.amount), 0);
    const rE = recurring.filter(r => r.type === 'expense').reduce((s, r) => s + parseFloat(r.amount), 0);
    const bR = avgR > 0 ? avgR : projM; const bD = avgD > 0 ? avgD : cD;
    const proj = [30, 60, 90].map(d => { const m = d/30; const r = Math.round((bR*tf+rI)*m); const e = Math.round((bD+rE)*m); return { days: d, label: `${d} dias`, receita: r, despesa: e, resultado: r-e }; });
    const r30 = proj[0].resultado;
    const risk = r30 < 0 ? 'critical' : r30 < bD * 0.2 ? 'warning' : 'healthy';
    const riskMsg = risk === 'critical' ? 'Projecao negativa em 30 dias. Acao urgente.' : risk === 'warning' ? 'Margem apertada. Atencao ao fluxo.' : 'Fluxo saudavel para 90 dias.';
    res.json({
      current_month: { receita: cR, despesa: cD, resultado: cR-cD, projecao_receita: Math.round(projM), dias_restantes: dim-dom, pct_mes: Math.round(dom/dim*100) },
      averages: { receita: Math.round(avgR), despesa: Math.round(avgD), resultado: Math.round(avgR-avgD), meses: parseInt(avg.meses) || 0 },
      velocity: { daily_7d: Math.round(a7), daily_30d: Math.round(a30), trend_pct: Math.round(trend*10)/10, trend_factor: Math.round(tf*100)/100 },
      projections: proj,
      recurring: { income: rI, expense: rE, items: recurring.map(r => ({ type: r.type, description: r.description, amount: parseFloat(r.amount), category: r.category, day: r.day_of_month })) },
      risk: { level: risk, message: riskMsg },
      monthly_history: history.map(m => ({ month: m.month, label: m.label, receita: parseFloat(m.receita), despesa: parseFloat(m.despesa), resultado: parseFloat(m.receita)-parseFloat(m.despesa) })),
    });
  } catch (err) { console.error('cashflow error:', err); res.status(500).json({ error: 'Erro na projecao' }); }
});

router.post('/recurring', requireAuth, async (req, res) => {
  const { type, description, amount, category, recurrence='monthly', day_of_month=1 } = req.body;
  if (!type || !description || !amount) return res.status(400).json({ error: 'type, description, amount obrigatorios' });
  try { const { rows } = await db.query('INSERT INTO recurring_transactions (company_id,type,description,amount,category,recurrence,day_of_month) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [req.params.id, type, description, amount, category, recurrence, day_of_month]); res.status(201).json(rows[0]); }
  catch (err) { res.status(500).json({ error: 'Erro ao criar' }); }
});
router.get('/recurring', requireAuth, async (req, res) => {
  try { const { rows } = await db.query('SELECT * FROM recurring_transactions WHERE company_id=$1 ORDER BY type,day_of_month', [req.params.id]); res.json(rows); }
  catch (err) { res.status(500).json({ error: 'Erro' }); }
});
router.delete('/recurring/:rid', requireAuth, async (req, res) => {
  try { await db.query('DELETE FROM recurring_transactions WHERE id=$1 AND company_id=$2', [req.params.rid, req.params.id]); res.json({ deleted: true }); }
  catch (err) { res.status(500).json({ error: 'Erro' }); }
});

module.exports = router;
