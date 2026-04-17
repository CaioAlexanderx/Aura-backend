// ============================================================
// AURA. — Analise Financeira v5
// FIX: employees query unified (sales only, no UNION ALL dupe)
// FIX: timezone SP, period filter consistency
// ============================================================
var router = require('express').Router({ mergeParams: true });
var db = require('../config/database');
var { requireAuth } = require('../middleware/auth');

var MONTH_MAP = { Jan: 'Jan', Feb: 'Fev', Mar: 'Mar', Apr: 'Abr', May: 'Mai', Jun: 'Jun', Jul: 'Jul', Aug: 'Ago', Sep: 'Set', Oct: 'Out', Nov: 'Nov', Dec: 'Dez' };
var DOW_MAP = { Sun: 'Dom', Mon: 'Seg', Tue: 'Ter', Wed: 'Qua', Thu: 'Qui', Fri: 'Sex', Sat: 'Sab' };

function labelPtBR(enLabel) {
  if (!enLabel) return enLabel;
  var parts = enLabel.split('/');
  if (parts.length === 2 && MONTH_MAP[parts[0]]) return MONTH_MAP[parts[0]] + '/' + parts[1];
  return MONTH_MAP[enLabel] || DOW_MAP[enLabel] || enLabel;
}
function dowPtBR(enDay) { return DOW_MAP[enDay] || enDay; }

function periodToDateRange(period) {
  switch (period) {
    case 'week':
      return { interval: "7 days", months: 1, label: 'Ultimos 7 dias' };
    case 'month':
      return { interval: null, months: 1, useMonthTrunc: true, label: 'Mes atual' };
    case 'year':
      return { interval: null, months: 12, label: 'Ultimos 12 meses' };
    case 'prev_year': {
      var now = new Date();
      var prevY = now.getFullYear() - 1;
      return { interval: null, months: 24, from: prevY + '-01-01', to: prevY + '-12-31', label: 'Ano anterior (' + prevY + ')' };
    }
    default:
      return { interval: null, months: 13, label: 'Padrao' };
  }
}

function buildDateSQL(period) {
  var range = periodToDateRange(period);
  if (range.from && range.to) {
    return "created_at >= '" + range.from + "' AND created_at <= '" + range.to + " 23:59:59'";
  }
  if (period === 'week') {
    return "created_at >= NOW() - INTERVAL '7 days'";
  }
  if (period === 'month') {
    // Timezone-aware: start of month in SP
    return "created_at >= (date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')";
  }
  return "created_at >= date_trunc('month',NOW())-((" + range.months + "-1)||' months')::interval";
}

