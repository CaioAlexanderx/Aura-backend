// ============================================================
// AURA. — DRE Simplificado (P&L Statement)
// Gera DRE mensal baseado em transacoes reais
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// GET /dre-simples — DRE do mes atual ou especificado
router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { month } = req.query; // YYYY-MM
  const refMonth = month ? `${month}-01` : new Date().toISOString().slice(0, 7) + '-01';
  const monthEnd = new Date(new Date(refMonth).setMonth(new Date(refMonth).getMonth() + 1)).toISOString().slice(0, 10);

  try {
    // 1. Revenue (income transactions)
    const { rows: incomeRows } = await db.query(
      `SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS count
       FROM transactions WHERE company_id=$1 AND type='income'
         AND created_at >= $2 AND created_at < $3
       GROUP BY category ORDER BY total DESC`, [cid, refMonth, monthEnd]);

    // 2. Expenses (expense transactions)
    const { rows: expenseRows } = await db.query(
      `SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*)::int AS count
       FROM transactions WHERE company_id=$1 AND type='expense'
         AND created_at >= $2 AND created_at < $3
       GROUP BY category ORDER BY total DESC`, [cid, refMonth, monthEnd]);

    // 3. Cost of goods sold (from sale_items with unit_cost)
    const { rows: cogsRows } = await db.query(
      `SELECT COALESCE(SUM(si.unit_cost * si.quantity), 0) AS cogs,
         COALESCE(SUM(si.total_price), 0) AS revenue_pdv,
         COUNT(DISTINCT s.id)::int AS num_sales
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.company_id=$1 AND s.created_at >= $2 AND s.created_at < $3`, [cid, refMonth, monthEnd]);

    // 4. Tax estimates (DAS based on regime)
    const { rows: companyRows } = await db.query(
      `SELECT tax_regime, cnpj FROM companies WHERE id=$1`, [cid]);
    const regime = companyRows[0]?.tax_regime || 'mei';

    // Calculate
    const receitaBruta = incomeRows.reduce((s, r) => s + parseFloat(r.total), 0);
    const pdvRevenue = parseFloat(cogsRows[0]?.revenue_pdv) || 0;
    const totalReceita = receitaBruta + pdvRevenue;

    // Deductions (estimated taxes)
    const taxRate = regime === 'mei' ? 0 : regime === 'simples' ? 0.06 : 0.15;
    const impostos = Math.round(totalReceita * taxRate * 100) / 100;

    const receitaLiquida = totalReceita - impostos;
    const cogs = parseFloat(cogsRows[0]?.cogs) || 0;
    const lucroBruto = receitaLiquida - cogs;
    const margemBruta = totalReceita > 0 ? Math.round((lucroBruto / totalReceita) * 100 * 10) / 10 : 0;

    const despesasOp = expenseRows.reduce((s, r) => s + parseFloat(r.total), 0);
    const resultadoOp = lucroBruto - despesasOp;
    const resultadoLiquido = resultadoOp;
    const margemLiquida = totalReceita > 0 ? Math.round((resultadoLiquido / totalReceita) * 100 * 10) / 10 : 0;

    // DRE structure
    const dre = {
      month: refMonth,
      regime,
      lines: [
        { group: 'RECEITA', line: 'Receita bruta de vendas', value: receitaBruta, indent: 0 },
        { group: 'RECEITA', line: 'Receita PDV (caixa)', value: pdvRevenue, indent: 0 },
        { group: 'RECEITA', line: 'RECEITA BRUTA TOTAL', value: totalReceita, indent: 0, bold: true },
        { group: 'DEDUCOES', line: `Impostos estimados (${regime.toUpperCase()} ${(taxRate*100).toFixed(0)}%)`, value: -impostos, indent: 1 },
        { group: 'DEDUCOES', line: 'RECEITA LIQUIDA', value: receitaLiquida, indent: 0, bold: true },
        { group: 'CUSTOS', line: 'Custo dos produtos vendidos (CMV)', value: -cogs, indent: 1 },
        { group: 'CUSTOS', line: 'LUCRO BRUTO', value: lucroBruto, indent: 0, bold: true },
        { group: 'CUSTOS', line: `Margem bruta: ${margemBruta}%`, value: null, indent: 1, info: true },
      ],
    };

    // Add expense categories
    expenseRows.forEach(e => {
      dre.lines.push({ group: 'DESPESAS', line: e.category || 'Outros', value: -parseFloat(e.total), indent: 1 });
    });
    dre.lines.push({ group: 'DESPESAS', line: 'TOTAL DESPESAS OPERACIONAIS', value: -despesasOp, indent: 0, bold: true });
    dre.lines.push({ group: 'RESULTADO', line: 'RESULTADO OPERACIONAL', value: resultadoOp, indent: 0, bold: true });
    dre.lines.push({ group: 'RESULTADO', line: 'RESULTADO LIQUIDO', value: resultadoLiquido, indent: 0, bold: true, highlight: true });
    dre.lines.push({ group: 'RESULTADO', line: `Margem liquida: ${margemLiquida}%`, value: null, indent: 1, info: true });

    // Summary card
    const summary = {
      receita_bruta: totalReceita,
      impostos,
      receita_liquida: receitaLiquida,
      cmv: cogs,
      lucro_bruto: lucroBruto,
      margem_bruta_pct: margemBruta,
      despesas_operacionais: despesasOp,
      resultado_operacional: resultadoOp,
      resultado_liquido: resultadoLiquido,
      margem_liquida_pct: margemLiquida,
      num_vendas_pdv: parseInt(cogsRows[0]?.num_sales) || 0,
      num_lancamentos_receita: incomeRows.reduce((s, r) => s + r.count, 0),
      num_lancamentos_despesa: expenseRows.reduce((s, r) => s + r.count, 0),
    };

    // Health assessment
    const health = margemLiquida >= 20 ? 'saudavel' : margemLiquida >= 5 ? 'atencao' : resultadoLiquido < 0 ? 'critico' : 'apertado';
    const insights = [];
    if (margemBruta < 30) insights.push('Margem bruta abaixo de 30%. Revisar custos de produto ou precificacao.');
    if (margemLiquida < 10 && margemLiquida >= 0) insights.push('Margem liquida apertada. Avaliar reducao de despesas operacionais.');
    if (resultadoLiquido < 0) insights.push(`Resultado negativo de R$ ${Math.abs(resultadoLiquido).toFixed(2)}. O negocio esta operando no vermelho.`);
    if (cogs === 0 && pdvRevenue > 0) insights.push('CMV zerado — cadastre o custo dos produtos para calcular a margem real.');
    if (despesasOp > lucroBruto && lucroBruto > 0) insights.push('Despesas operacionais superam o lucro bruto. Faturamento precisa crescer ou despesas reduzir.');

    res.json({ dre, summary, health, insights, income_categories: incomeRows, expense_categories: expenseRows });
  } catch (err) { console.error('dre simples error:', err); res.status(500).json({ error: 'Erro ao gerar DRE' }); }
});

