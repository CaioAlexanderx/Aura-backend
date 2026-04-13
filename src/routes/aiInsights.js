// ============================================================
// AURA. — AI Insights: proactive agent banners
// GET /companies/:id/ai/insights/:context
// Returns actionable insights without calling Claude
// Available for Negocio+ plans
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

router.get('/:context', async (req, res) => {
  const cid = req.params.id;
  const ctx = req.params.context || 'geral';
  const insights = [];

  try {
    switch (ctx) {
      case 'financeiro': {
        // Cobrancas em atraso
        const { rows: overdue } = await db.query(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS total
           FROM transactions WHERE company_id=$1 AND type='income' AND status='pending' AND due_date < CURRENT_DATE`, [cid]);
        if (parseInt(overdue[0]?.cnt) > 0) {
          insights.push({
            id: 'overdue', severity: 'warning', agent: 'Financeiro',
            title: `${overdue[0].cnt} cobranca${parseInt(overdue[0].cnt)>1?'s':''} em atraso`,
            description: `Total de R$ ${parseFloat(overdue[0].total).toFixed(2).replace('.',',')} em recebimentos vencidos.`,
            action: { type: 'navigate', target: '/financeiro', label: 'Ver lancamentos' },
          });
        }
        // Saldo negativo
        const { rows: [bal] } = await db.query(
          `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS saldo
           FROM transactions WHERE company_id=$1 AND due_date >= date_trunc('month', CURRENT_DATE)`, [cid]);
        if (parseFloat(bal?.saldo) < 0) {
          insights.push({
            id: 'negative-balance', severity: 'critical', agent: 'Financeiro',
            title: 'Saldo negativo no mes',
            description: `Despesas excedem receitas em R$ ${Math.abs(parseFloat(bal.saldo)).toFixed(2).replace('.',',')} este mes.`,
            action: { type: 'navigate', target: '/financeiro', label: 'Analisar' },
          });
        }
        break;
      }
      case 'estoque': {
        const { rows: low } = await db.query(
          `SELECT COUNT(*) AS cnt FROM products
           WHERE company_id=$1 AND stock_qty <= min_stock_qty AND min_stock_qty > 0`, [cid]);
        if (parseInt(low[0]?.cnt) > 0) {
          insights.push({
            id: 'low-stock', severity: 'warning', agent: 'Estoque',
            title: `${low[0].cnt} produto${parseInt(low[0].cnt)>1?'s':''} com estoque baixo`,
            description: 'Itens abaixo do estoque minimo precisam de reposicao.',
            action: { type: 'navigate', target: '/estoque', params: { tab: 2 }, label: 'Ver alertas' },
          });
        }
        // Produtos sem venda em 30 dias
        const { rows: [dead] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM products p
           WHERE p.company_id=$1 AND p.stock_qty > 0
             AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id=si.sale_id
                             WHERE si.product_id=p.id AND s.created_at >= NOW()-INTERVAL '30 days')`, [cid]);
        if (parseInt(dead?.cnt) > 5) {
          insights.push({
            id: 'dead-stock', severity: 'info', agent: 'Estoque',
            title: `${dead.cnt} produtos sem venda em 30 dias`,
            description: 'Considere criar promocoes para girar o estoque parado.',
            action: { type: 'navigate', target: '/estoque', label: 'Ver produtos' },
          });
        }
        break;
      }
      case 'crm': case 'clientes': {
        const { rows: [inact] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM customers
           WHERE company_id=$1 AND last_purchase_at < NOW()-INTERVAL '30 days' AND last_purchase_at IS NOT NULL`, [cid]);
        if (parseInt(inact?.cnt) > 0) {
          insights.push({
            id: 'inactive-customers', severity: 'warning', agent: 'CRM',
            title: `${inact.cnt} cliente${parseInt(inact.cnt)>1?'s':''} inativo${parseInt(inact.cnt)>1?'s':''}`,
            description: 'Clientes sem compra ha mais de 30 dias. Envie uma oferta para reativa-los.',
            action: { type: 'navigate', target: '/clientes', label: 'Ver clientes' },
          });
        }
        // Aniversarios esta semana
        const { rows: bday } = await db.query(
          `SELECT COUNT(*) AS cnt FROM customers
           WHERE company_id=$1 AND birth_date IS NOT NULL
             AND EXTRACT(MONTH FROM birth_date)=EXTRACT(MONTH FROM CURRENT_DATE)
             AND EXTRACT(DAY FROM birth_date) BETWEEN EXTRACT(DAY FROM CURRENT_DATE) AND EXTRACT(DAY FROM CURRENT_DATE)+7`, [cid]);
        if (parseInt(bday[0]?.cnt) > 0) {
          insights.push({
            id: 'birthdays', severity: 'info', agent: 'CRM',
            title: `${bday[0].cnt} aniversario${parseInt(bday[0].cnt)>1?'s':''} esta semana`,
            description: 'Envie parabens e uma oferta especial para fidelizar.',
            action: { type: 'navigate', target: '/clientes', label: 'Ver clientes' },
          });
        }
        break;
      }
      case 'contabil': case 'contabilidade': {
        const { rows: urgent } = await db.query(
          `SELECT code, name, due_day FROM fiscal_obligations
           WHERE company_id=$1 AND status IN ('pending','overdue')
             AND due_day <= EXTRACT(DAY FROM CURRENT_DATE) + 7
           ORDER BY due_day LIMIT 3`, [cid]);
        for (const ob of urgent) {
          insights.push({
            id: 'obligation-' + ob.code, severity: ob.due_day <= new Date().getDate() ? 'critical' : 'warning',
            agent: 'Contabil',
            title: `${ob.name} vence dia ${ob.due_day}`,
            description: `Obrigacao ${ob.code} precisa de atencao.`,
            action: { type: 'navigate', target: '/contabilidade', label: 'Ver guia' },
          });
        }
        break;
      }
      case 'folha': {
        const { rows: [emp] } = await db.query(
          `SELECT COUNT(*) AS cnt, COALESCE(SUM(base_salary),0) AS folha
           FROM employees WHERE company_id=$1 AND is_active=true`, [cid]);
        if (parseInt(emp?.cnt) > 0) {
          insights.push({
            id: 'payroll-summary', severity: 'info', agent: 'Folha',
            title: `${emp.cnt} funcionario${parseInt(emp.cnt)>1?'s':''} ativo${parseInt(emp.cnt)>1?'s':''}`,
            description: `Folha bruta estimada: R$ ${parseFloat(emp.folha).toFixed(2).replace('.',',')}`,
            action: { type: 'navigate', target: '/folha', label: 'Ver folha' },
          });
        }
        break;
      }
      case 'dashboard': case 'geral': {
        // Aggregate insights from all contexts
        const { rows: [ov] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM transactions WHERE company_id=$1 AND type='income' AND status='pending' AND due_date < CURRENT_DATE`, [cid]);
        if (parseInt(ov?.cnt) > 0) {
          insights.push({ id: 'overdue-dash', severity: 'warning', agent: 'Financeiro',
            title: `${ov.cnt} cobranca${parseInt(ov.cnt)>1?'s':''} em atraso`,
            description: 'Voce tem recebimentos vencidos.',
            action: { type: 'navigate', target: '/financeiro', label: 'Cobrar' } });
        }
        const { rows: [ls] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM products WHERE company_id=$1 AND stock_qty <= min_stock_qty AND min_stock_qty > 0`, [cid]);
        if (parseInt(ls?.cnt) > 0) {
          insights.push({ id: 'low-stock-dash', severity: 'warning', agent: 'Estoque',
            title: `${ls.cnt} produto${parseInt(ls.cnt)>1?'s':''} para repor`,
            description: 'Itens abaixo do estoque minimo.',
            action: { type: 'navigate', target: '/estoque', label: 'Repor' } });
        }
        const { rows: [ic] } = await db.query(
          `SELECT COUNT(*) AS cnt FROM customers WHERE company_id=$1 AND last_purchase_at < NOW()-INTERVAL '30 days' AND last_purchase_at IS NOT NULL`, [cid]);
        if (parseInt(ic?.cnt) > 0) {
          insights.push({ id: 'inactive-dash', severity: 'info', agent: 'CRM',
            title: `${ic.cnt} cliente${parseInt(ic.cnt)>1?'s':''} para reativar`,
            description: 'Clientes inativos ha 30+ dias.',
            action: { type: 'navigate', target: '/clientes', label: 'Reativar' } });
        }
        break;
      }
    }
  } catch (err) {
    console.error(`[aiInsights] Error for ${ctx}:`, err.message);
  }

  res.json({ context: ctx, insights, count: insights.length });
});

module.exports = router;