router.get('/', requireAuth, async function(req, res) {
  var cid = req.params.id;
  var period = req.query.period;
  var range = periodToDateRange(period);
  var dateSQL = buildDateSQL(period);

  try {
    // Monthly breakdown
    var monthly;
    if (period === 'week') {
      monthly = (await db.query(
        "SELECT TO_CHAR(created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS month, TO_CHAR(created_at AT TIME ZONE 'America/Sao_Paulo','DD/MM') AS label," +
        " COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita," +
        " COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa," +
        " COUNT(*) FILTER(WHERE type='income') AS qtd_vendas," +
        " 1 AS dias_com_venda" +
        " FROM transactions WHERE company_id=$1 AND " + dateSQL +
        " GROUP BY month, label ORDER BY month ASC", [cid])).rows;
    } else {
      monthly = (await db.query(
        "SELECT TO_CHAR(created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS month, TO_CHAR(created_at AT TIME ZONE 'America/Sao_Paulo','Mon/YY') AS label," +
        " COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita," +
        " COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa," +
        " COUNT(*) FILTER(WHERE type='income') AS qtd_vendas," +
        " COUNT(DISTINCT DATE(created_at AT TIME ZONE 'America/Sao_Paulo')) FILTER(WHERE type='income') AS dias_com_venda" +
        " FROM transactions WHERE company_id=$1 AND " + dateSQL +
        " GROUP BY month, label ORDER BY month ASC", [cid])).rows;
    }

    var currentMonth = (await db.query(
      "SELECT COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita," +
      " COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa," +
      " COUNT(*) FILTER(WHERE type='income') AS qtd_vendas," +
      " COUNT(*) AS total_lancamentos," +
      " COUNT(DISTINCT DATE(created_at AT TIME ZONE 'America/Sao_Paulo')) FILTER(WHERE type='income') AS dias_com_venda" +
      " FROM transactions WHERE company_id=$1 AND " + dateSQL, [cid])).rows;

    // Previous period
    var prevSQL;
    if (period === 'week') {
      prevSQL = "created_at >= NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days'";
    } else if (range.from && range.to) {
      var prevY = parseInt(range.from.slice(0, 4)) - 1;
      prevSQL = "created_at >= '" + prevY + "-01-01' AND created_at <= '" + prevY + "-12-31 23:59:59'";
    } else if (period === 'month') {
      prevSQL = "created_at >= (date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '1 month') AT TIME ZONE 'America/Sao_Paulo' AND created_at < (date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo')";
    } else {
      prevSQL = "created_at >= date_trunc('month',NOW())-INTERVAL '1 month' AND created_at < date_trunc('month',NOW())";
    }

    var prevMonth = (await db.query(
      "SELECT COALESCE(SUM(amount) FILTER(WHERE type='income'),0) AS receita," +
      " COALESCE(SUM(amount) FILTER(WHERE type='expense'),0) AS despesa," +
      " COUNT(*) FILTER(WHERE type='income') AS qtd_vendas" +
      " FROM transactions WHERE company_id=$1 AND " + prevSQL, [cid])).rows;

    var dayOfWeek = (await db.query(
      "SELECT EXTRACT(DOW FROM created_at AT TIME ZONE 'America/Sao_Paulo')::int AS dow," +
      " TO_CHAR(created_at AT TIME ZONE 'America/Sao_Paulo','Dy') AS label," +
      " COUNT(*) AS vendas," +
      " COALESCE(SUM(amount),0) AS faturamento," +
      " ROUND(AVG(amount)::numeric,2) AS ticket_medio" +
      " FROM transactions WHERE company_id=$1 AND type='income' AND " + dateSQL +
      " GROUP BY dow, label ORDER BY dow", [cid])).rows;

    // ====================================================================
    // FIX v5: EMPLOYEES — source ONLY from sales table, NO UNION ALL
    // The old UNION ALL with transactions caused double-counting because:
    // 1) PDV creates both a sale AND a transaction
    // 2) transaction.employee_name is free text (first name only)
    // 3) sales.employee_id joins to employees.name (full name)
    // Result: same person counted twice with different names
    // ====================================================================
    var employees = [];
    try {
      // FIX: total_revenue from sales table (authoritative source for PDV)
      var salesDateSQL = dateSQL; // same period filter
      employees = (await db.query(
        "SELECT COALESCE(e.name,'Sem vendedor') AS name," +
        " COUNT(s.id)::int AS vendas," +
        " COALESCE(SUM(s.total_amount),0) AS faturamento," +
        " ROUND((COALESCE(SUM(s.total_amount),0)/NULLIF(COUNT(s.id),0))::numeric,2) AS ticket_medio," +
        " ROUND((COALESCE(SUM(s.total_amount),0)*100.0/NULLIF((SELECT SUM(total_amount) FROM sales WHERE company_id=$1 AND " + salesDateSQL + "),0))::numeric,1) AS pct_total" +
        " FROM sales s LEFT JOIN employees e ON e.id=s.employee_id" +
        " WHERE s.company_id=$1 AND s." + salesDateSQL +
        " GROUP BY e.name" +
        " HAVING COUNT(s.id) > 0" +
        " ORDER BY faturamento DESC", [cid])).rows;
    } catch (_) {}

    // Employee monthly evolution (also from sales only)
    var employeeMonthly = [];
    try {
      if (period === 'week') {
        employeeMonthly = (await db.query(
          "SELECT TO_CHAR(s.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS month, COALESCE(e.name,'Sem vendedor') AS name," +
          " COUNT(s.id)::int AS vendas, COALESCE(SUM(s.total_amount),0) AS faturamento" +
          " FROM sales s LEFT JOIN employees e ON e.id=s.employee_id" +
          " WHERE s.company_id=$1 AND s." + dateSQL +
          " GROUP BY month, name HAVING COUNT(s.id) > 0 ORDER BY month", [cid])).rows;
      } else {
        employeeMonthly = (await db.query(
          "SELECT TO_CHAR(s.created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS month, COALESCE(e.name,'Sem vendedor') AS name," +
          " COUNT(s.id)::int AS vendas, COALESCE(SUM(s.total_amount),0) AS faturamento" +
          " FROM sales s LEFT JOIN employees e ON e.id=s.employee_id" +
          " WHERE s.company_id=$1 AND s." + dateSQL +
          " GROUP BY month, name HAVING COUNT(s.id) > 0 ORDER BY month", [cid])).rows;
      }
    } catch (_) {}

    var topCustomers = [];
    try {
      topCustomers = (await db.query(
        "SELECT description AS cliente, COUNT(*) AS compras, SUM(amount) AS total_gasto," +
        " ROUND(AVG(amount)::numeric,2) AS ticket_medio," +
        " MIN(created_at) AS primeira_compra, MAX(created_at) AS ultima_compra" +
        " FROM transactions WHERE company_id=$1 AND type='income' AND " + dateSQL +
        " AND description LIKE 'Venda %'" +
        " GROUP BY description HAVING COUNT(*) >= 2" +
        " ORDER BY total_gasto DESC LIMIT 20", [cid])).rows;
    } catch (_) {}

    var velocityRows = (await db.query(
      "SELECT" +
      " (SELECT ROUND(AVG(daily_total)::numeric,2) FROM (SELECT DATE(created_at AT TIME ZONE 'America/Sao_Paulo'), SUM(amount) AS daily_total FROM transactions WHERE company_id=$1 AND type='income' AND created_at >= NOW()-INTERVAL '30 days' GROUP BY DATE(created_at AT TIME ZONE 'America/Sao_Paulo')) d30) AS avg_dia_30d," +
      " (SELECT ROUND(AVG(daily_total)::numeric,2) FROM (SELECT DATE(created_at AT TIME ZONE 'America/Sao_Paulo'), SUM(amount) AS daily_total FROM transactions WHERE company_id=$1 AND type='income' AND created_at >= NOW()-INTERVAL '7 days' GROUP BY DATE(created_at AT TIME ZONE 'America/Sao_Paulo')) d7) AS avg_dia_7d," +
      " (SELECT ROUND(AVG(daily_count)::numeric,1) FROM (SELECT DATE(created_at AT TIME ZONE 'America/Sao_Paulo'), COUNT(*) AS daily_count FROM transactions WHERE company_id=$1 AND type='income' AND created_at >= NOW()-INTERVAL '30 days' GROUP BY DATE(created_at AT TIME ZONE 'America/Sao_Paulo')) c30) AS avg_vendas_dia_30d", [cid])).rows;

    var ticketDist = (await db.query(
      "SELECT CASE WHEN amount<50 THEN 'Ate R$50' WHEN amount<100 THEN 'R$50-100' WHEN amount<150 THEN 'R$100-150' WHEN amount<200 THEN 'R$150-200' WHEN amount<300 THEN 'R$200-300' WHEN amount<500 THEN 'R$300-500' ELSE 'Acima R$500' END AS faixa," +
      " COUNT(*) AS vendas, COALESCE(SUM(amount),0) AS faturamento, ROUND(AVG(amount)::numeric,2) AS ticket_medio" +
      " FROM transactions WHERE company_id=$1 AND type='income' AND " + dateSQL +
      " GROUP BY faixa ORDER BY MIN(amount)", [cid])).rows;

    var weeklyTrend = (await db.query(
      "SELECT TO_CHAR(date_trunc('week',created_at AT TIME ZONE 'America/Sao_Paulo'),'DD/MM') AS semana," +
      " date_trunc('week',created_at AT TIME ZONE 'America/Sao_Paulo') AS week_start," +
      " COUNT(*) AS vendas, COALESCE(SUM(amount),0) AS faturamento," +
      " ROUND(AVG(amount)::numeric,2) AS ticket_medio" +
      " FROM transactions WHERE company_id=$1 AND type='income' AND " + dateSQL +
      " GROUP BY semana, week_start ORDER BY week_start", [cid])).rows;

    var incomeCategories = [];
    var expenseCategories = [];
    try {
      incomeCategories = (await db.query(
        "SELECT COALESCE(category,'Outros') AS category, COALESCE(SUM(amount),0) AS total, COUNT(*)::int AS count" +
        " FROM transactions WHERE company_id=$1 AND type='income' AND " + dateSQL +
        " GROUP BY category ORDER BY total DESC", [cid])).rows;
      expenseCategories = (await db.query(
        "SELECT COALESCE(category,'Outros') AS category, COALESCE(SUM(amount),0) AS total, COUNT(*)::int AS count" +
        " FROM transactions WHERE company_id=$1 AND type='expense' AND " + dateSQL +
        " GROUP BY category ORDER BY total DESC", [cid])).rows;
    } catch (_) {}

    // Compute metrics
    var cur = currentMonth[0] || {};
    var prev = prevMonth[0] || {};
    var curReceita = parseFloat(cur.receita) || 0;
    var curDespesa = parseFloat(cur.despesa) || 0;
    var curVendas = parseInt(cur.qtd_vendas) || 0;
    var prevReceita = parseFloat(prev.receita) || 0;
    var prevDespesa = parseFloat(prev.despesa) || 0;
    var prevVendas = parseInt(prev.qtd_vendas) || 0;

    var receitaGrowth = prevReceita > 0 ? ((curReceita - prevReceita) / prevReceita * 100) : 0;
    var despesaGrowth = prevDespesa > 0 ? ((curDespesa - prevDespesa) / prevDespesa * 100) : 0;
    var vendasGrowth = prevVendas > 0 ? ((curVendas - prevVendas) / prevVendas * 100) : 0;
    var marginPct = curReceita > 0 ? (((curReceita - curDespesa) / curReceita) * 100) : 0;
    var avgTicket = curVendas > 0 ? curReceita / curVendas : 0;
    var prevAvgTicket = prevVendas > 0 ? prevReceita / prevVendas : 0;

    var completedMonths = monthly.filter(function(m) {
      if (period === 'week') return true;
      return new Date(m.month + '-01') < new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    });
    var avgMonthlyReceita = completedMonths.length > 0 ? completedMonths.reduce(function(s, m) { return s + parseFloat(m.receita); }, 0) / completedMonths.length : 0;
    var avgMonthlyDespesa = completedMonths.length > 0 ? completedMonths.reduce(function(s, m) { return s + parseFloat(m.despesa); }, 0) / completedMonths.length : 0;

    var sortedByReceita = completedMonths.slice().sort(function(a, b) { return parseFloat(b.receita) - parseFloat(a.receita); });
    var bestMonth = sortedByReceita[0] || null;
    var worstMonth = sortedByReceita[sortedByReceita.length - 1] || null;

    var vel = velocityRows[0] || {};
    var avgDia30d = parseFloat(vel.avg_dia_30d) || 0;
    var avgDia7d = parseFloat(vel.avg_dia_7d) || 0;
    var velocityTrend = avgDia30d > 0 ? ((avgDia7d - avgDia30d) / avgDia30d * 100) : 0;

    var now = new Date();
    var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var diasCorridos = parseInt(cur.dias_com_venda) || now.getDate();
    var projectedMonthly = diasCorridos > 0 ? (curReceita / diasCorridos) * daysInMonth : 0;

    var bestDow = dayOfWeek.length > 0 ? dayOfWeek.reduce(function(a, b) { return parseFloat(a.faturamento) > parseFloat(b.faturamento) ? a : b; }) : null;
    var worstDow = dayOfWeek.length > 0 ? dayOfWeek.reduce(function(a, b) { return parseFloat(a.faturamento) < parseFloat(b.faturamento) ? a : b; }) : null;
    var DOW_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

    res.json({
      period: period || 'default',
      period_label: range.label,
      monthly: monthly.map(function(m) {
        return {
          month: m.month, label: period === 'week' ? m.label : labelPtBR(m.label),
          receita: parseFloat(m.receita), despesa: parseFloat(m.despesa),
          resultado: parseFloat(m.receita) - parseFloat(m.despesa),
          qtd_vendas: parseInt(m.qtd_vendas),
          dias_com_venda: parseInt(m.dias_com_venda) || 0,
          ticket_medio: parseInt(m.qtd_vendas) > 0 ? Math.round(parseFloat(m.receita) / parseInt(m.qtd_vendas) * 100) / 100 : 0,
          margem_pct: parseFloat(m.receita) > 0 ? Math.round((parseFloat(m.receita) - parseFloat(m.despesa)) / parseFloat(m.receita) * 100) : 0,
        };
      }),
      current: { receita: curReceita, despesa: curDespesa, resultado: curReceita - curDespesa, vendas: curVendas, margem_pct: Math.round(marginPct), avg_ticket: Math.round(avgTicket * 100) / 100, lancamentos: parseInt(cur.total_lancamentos) || 0, projecao_mes: Math.round(projectedMonthly) },
      previous: { receita: prevReceita, despesa: prevDespesa, resultado: prevReceita - prevDespesa, vendas: prevVendas, avg_ticket: Math.round(prevAvgTicket * 100) / 100 },
      growth: { receita_pct: Math.round(receitaGrowth * 10) / 10, despesa_pct: Math.round(despesaGrowth * 10) / 10, vendas_pct: Math.round(vendasGrowth * 10) / 10 },
      velocity: { media_dia_30d: avgDia30d, media_dia_7d: avgDia7d, tendencia_pct: Math.round(velocityTrend * 10) / 10, vendas_por_dia: parseFloat(vel.avg_vendas_dia_30d) || 0, projecao_mes: Math.round(projectedMonthly) },
      dayOfWeek: dayOfWeek.map(function(d) {
        return { dow: d.dow, label: dowPtBR(d.label), vendas: parseInt(d.vendas), faturamento: parseFloat(d.faturamento), ticket_medio: parseFloat(d.ticket_medio) };
      }),
      ticketDistribution: ticketDist.map(function(t) { return { faixa: t.faixa, vendas: parseInt(t.vendas), faturamento: parseFloat(t.faturamento), ticket_medio: parseFloat(t.ticket_medio) }; }),
      weeklyTrend: weeklyTrend.map(function(w) { return { semana: w.semana, vendas: parseInt(w.vendas), faturamento: parseFloat(w.faturamento), ticket_medio: parseFloat(w.ticket_medio) }; }),
      employees: employees.map(function(e) { return { name: e.name, vendas: parseInt(e.vendas), faturamento: parseFloat(e.faturamento), ticket_medio: parseFloat(e.ticket_medio), pct_total: parseFloat(e.pct_total) || 0 }; }),
      employeeMonthly: employeeMonthly.map(function(e) { return { month: e.month, name: e.name, vendas: parseInt(e.vendas), faturamento: parseFloat(e.faturamento) }; }),
      topCustomers: topCustomers.map(function(c) { return { cliente: c.cliente.replace('Venda ', ''), compras: parseInt(c.compras), total_gasto: parseFloat(c.total_gasto), ticket_medio: parseFloat(c.ticket_medio), primeira_compra: c.primeira_compra, ultima_compra: c.ultima_compra }; }),
      categories: { income: incomeCategories.map(function(c) { return { category: c.category, total: parseFloat(c.total), count: c.count }; }), expense: expenseCategories.map(function(c) { return { category: c.category, total: parseFloat(c.total), count: c.count }; }) },
      insights: {
        avg_monthly_receita: Math.round(avgMonthlyReceita), avg_monthly_despesa: Math.round(avgMonthlyDespesa), avg_monthly_resultado: Math.round(avgMonthlyReceita - avgMonthlyDespesa),
        best_month: bestMonth ? { month: bestMonth.month, label: period === 'week' ? bestMonth.label : labelPtBR(bestMonth.label), receita: parseFloat(bestMonth.receita) } : null,
        worst_month: worstMonth ? { month: worstMonth.month, label: period === 'week' ? worstMonth.label : labelPtBR(worstMonth.label), receita: parseFloat(worstMonth.receita) } : null,
        total_receita_periodo: completedMonths.reduce(function(s, m) { return s + parseFloat(m.receita); }, 0),
        total_despesa_periodo: completedMonths.reduce(function(s, m) { return s + parseFloat(m.despesa); }, 0),
        meses_analisados: completedMonths.length,
        melhor_dia_semana: bestDow ? DOW_NAMES[bestDow.dow] : null,
        pior_dia_semana: worstDow ? DOW_NAMES[worstDow.dow] : null,
        ticket_medio_geral: completedMonths.length > 0 ? Math.round(completedMonths.reduce(function(s, m) { return s + parseFloat(m.receita); }, 0) / Math.max(completedMonths.reduce(function(s, m) { return s + parseInt(m.qtd_vendas); }, 0), 1) * 100) / 100 : 0,
      },
    });
  } catch (err) { console.error('financial analysis error:', err); res.status(500).json({ error: 'Erro ao gerar analise financeira' }); }
});

module.exports = router;
