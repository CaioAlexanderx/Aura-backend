// ============================================================
// AURA. — Financial Analysis v2: Deep Business Intelligence
// Designed for retail (clothing stores like Finesse):
// - Sales velocity & daily patterns
// - Employee performance comparison
// - Customer recurrence analysis
// - Seasonality & day-of-week breakdown
// - Smart projections based on real trends
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { months = 13 } = req.query;
  const numMonths = Math.min(Math.max(parseInt(months) || 13, 3), 24);

  try {
    // ── 1. Monthly breakdown ──────────────────────────────────
    const { rows: monthly } = await db.query(
      `SELECT TO_CHAR(created_at,'YYYY-MM') AS month, TO_CHAR(created_at,'Mon/YY') AS label,
         COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita,
         COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa,
         COUNT(*) FILTER(WHERE type='income') AS qtd_vendas,
         COUNT(*) FILTER(WHERE type='expense') AS qtd_despesas,
         COUNT(DISTINCT DATE(created_at)) FILTER(WHERE type='income') AS dias_com_venda
       FROM transactions WHERE company_id=$1
         AND created_at >= date_trunc('month',NOW())-(($2::int-1)||' months')::interval
       GROUP BY month, label ORDER BY month ASC`, [cid, numMonths]);

    // ── 2. Current month ──────────────────────────────────────
    const { rows: currentMonth } = await db.query(
      `SELECT COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita,
         COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa,
         COUNT(*) FILTER(WHERE type='income') AS qtd_vendas,
         COUNT(*) AS total_lancamentos,
         COUNT(DISTINCT DATE(created_at)) FILTER(WHERE type='income') AS dias_com_venda
       FROM transactions WHERE company_id=$1
         AND created_at >= date_trunc('month',NOW())
         AND created_at < date_trunc('month',NOW())+INTERVAL '1 month'`, [cid]);

    // ── 3. Previous month ─────────────────────────────────────
    const { rows: prevMonth } = await db.query(
      `SELECT COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita,
         COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa,
         COUNT(*) FILTER(WHERE type='income') AS qtd_vendas
       FROM transactions WHERE company_id=$1
         AND created_at >= date_trunc('month',NOW())-INTERVAL '1 month'
         AND created_at < date_trunc('month',NOW())`, [cid]);

    // ── 4. Day-of-week breakdown (which days sell most?) ──────
    const { rows: dayOfWeek } = await db.query(
      `SELECT EXTRACT(DOW FROM created_at)::int AS dow,
         TO_CHAR(created_at,'Dy') AS label,
         COUNT(*) AS vendas,
         COALESCE(SUM(amount),0) AS faturamento,
         ROUND(AVG(amount)::numeric,2) AS ticket_medio
       FROM transactions WHERE company_id=$1 AND type='income'
         AND created_at >= NOW()-INTERVAL '90 days'
       GROUP BY dow, label ORDER BY dow`, [cid]);

    // ── 5. Hourly pattern (what time of day sells most?) ──────
    const { rows: hourly } = await db.query(
      `SELECT EXTRACT(HOUR FROM created_at)::int AS hora,
         COUNT(*) AS vendas, COALESCE(SUM(amount),0) AS faturamento
       FROM transactions WHERE company_id=$1 AND type='income'
         AND created_at >= NOW()-INTERVAL '90 days'
       GROUP BY hora ORDER BY hora`, [cid]);

    // ── 6. Employee ranking (UNION sales + transactions) ──────
    let employees = [];
    try {
      const { rows } = await db.query(
        `SELECT name,
           SUM(total_sales)::int AS vendas,
           SUM(total_revenue) AS faturamento,
           ROUND((SUM(total_revenue)/NULLIF(SUM(total_sales),0))::numeric,2) AS ticket_medio,
           ROUND((SUM(total_revenue)*100.0/NULLIF((SELECT SUM(amount) FROM transactions WHERE company_id=$1 AND type='income' AND created_at >= date_trunc('month',NOW())-(($2::int-1)||' months')::interval),0))::numeric,1) AS pct_total
         FROM (
           SELECT COALESCE(e.name,'Sem vendedor') AS name, COUNT(s.id) AS total_sales, COALESCE(SUM(s.total_amount),0) AS total_revenue
           FROM sales s LEFT JOIN employees e ON e.id=s.employee_id
           WHERE s.company_id=$1 AND s.created_at >= date_trunc('month',NOW())-(($2::int-1)||' months')::interval
           GROUP BY e.name
           UNION ALL
           SELECT COALESCE(t.employee_name,'Sem vendedor') AS name, COUNT(t.id) AS total_sales, COALESCE(SUM(t.amount),0) AS total_revenue
           FROM transactions t WHERE t.company_id=$1 AND t.type='income' AND t.employee_name IS NOT NULL
             AND t.created_at >= date_trunc('month',NOW())-(($2::int-1)||' months')::interval
           GROUP BY t.employee_name
         ) combined GROUP BY name ORDER BY faturamento DESC`, [cid, numMonths]);
      employees = rows;
    } catch (_) {}

    // ── 7. Employee monthly evolution ─────────────────────────
    let employeeMonthly = [];
    try {
      const { rows } = await db.query(
        `SELECT TO_CHAR(created_at,'YYYY-MM') AS month, employee_name AS name,
           COUNT(*) AS vendas, SUM(amount) AS faturamento
         FROM transactions WHERE company_id=$1 AND type='income' AND employee_name IS NOT NULL
           AND created_at >= date_trunc('month',NOW())-'6 months'::interval
         GROUP BY month, employee_name ORDER BY month, faturamento DESC`, [cid]);
      employeeMonthly = rows;
    } catch (_) {}

    // ── 8. Top recurring customers ────────────────────────────
    let topCustomers = [];
    try {
      const { rows } = await db.query(
        `SELECT description AS cliente,
           COUNT(*) AS compras,
           SUM(amount) AS total_gasto,
           ROUND(AVG(amount)::numeric,2) AS ticket_medio,
           MIN(created_at) AS primeira_compra,
           MAX(created_at) AS ultima_compra
         FROM transactions WHERE company_id=$1 AND type='income'
           AND created_at >= date_trunc('month',NOW())-(($2::int-1)||' months')::interval
           AND description LIKE 'Venda %'
         GROUP BY description HAVING COUNT(*) >= 2
         ORDER BY total_gasto DESC LIMIT 20`, [cid, numMonths]);
      topCustomers = rows;
    } catch (_) {}

    // ── 9. Sales velocity (daily average, trend) ──────────────
    const { rows: velocityRows } = await db.query(
      `SELECT
         (SELECT ROUND(AVG(daily_total)::numeric,2) FROM (
           SELECT DATE(created_at), SUM(amount) AS daily_total
           FROM transactions WHERE company_id=$1 AND type='income'
             AND created_at >= NOW()-INTERVAL '30 days'
           GROUP BY DATE(created_at)
         ) d30) AS avg_dia_30d,
         (SELECT ROUND(AVG(daily_total)::numeric,2) FROM (
           SELECT DATE(created_at), SUM(amount) AS daily_total
           FROM transactions WHERE company_id=$1 AND type='income'
             AND created_at >= NOW()-INTERVAL '7 days'
           GROUP BY DATE(created_at)
         ) d7) AS avg_dia_7d,
         (SELECT ROUND(AVG(daily_count)::numeric,1) FROM (
           SELECT DATE(created_at), COUNT(*) AS daily_count
           FROM transactions WHERE company_id=$1 AND type='income'
             AND created_at >= NOW()-INTERVAL '30 days'
           GROUP BY DATE(created_at)
         ) c30) AS avg_vendas_dia_30d`, [cid]);

    // ── 10. Ticket distribution (ranges) ──────────────────────
    const { rows: ticketDist } = await db.query(
      `SELECT
         CASE
           WHEN amount < 50 THEN 'Ate R$50'
           WHEN amount < 100 THEN 'R$50-100'
           WHEN amount < 150 THEN 'R$100-150'
           WHEN amount < 200 THEN 'R$150-200'
           WHEN amount < 300 THEN 'R$200-300'
           WHEN amount < 500 THEN 'R$300-500'
           ELSE 'Acima R$500'
         END AS faixa,
         COUNT(*) AS vendas,
         COALESCE(SUM(amount),0) AS faturamento,
         ROUND(AVG(amount)::numeric,2) AS ticket_medio
       FROM transactions WHERE company_id=$1 AND type='income'
         AND created_at >= date_trunc('month',NOW())-(($2::int-1)||' months')::interval
       GROUP BY faixa ORDER BY MIN(amount)`, [cid, numMonths]);

    // ── 11. Weekly trend (last 12 weeks) ──────────────────────
    const { rows: weeklyTrend } = await db.query(
      `SELECT TO_CHAR(date_trunc('week',created_at),'DD/MM') AS semana,
         date_trunc('week',created_at) AS week_start,
         COUNT(*) AS vendas, COALESCE(SUM(amount),0) AS faturamento,
         ROUND(AVG(amount)::numeric,2) AS ticket_medio
       FROM transactions WHERE company_id=$1 AND type='income'
         AND created_at >= NOW()-INTERVAL '12 weeks'
       GROUP BY semana, week_start ORDER BY week_start`, [cid]);

    // ── Compute metrics ───────────────────────────────────────
    const cur = currentMonth[0] || {};
    const prev = prevMonth[0] || {};
    const curReceita = parseFloat(cur.receita) || 0;
    const curDespesa = parseFloat(cur.despesa) || 0;
    const curVendas = parseInt(cur.qtd_vendas) || 0;
    const prevReceita = parseFloat(prev.receita) || 0;
    const prevDespesa = parseFloat(prev.despesa) || 0;
    const prevVendas = parseInt(prev.qtd_vendas) || 0;

    const receitaGrowth = prevReceita > 0 ? ((curReceita-prevReceita)/prevReceita*100) : 0;
    const despesaGrowth = prevDespesa > 0 ? ((curDespesa-prevDespesa)/prevDespesa*100) : 0;
    const vendasGrowth = prevVendas > 0 ? ((curVendas-prevVendas)/prevVendas*100) : 0;
    const marginPct = curReceita > 0 ? (((curReceita-curDespesa)/curReceita)*100) : 0;
    const avgTicket = curVendas > 0 ? curReceita/curVendas : 0;
    const prevAvgTicket = prevVendas > 0 ? prevReceita/prevVendas : 0;

    const completedMonths = monthly.filter(m => new Date(m.month+'-01') < new Date(new Date().getFullYear(),new Date().getMonth(),1));
    const avgMonthlyReceita = completedMonths.length > 0 ? completedMonths.reduce((s,m)=>s+parseFloat(m.receita),0)/completedMonths.length : 0;
    const avgMonthlyDespesa = completedMonths.length > 0 ? completedMonths.reduce((s,m)=>s+parseFloat(m.despesa),0)/completedMonths.length : 0;

    const sortedByReceita = [...completedMonths].sort((a,b)=>parseFloat(b.receita)-parseFloat(a.receita));
    const bestMonth = sortedByReceita[0] || null;
    const worstMonth = sortedByReceita[sortedByReceita.length-1] || null;

    // Velocity
    const vel = velocityRows[0] || {};
    const avgDia30d = parseFloat(vel.avg_dia_30d) || 0;
    const avgDia7d = parseFloat(vel.avg_dia_7d) || 0;
    const velocityTrend = avgDia30d > 0 ? ((avgDia7d - avgDia30d) / avgDia30d * 100) : 0;

    // Days remaining in month for projection
    const now = new Date();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    const dayOfMonth = now.getDate();
    const diasCorridos = parseInt(cur.dias_com_venda) || dayOfMonth;
    const projectedMonthly = diasCorridos > 0 ? (curReceita / diasCorridos) * daysInMonth : 0;

    res.json({
      monthly: monthly.map(m => ({
        month: m.month, label: m.label,
        receita: parseFloat(m.receita), despesa: parseFloat(m.despesa),
        resultado: parseFloat(m.receita)-parseFloat(m.despesa),
        qtd_vendas: parseInt(m.qtd_vendas),
        dias_com_venda: parseInt(m.dias_com_venda) || 0,
        ticket_medio: parseInt(m.qtd_vendas) > 0 ? Math.round(parseFloat(m.receita)/parseInt(m.qtd_vendas)*100)/100 : 0,
        margem_pct: parseFloat(m.receita) > 0 ? Math.round((parseFloat(m.receita)-parseFloat(m.despesa))/parseFloat(m.receita)*100) : 0,
      })),

      current: { receita: curReceita, despesa: curDespesa, resultado: curReceita-curDespesa, vendas: curVendas, margem_pct: Math.round(marginPct), avg_ticket: Math.round(avgTicket*100)/100, lancamentos: parseInt(cur.total_lancamentos)||0, projecao_mes: Math.round(projectedMonthly) },
      previous: { receita: prevReceita, despesa: prevDespesa, resultado: prevReceita-prevDespesa, vendas: prevVendas, avg_ticket: Math.round(prevAvgTicket*100)/100 },
      growth: { receita_pct: Math.round(receitaGrowth*10)/10, despesa_pct: Math.round(despesaGrowth*10)/10, vendas_pct: Math.round(vendasGrowth*10)/10 },

      // NEW: Sales velocity
      velocity: {
        media_dia_30d: avgDia30d,
        media_dia_7d: avgDia7d,
        tendencia_pct: Math.round(velocityTrend*10)/10,
        vendas_por_dia: parseFloat(vel.avg_vendas_dia_30d) || 0,
        projecao_mes: Math.round(projectedMonthly),
      },

      // NEW: Day of week breakdown
      dayOfWeek: dayOfWeek.map(d => ({
        dow: d.dow, label: d.label,
        vendas: parseInt(d.vendas), faturamento: parseFloat(d.faturamento),
        ticket_medio: parseFloat(d.ticket_medio),
      })),

      // NEW: Ticket distribution
      ticketDistribution: ticketDist.map(t => ({
        faixa: t.faixa, vendas: parseInt(t.vendas),
        faturamento: parseFloat(t.faturamento), ticket_medio: parseFloat(t.ticket_medio),
      })),

      // NEW: Weekly trend
      weeklyTrend: weeklyTrend.map(w => ({
        semana: w.semana, vendas: parseInt(w.vendas),
        faturamento: parseFloat(w.faturamento), ticket_medio: parseFloat(w.ticket_medio),
      })),

      // ENHANCED: Employee ranking with % participation
      employees: employees.map(e => ({
        name: e.name, vendas: parseInt(e.vendas),
        faturamento: parseFloat(e.faturamento), ticket_medio: parseFloat(e.ticket_medio),
        pct_total: parseFloat(e.pct_total) || 0,
      })),

      // NEW: Employee monthly evolution
      employeeMonthly: employeeMonthly.map(e => ({
        month: e.month, name: e.name,
        vendas: parseInt(e.vendas), faturamento: parseFloat(e.faturamento),
      })),

      // NEW: Top recurring customers
      topCustomers: topCustomers.map(c => ({
        cliente: c.cliente.replace('Venda ',''), compras: parseInt(c.compras),
        total_gasto: parseFloat(c.total_gasto), ticket_medio: parseFloat(c.ticket_medio),
        primeira_compra: c.primeira_compra, ultima_compra: c.ultima_compra,
      })),

      // Insights
      insights: {
        avg_monthly_receita: Math.round(avgMonthlyReceita),
        avg_monthly_despesa: Math.round(avgMonthlyDespesa),
        avg_monthly_resultado: Math.round(avgMonthlyReceita-avgMonthlyDespesa),
        best_month: bestMonth ? { month: bestMonth.month, label: bestMonth.label, receita: parseFloat(bestMonth.receita) } : null,
        worst_month: worstMonth ? { month: worstMonth.month, label: worstMonth.label, receita: parseFloat(worstMonth.receita) } : null,
        total_receita_periodo: completedMonths.reduce((s,m)=>s+parseFloat(m.receita),0),
        total_despesa_periodo: completedMonths.reduce((s,m)=>s+parseFloat(m.despesa),0),
        meses_analisados: completedMonths.length,
        melhor_dia_semana: dayOfWeek.length > 0 ? dayOfWeek.reduce((a,b) => parseFloat(a.faturamento) > parseFloat(b.faturamento) ? a : b).label : null,
        pior_dia_semana: dayOfWeek.length > 0 ? dayOfWeek.reduce((a,b) => parseFloat(a.faturamento) < parseFloat(b.faturamento) ? a : b).label : null,
        ticket_medio_geral: completedMonths.length > 0 ? Math.round(completedMonths.reduce((s,m)=>s+parseFloat(m.receita),0) / completedMonths.reduce((s,m)=>s+parseInt(m.qtd_vendas),0) * 100)/100 : 0,
      },
    });
  } catch (err) { console.error('financial analysis error:', err); res.status(500).json({ error: 'Erro ao gerar analise financeira' }); }
});

module.exports = router;