// GET /dre-simples/evolution — DRE mensal dos ultimos N meses
router.get('/evolution', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { months = 6 } = req.query;
  const numMonths = Math.min(Math.max(parseInt(months) || 6, 3), 24);
  try {
    const { rows } = await db.query(
      `SELECT TO_CHAR(date_trunc('month', created_at), 'YYYY-MM') AS month,
         TO_CHAR(date_trunc('month', created_at), 'Mon/YY') AS label,
         COALESCE(SUM(amount) FILTER(WHERE type='income'), 0) AS receita,
         COALESCE(SUM(amount) FILTER(WHERE type='expense'), 0) AS despesa,
         COUNT(*) FILTER(WHERE type='income') AS qtd_receitas,
         COUNT(*) FILTER(WHERE type='expense') AS qtd_despesas
       FROM transactions WHERE company_id=$1
         AND created_at >= date_trunc('month', NOW()) - (($2::int || ' months')::interval)
       GROUP BY month, label ORDER BY month`, [cid, numMonths]);

    // Add COGS per month from sales
    const { rows: cogsMonthly } = await db.query(
      `SELECT TO_CHAR(date_trunc('month', s.created_at), 'YYYY-MM') AS month,
         COALESCE(SUM(si.unit_cost * si.quantity), 0) AS cogs,
         COALESCE(SUM(si.total_price), 0) AS pdv_revenue
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE s.company_id=$1
         AND s.created_at >= date_trunc('month', NOW()) - (($2::int || ' months')::interval)
       GROUP BY month ORDER BY month`, [cid, numMonths]);

    const evolution = rows.map(r => {
      const cogs = cogsMonthly.find(c => c.month === r.month);
      const receita = parseFloat(r.receita) + parseFloat(cogs?.pdv_revenue || 0);
      const cmv = parseFloat(cogs?.cogs || 0);
      const despesa = parseFloat(r.despesa);
      const lucro_bruto = receita - cmv;
      const resultado = lucro_bruto - despesa;
      return {
        month: r.month, label: r.label, receita, cmv, lucro_bruto, despesa, resultado,
        margem_bruta: receita > 0 ? Math.round(lucro_bruto / receita * 100 * 10) / 10 : 0,
        margem_liquida: receita > 0 ? Math.round(resultado / receita * 100 * 10) / 10 : 0,
      };
    });

    res.json({ months: evolution, period: numMonths });
  } catch (err) { console.error('dre evolution error:', err); res.status(500).json({ error: 'Erro' }); }
});

module.exports = router;
