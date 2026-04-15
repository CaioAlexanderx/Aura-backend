// ============================================================
// AURA. — Cash Flow Projection 30/60/90 days
// Projeta fluxo de caixa baseado em:
//   1. Média de receita/despesa dos últimos 3 meses
//   2. Transações recorrentes cadastradas
//   3. Sazonalidade (dia da semana)
//   4. Tendência (acelerando ou desacelerando)
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    // 1. Historical monthly averages (last 6 completed months)
    const { rows: monthlyAvg } = await db.query(
      `SELECT
         AVG(receita)::numeric(12,2) AS avg_receita,
         AVG(despesa)::numeric(12,2) AS avg_despesa,
         AVG(receita - despesa)::numeric(12,2) AS avg_resultado,
         COUNT(*) AS meses
       FROM (
         SELECT
           COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita,
           COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa
         FROM transactions
         WHERE company_id=$1
           AND created_at >= date_trunc('month',NOW()) - INTERVAL '6 months'
           AND created_at < date_trunc('month',NOW())
         GROUP BY date_trunc('month',created_at)
       ) months`, [cid]);

    // 2. Current month progress
    const { rows: currentMonth } = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita,
         COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa,
         COUNT(DISTINCT DATE(created_at)) FILTER(WHERE type='income') AS dias_com_venda
       FROM transactions
       WHERE company_id=$1
         AND created_at >= date_trunc('month',NOW())
         AND created_at < date_trunc('month',NOW()) + INTERVAL '1 month'`, [cid]);

    // 3. Velocity trend (last 7d vs last 30d)
    const { rows: velocity } = await db.query(
      `SELECT
         (SELECT COALESCE(AVG(d),0) FROM (
           SELECT SUM(amount) AS d FROM transactions
           WHERE company_id=$1 AND type='income' AND created_at >= NOW()-INTERVAL '7 days'
           GROUP BY DATE(created_at)
         ) x) AS avg_7d,
         (SELECT COALESCE(AVG(d),0) FROM (
           SELECT SUM(amount) AS d FROM transactions
           WHERE company_id=$1 AND type='income' AND created_at >= NOW()-INTERVAL '30 days'
           GROUP BY DATE(created_at)
         ) x) AS avg_30d`, [cid]);

    // 4. Recurring transactions
    const { rows: recurring } = await db.query(
      `SELECT type, description, amount, recurrence, day_of_month, category
       FROM recurring_transactions
       WHERE company_id=$1 AND is_active=TRUE
       ORDER BY type, day_of_month`, [cid]);

    // 5. Monthly breakdown for last 6 months (for chart)
    const { rows: monthlyHistory } = await db.query(
      `SELECT TO_CHAR(date_trunc('month',created_at),'YYYY-MM') AS month,
         TO_CHAR(date_trunc('month',created_at),'Mon/YY') AS label,
         COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita,
         COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa
       FROM transactions
       WHERE company_id=$1
         AND created_at >= date_trunc('month',NOW()) - INTERVAL '6 months'
       GROUP BY month, label ORDER BY month`, [cid]);

    // ── Compute projections ──
    const avg = monthlyAvg[0] || {};
    const cur = currentMonth[0] || {};
    const vel = velocity[0] || {};
    const avgReceita = parseFloat(avg.avg_receita) || 0;
    const avgDespesa = parseFloat(avg.avg_despesa) || 0;
    const avg7d = parseFloat(vel.avg_7d) || 0;
    const avg30d = parseFloat(vel.avg_30d) || 0;
    const trendPct = avg30d > 0 ? ((avg7d - avg30d) / avg30d * 100) : 0;

    // Trend factor: if sales accelerating, project higher
    const trendFactor = 1 + Math.max(Math.min(trendPct / 100, 0.3), -0.3);

    // Current month projection
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth = now.getDate();
    const curReceita = parseFloat(cur.receita) || 0;
    const curDespesa = parseFloat(cur.despesa) || 0;
    const diasComVenda = parseInt(cur.dias_com_venda) || Math.max(dayOfMonth - 2, 1);
    const dailyRate = curReceita / diasComVenda;
    const projectedMonthReceita = dailyRate * daysInMonth;

    // Recurring monthly totals
    const recurringIncome = recurring.filter(r => r.type === 'income').reduce((s, r) => s + parseFloat(r.amount), 0);
    const recurringExpense = recurring.filter(r => r.type === 'expense').reduce((s, r) => s + parseFloat(r.amount), 0);

    // Project 30/60/90 days
    const baseReceita = avgReceita > 0 ? avgReceita : projectedMonthReceita;
    const baseDespesa = avgDespesa > 0 ? avgDespesa : curDespesa;

    const projections = [30, 60, 90].map(days => {
      const months = days / 30;
      const receita = Math.round((baseReceita * trendFactor + recurringIncome) * months);
      const despesa = Math.round((baseDespesa + recurringExpense) * months);
      return {
        days,
        label: `${days} dias`,
        receita,
        despesa,
        resultado: receita - despesa,
        saldo_acumulado: receita - despesa,
      };
    });

    // Risk assessment
    const resultado30 = projections[0].resultado;
    const riskLevel = resultado30 < 0 ? 'critical'
      : resultado30 < baseDespesa * 0.2 ? 'warning'
      : 'healthy';

    const riskMessage = riskLevel === 'critical'
      ? 'Projecao negativa nos proximos 30 dias. Faturamento precisa aumentar ou despesas reduzir urgentemente.'
      : riskLevel === 'warning'
      ? 'Margem apertada nos proximos 30 dias. Atencao ao fluxo de caixa.'
      : 'Fluxo de caixa saudavel para os proximos 90 dias.';

    res.json({
      current_month: {
        receita: curReceita,
        despesa: curDespesa,
        resultado: curReceita - curDespesa,
        projecao_receita: Math.round(projectedMonthReceita),
        dias_restantes: daysInMonth - dayOfMonth,
        pct_mes: Math.round((dayOfMonth / daysInMonth) * 100),
      },
      averages: {
        receita: Math.round(avgReceita),
        despesa: Math.round(avgDespesa),
        resultado: Math.round(avgReceita - avgDespesa),
        meses_analisados: parseInt(avg.meses) || 0,
      },
      velocity: {
        daily_7d: Math.round(avg7d),
        daily_30d: Math.round(avg30d),
        trend_pct: Math.round(trendPct * 10) / 10,
        trend_factor: Math.round(trendFactor * 100) / 100,
      },
      projections,
      recurring: {
        income: recurringIncome,
        expense: recurringExpense,
        items: recurring.map(r => ({ type: r.type, description: r.description, amount: parseFloat(r.amount), category: r.category, day: r.day_of_month })),
      },
      risk: { level: riskLevel, message: riskMessage },
      monthly_history: monthlyHistory.map(m => ({
        month: m.month, label: m.label,
        receita: parseFloat(m.receita), despesa: parseFloat(m.despesa),
        resultado: parseFloat(m.receita) - parseFloat(m.despesa),
      })),
    });
  } catch (err) {
    console.error('cashflow projection error:', err);
    res.status(500).json({ error: 'Erro ao gerar projecao' });
  }
});

// CRUD recurring transactions
router.post('/recurring', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { type, description, amount, category, recurrence = 'monthly', day_of_month = 1 } = req.body;
  if (!type || !description || !amount) return res.status(400).json({ error: 'type, description e amount obrigatorios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO recurring_transactions (company_id,type,description,amount,category,recurrence,day_of_month)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [cid, type, description, amount, category, recurrence, day_of_month]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erro ao criar recorrencia' }); }
});

router.get('/recurring', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      'SELECT * FROM recurring_transactions WHERE company_id=$1 ORDER BY type,day_of_month', [cid]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Erro ao listar recorrencias' }); }
});

router.delete('/recurring/:rid', requireAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM recurring_transactions WHERE id=$1 AND company_id=$2', [req.params.rid, req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: 'Erro ao remover' }); }
});

module.exports = router;
