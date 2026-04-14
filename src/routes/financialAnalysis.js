// ============================================================
// AURA. — P2 #2: Financial Analysis Endpoint
// FEAT: employee ranking from BOTH sales table AND transactions.employee_name
// This ensures historical imported data with vendedor shows in analysis
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { months = 7 } = req.query;
  const numMonths = Math.min(Math.max(parseInt(months) || 7, 3), 24);

  try {
    const { rows: monthly } = await db.query(
      `SELECT TO_CHAR(created_at, 'YYYY-MM') AS month, TO_CHAR(created_at, 'Mon/YY') AS label,
         COALESCE(SUM(amount) FILTER (WHERE type='income'),0) AS receita,
         COALESCE(SUM(amount) FILTER (WHERE type='expense'),0) AS despesa,
         COUNT(*) FILTER (WHERE type='income') AS qtd_vendas,
         COUNT(*) FILTER (WHERE type='expense') AS qtd_despesas,
         COUNT(*) AS total_lancamentos
       FROM transactions WHERE company_id=$1
         AND created_at >= date_trunc('month',NOW())-(($2::int-1)||' months')::interval
       GROUP BY month, label ORDER BY month ASC`, [cid, numMonths]);

    const { rows: currentMonth } = await db.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE type='income'),0) AS receita,
         COALESCE(SUM(amount) FILTER (WHERE type='expense'),0) AS despesa,
         COUNT(*) FILTER (WHERE type='income') AS qtd_vendas,
         COUNT(*) AS total_lancamentos
       FROM transactions WHERE company_id=$1
         AND created_at >= date_trunc('month',NOW())
         AND created_at < date_trunc('month',NOW())+INTERVAL '1 month'`, [cid]);

    const { rows: prevMonth } = await db.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE type='income'),0) AS receita,
         COALESCE(SUM(amount) FILTER (WHERE type='expense'),0) AS despesa,
         COUNT(*) FILTER (WHERE type='income') AS qtd_vendas
       FROM transactions WHERE company_id=$1
         AND created_at >= date_trunc('month',NOW())-INTERVAL '1 month'
         AND created_at < date_trunc('month',NOW())`, [cid]);

    const { rows: categories } = await db.query(
      `SELECT type, COALESCE(category,'Outros') AS category, SUM(amount) AS total, COUNT(*) AS count
       FROM transactions WHERE company_id=$1
         AND created_at >= date_trunc('month',NOW())
         AND created_at < date_trunc('month',NOW())+INTERVAL '1 month'
       GROUP BY type, category ORDER BY total DESC`, [cid]);

    const { rows: categoriesAll } = await db.query(
      `SELECT type, COALESCE(category,'Outros') AS category, SUM(amount) AS total, COUNT(*) AS count
       FROM transactions WHERE company_id=$1
         AND created_at >= date_trunc('month',NOW())-(($2::int-1)||' months')::interval
       GROUP BY type, category ORDER BY total DESC`, [cid, numMonths]);

    // Employee ranking: UNION sales table + transactions.employee_name
    // This captures both PDV sales (with employee_id) and imported transactions (with employee_name)
    let employeeRanking = [];
    try {
      const { rows } = await db.query(
        `SELECT name, SUM(total_sales) AS total_sales, SUM(total_revenue) AS total_revenue,
           ROUND((SUM(total_revenue)/NULLIF(SUM(total_sales),0))::numeric,2) AS avg_ticket
         FROM (
           -- Source 1: sales table (PDV)
           SELECT COALESCE(e.name,'Sem vendedor') AS name,
             COUNT(s.id) AS total_sales, COALESCE(SUM(s.total_amount),0) AS total_revenue
           FROM sales s LEFT JOIN employees e ON e.id=s.employee_id
           WHERE s.company_id=$1 AND s.created_at >= NOW()-INTERVAL '30 days'
           GROUP BY e.name
           UNION ALL
           -- Source 2: transactions with employee_name (imported data)
           SELECT COALESCE(t.employee_name,'Sem vendedor') AS name,
             COUNT(t.id) AS total_sales, COALESCE(SUM(t.amount),0) AS total_revenue
           FROM transactions t
           WHERE t.company_id=$1 AND t.type='income' AND t.employee_name IS NOT NULL
             AND t.created_at >= NOW()-INTERVAL '30 days'
           GROUP BY t.employee_name
         ) combined
         GROUP BY name ORDER BY total_revenue DESC`, [cid]);
      employeeRanking = rows;
    } catch (_) {}

    // Employee ranking previous period
    let employeeRankingPrev = [];
    try {
      const { rows } = await db.query(
        `SELECT name, SUM(total_sales) AS total_sales, SUM(total_revenue) AS total_revenue
         FROM (
           SELECT COALESCE(e.name,'Sem vendedor') AS name,
             COUNT(s.id) AS total_sales, COALESCE(SUM(s.total_amount),0) AS total_revenue
           FROM sales s LEFT JOIN employees e ON e.id=s.employee_id
           WHERE s.company_id=$1 AND s.created_at >= NOW()-INTERVAL '60 days' AND s.created_at < NOW()-INTERVAL '30 days'
           GROUP BY e.name
           UNION ALL
           SELECT COALESCE(t.employee_name,'Sem vendedor') AS name,
             COUNT(t.id) AS total_sales, COALESCE(SUM(t.amount),0) AS total_revenue
           FROM transactions t
           WHERE t.company_id=$1 AND t.type='income' AND t.employee_name IS NOT NULL
             AND t.created_at >= NOW()-INTERVAL '60 days' AND t.created_at < NOW()-INTERVAL '30 days'
           GROUP BY t.employee_name
         ) combined
         GROUP BY name ORDER BY total_revenue DESC`, [cid]);
      employeeRankingPrev = rows;
    } catch (_) {}

    // Employee ranking ALL TIME (for full period analysis)
    let employeeRankingAll = [];
    try {
      const { rows } = await db.query(
        `SELECT name, SUM(total_sales) AS total_sales, SUM(total_revenue) AS total_revenue,
           ROUND((SUM(total_revenue)/NULLIF(SUM(total_sales),0))::numeric,2) AS avg_ticket
         FROM (
           SELECT COALESCE(e.name,'Sem vendedor') AS name,
             COUNT(s.id) AS total_sales, COALESCE(SUM(s.total_amount),0) AS total_revenue
           FROM sales s LEFT JOIN employees e ON e.id=s.employee_id
           WHERE s.company_id=$1 AND s.created_at >= date_trunc('month',NOW())-(($2::int-1)||' months')::interval
           GROUP BY e.name
           UNION ALL
           SELECT COALESCE(t.employee_name,'Sem vendedor') AS name,
             COUNT(t.id) AS total_sales, COALESCE(SUM(t.amount),0) AS total_revenue
           FROM transactions t
           WHERE t.company_id=$1 AND t.type='income' AND t.employee_name IS NOT NULL
             AND t.created_at >= date_trunc('month',NOW())-(($2::int-1)||' months')::interval
           GROUP BY t.employee_name
         ) combined
         GROUP BY name ORDER BY total_revenue DESC`, [cid, numMonths]);
      employeeRankingAll = rows;
    } catch (_) {}

    // Compute metrics
    const cur = currentMonth[0] || {};
    const prev = prevMonth[0] || {};
    const curReceita = parseFloat(cur.receita) || 0;
    const curDespesa = parseFloat(cur.despesa) || 0;
    const curBalance = curReceita - curDespesa;
    const curVendas = parseInt(cur.qtd_vendas) || 0;
    const prevReceita = parseFloat(prev.receita) || 0;
    const prevDespesa = parseFloat(prev.despesa) || 0;
    const prevBalance = prevReceita - prevDespesa;
    const prevVendas = parseInt(prev.qtd_vendas) || 0;

    const receitaGrowth = prevReceita > 0 ? ((curReceita-prevReceita)/prevReceita*100) : 0;
    const despesaGrowth = prevDespesa > 0 ? ((curDespesa-prevDespesa)/prevDespesa*100) : 0;
    const vendasGrowth = prevVendas > 0 ? ((curVendas-prevVendas)/prevVendas*100) : 0;
    const marginPct = curReceita > 0 ? ((curBalance/curReceita)*100) : 0;
    const avgTicket = curVendas > 0 ? curReceita/curVendas : 0;
    const prevAvgTicket = prevVendas > 0 ? prevReceita/prevVendas : 0;

    const completedMonths = monthly.filter(m => new Date(m.month+'-01') < new Date(new Date().getFullYear(),new Date().getMonth(),1));
    const avgMonthlyReceita = completedMonths.length > 0 ? completedMonths.reduce((s,m)=>s+parseFloat(m.receita),0)/completedMonths.length : 0;
    const avgMonthlyDespesa = completedMonths.length > 0 ? completedMonths.reduce((s,m)=>s+parseFloat(m.despesa),0)/completedMonths.length : 0;

    const sortedByReceita = [...completedMonths].sort((a,b)=>parseFloat(b.receita)-parseFloat(a.receita));
    const bestMonth = sortedByReceita[0] || null;
    const worstMonth = sortedByReceita[sortedByReceita.length-1] || null;

    res.json({
      monthly: monthly.map(m => ({ month: m.month, label: m.label, receita: parseFloat(m.receita), despesa: parseFloat(m.despesa), resultado: parseFloat(m.receita)-parseFloat(m.despesa), qtd_vendas: parseInt(m.qtd_vendas), margem_pct: parseFloat(m.receita) > 0 ? Math.round((parseFloat(m.receita)-parseFloat(m.despesa))/parseFloat(m.receita)*100) : 0 })),
      current: { receita: curReceita, despesa: curDespesa, resultado: curBalance, vendas: curVendas, margem_pct: Math.round(marginPct), avg_ticket: Math.round(avgTicket*100)/100, lancamentos: parseInt(cur.total_lancamentos)||0 },
      previous: { receita: prevReceita, despesa: prevDespesa, resultado: prevBalance, vendas: prevVendas, avg_ticket: Math.round(prevAvgTicket*100)/100 },
      growth: { receita_pct: Math.round(receitaGrowth*10)/10, despesa_pct: Math.round(despesaGrowth*10)/10, vendas_pct: Math.round(vendasGrowth*10)/10 },
      categories: { income: categories.filter(c=>c.type==='income').map(c=>({category:c.category,total:parseFloat(c.total),count:parseInt(c.count)})), expense: categories.filter(c=>c.type==='expense').map(c=>({category:c.category,total:parseFloat(c.total),count:parseInt(c.count)})) },
      categoriesAll: { income: categoriesAll.filter(c=>c.type==='income').map(c=>({category:c.category,total:parseFloat(c.total),count:parseInt(c.count)})), expense: categoriesAll.filter(c=>c.type==='expense').map(c=>({category:c.category,total:parseFloat(c.total),count:parseInt(c.count)})) },
      employees: employeeRanking.map(e => ({ name: e.name, total_sales: parseInt(e.total_sales), total_revenue: parseFloat(e.total_revenue), avg_ticket: parseFloat(e.avg_ticket||0) })),
      employeesPrev: employeeRankingPrev.map(e => ({ name: e.name, total_sales: parseInt(e.total_sales), total_revenue: parseFloat(e.total_revenue) })),
      employeesAll: employeeRankingAll.map(e => ({ name: e.name, total_sales: parseInt(e.total_sales), total_revenue: parseFloat(e.total_revenue), avg_ticket: parseFloat(e.avg_ticket||0) })),
      insights: { avg_monthly_receita: Math.round(avgMonthlyReceita), avg_monthly_despesa: Math.round(avgMonthlyDespesa), avg_monthly_resultado: Math.round(avgMonthlyReceita-avgMonthlyDespesa), best_month: bestMonth ? { month: bestMonth.month, label: bestMonth.label, receita: parseFloat(bestMonth.receita) } : null, worst_month: worstMonth ? { month: worstMonth.month, label: worstMonth.label, receita: parseFloat(worstMonth.receita) } : null, total_receita_periodo: completedMonths.reduce((s,m)=>s+parseFloat(m.receita),0), total_despesa_periodo: completedMonths.reduce((s,m)=>s+parseFloat(m.despesa),0), meses_analisados: completedMonths.length },
    });
  } catch (err) { console.error('financial analysis error:', err); res.status(500).json({ error: 'Erro ao gerar analise financeira' }); }
});

module.exports = router;
