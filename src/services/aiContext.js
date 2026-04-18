// ============================================================
// AURA. — AI Context: real business data per agent context
// Fixed column names: stock_min (not min_stock_qty), price (not sell_price)
// ODT-11: Added odonto context
// ============================================================
const db = require('../config/database');

async function getContextData(companyId, context) {
  const data = {};
  try {
    switch (context) {
      case 'financeiro': {
        const { rows: [bal] } = await db.query(
          `SELECT
             COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS income,
             COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) AS expenses
           FROM transactions
           WHERE company_id=$1 AND due_date >= date_trunc('month', CURRENT_DATE)`, [companyId]);
        data.receita_mes = parseFloat(bal?.income || 0);
        data.despesa_mes = parseFloat(bal?.expenses || 0);
        data.saldo = data.receita_mes - data.despesa_mes;
        const { rows: vendas } = await db.query(
          `SELECT COUNT(*) AS total, COALESCE(SUM(total_amount),0) AS valor
           FROM sales WHERE company_id=$1 AND created_at >= date_trunc('month', CURRENT_DATE)`, [companyId]);
        data.vendas_mes = parseInt(vendas[0]?.total || 0);
        data.faturamento_vendas = parseFloat(vendas[0]?.valor || 0);
        const { rows: overdue } = await db.query(
          `SELECT description, amount, due_date FROM transactions
           WHERE company_id=$1 AND type='income' AND status='pending' AND due_date < CURRENT_DATE
           ORDER BY amount DESC LIMIT 5`, [companyId]);
        data.contas_a_receber_vencidas = overdue.map(r => ({ desc: r.description, valor: parseFloat(r.amount), venc: r.due_date }));
        break;
      }
      case 'estoque': {
        const { rows: low } = await db.query(
          `SELECT name, stock_qty, stock_min, price FROM products
           WHERE company_id=$1 AND stock_qty <= stock_min AND stock_min > 0
           ORDER BY stock_qty ASC LIMIT 10`, [companyId]);
        data.estoque_baixo = low.map(r => ({ nome: r.name, atual: parseInt(r.stock_qty), min: parseInt(r.stock_min), preco: parseFloat(r.price) }));
        const { rows: [stats] } = await db.query(
          `SELECT COUNT(*) AS total, COALESCE(SUM(stock_qty * cost_price),0) AS valor_total
           FROM products WHERE company_id=$1`, [companyId]);
        data.total_produtos = parseInt(stats?.total || 0);
        data.valor_estoque = parseFloat(stats?.valor_total || 0);
        const { rows: top } = await db.query(
          `SELECT p.name, COALESCE(SUM(si.quantity),0) AS vendidos
           FROM sale_items si JOIN products p ON p.id=si.product_id
           JOIN sales s ON s.id=si.sale_id
           WHERE s.company_id=$1 AND s.created_at >= NOW()-INTERVAL '30 days'
           GROUP BY p.name ORDER BY vendidos DESC LIMIT 5`, [companyId]);
        data.top_vendidos_30d = top.map(r => ({ nome: r.name, vendidos: parseInt(r.vendidos) }));
        break;
      }
      case 'crm': {
        const { rows: inactive } = await db.query(
          `SELECT name, phone, last_purchase_at, total_spent FROM customers
           WHERE company_id=$1 AND last_purchase_at < NOW()-INTERVAL '30 days' AND last_purchase_at IS NOT NULL
           ORDER BY total_spent DESC LIMIT 10`, [companyId]);
        data.clientes_inativos_30d = inactive.map(r => ({
          nome: r.name, telefone: r.phone, ultima_compra: r.last_purchase_at, total_gasto: parseFloat(r.total_spent),
        }));
        const { rows: [cstats] } = await db.query(
          `SELECT COUNT(*) AS total,
                  COUNT(CASE WHEN last_purchase_at >= NOW()-INTERVAL '30 days' THEN 1 END) AS ativos_30d
           FROM customers WHERE company_id=$1`, [companyId]);
        data.total_clientes = parseInt(cstats?.total || 0);
        data.clientes_ativos_30d = parseInt(cstats?.ativos_30d || 0);
        break;
      }
      case 'contabil': {
        const { rows: obls } = await db.query(
          `SELECT code, name, due_day, status, category FROM fiscal_obligations
           WHERE company_id=$1 AND status != 'done'
           ORDER BY due_day ASC LIMIT 10`, [companyId]);
        data.obrigacoes_pendentes = obls.map(r => ({
          codigo: r.code, nome: r.name, dia_venc: r.due_day, status: r.status, categoria: r.category,
        }));
        break;
      }
      case 'marketing': {
        const { rows: trend } = await db.query(
          `SELECT DATE(created_at) AS dia, COUNT(*) AS vendas, SUM(total_amount) AS valor
           FROM sales WHERE company_id=$1 AND created_at >= NOW()-INTERVAL '14 days'
           GROUP BY DATE(created_at) ORDER BY dia`, [companyId]);
        data.tendencia_vendas_14d = trend.map(r => ({ dia: r.dia, vendas: parseInt(r.vendas), valor: parseFloat(r.valor) }));
        const { rows: pop } = await db.query(
          `SELECT p.name, COUNT(si.id) AS vendidos FROM sale_items si
           JOIN products p ON p.id=si.product_id JOIN sales s ON s.id=si.sale_id
           WHERE s.company_id=$1 AND s.created_at >= NOW()-INTERVAL '30 days'
           GROUP BY p.name ORDER BY vendidos DESC LIMIT 5`, [companyId]);
        data.produtos_populares = pop.map(r => ({ nome: r.name, vendidos: parseInt(r.vendidos) }));
        break;
      }
      case 'odonto': {
        // Consultas do dia
        try {
          const { rows: [today] } = await db.query(
            `SELECT COUNT(*) AS total,
                    COUNT(CASE WHEN status='confirmed' THEN 1 END) AS confirmados,
                    COUNT(CASE WHEN status IN ('scheduled','pending') THEN 1 END) AS pendentes,
                    COUNT(CASE WHEN status='no_show' THEN 1 END) AS faltas
             FROM dental_appointments
             WHERE company_id=$1 AND (scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`, [companyId]);
          data.consultas_hoje = { total: parseInt(today?.total||0), confirmados: parseInt(today?.confirmados||0), pendentes: parseInt(today?.pendentes||0), faltas: parseInt(today?.faltas||0) };
        } catch (_) { data.consultas_hoje = { total: 0 }; }

        // Funil de leads
        try {
          const { rows: funnel } = await db.query(
            `SELECT stage, COUNT(*) AS cnt, COALESCE(SUM(treatment_value),0) AS valor
             FROM dental_leads WHERE company_id=$1 AND stage NOT IN ('completed','lost')
             GROUP BY stage`, [companyId]);
          data.funil_ativo = funnel.map(r => ({ stage: r.stage, qtd: parseInt(r.cnt), valor: parseFloat(r.valor) }));
          data.pipeline_total = funnel.reduce((s, r) => s + parseFloat(r.valor), 0);
        } catch (_) { data.funil_ativo = []; data.pipeline_total = 0; }

        // Parcelas vencidas
        try {
          const { rows: [ov] } = await db.query(
            `SELECT COUNT(*) AS cnt, COALESCE(SUM(tp.amount),0) AS valor
             FROM dental_treatment_payments tp
             JOIN dental_treatment_plans t ON t.id = tp.treatment_plan_id
             WHERE t.company_id=$1 AND tp.status='pending' AND tp.due_date < CURRENT_DATE`, [companyId]);
          data.parcelas_vencidas = { qtd: parseInt(ov?.cnt||0), valor: parseFloat(ov?.valor||0) };
        } catch (_) { data.parcelas_vencidas = { qtd: 0, valor: 0 }; }

        // Pacientes para recall
        try {
          const { rows: [recall] } = await db.query(
            `SELECT COUNT(*) AS cnt FROM dental_patients p
             WHERE p.company_id=$1
               AND (SELECT MAX(a.scheduled_at) FROM dental_appointments a WHERE a.patient_id=p.id AND a.status='completed') < NOW()-INTERVAL '150 days'`, [companyId]);
          data.pacientes_recall = parseInt(recall?.cnt || 0);
        } catch (_) { data.pacientes_recall = 0; }

        // Top procedimentos do mes
        try {
          const { rows: procs } = await db.query(
            `SELECT ap.procedure_name, COUNT(*) AS qtd, COALESCE(SUM(ap.final_price),0) AS receita
             FROM dental_appointment_procedures ap
             JOIN dental_appointments a ON a.id = ap.appointment_id
             WHERE a.company_id=$1 AND a.scheduled_at >= date_trunc('month', CURRENT_DATE)
             GROUP BY ap.procedure_name ORDER BY receita DESC LIMIT 5`, [companyId]);
          data.procedimentos_mes = procs.map(r => ({ nome: r.procedure_name, qtd: parseInt(r.qtd), receita: parseFloat(r.receita) }));
        } catch (_) { data.procedimentos_mes = []; }

        break;
      }
    }
  } catch (err) { console.error(`[aiContext] Error ${context}:`, err.message); }
  return data;
}

module.exports = { getContextData };
