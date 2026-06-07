// ============================================================
// AURA KARATÊ — Finance Service (Track B)
// Helpers: status de anuidade, cálculo DRE/fluxo, cobrança.
//
// Status do dojô agora deriva de karate_dojo_annuity_history (migration 152),
// não do heurístico affiliation_since. Ver getDojoAnnuityStatus().
// ============================================================
'use strict';

const db = require('../config/database');

// ── Status de anuidade (derivado de karate_dojo_annuity_history) ─
// Regra:
//   'paid'       → existe registro pago para o período corrente (status=paid)
//   'due'        → existe cobrança pendente com due_date >= hoje
//   'overdue'    → cobrança pendente com due_date vencida há <= 90 dias
//   'defaulting' → vencida há 91–180 dias
//   'suspended'  → vencida há > 180 dias ou nenhuma cobrança + afiliação antiga
function computeAnnuityStatus(latestAnnuity) {
  if (!latestAnnuity) return 'suspended';

  // Se existe registro com status explícito
  if (latestAnnuity.status === 'paid') return 'paid';

  const dueDate = latestAnnuity.due_date ? new Date(latestAnnuity.due_date) : null;
  if (!dueDate) return 'suspended';

  const now = new Date();
  const dayMs = 1000 * 60 * 60 * 24;
  const daysUntilDue = Math.round((dueDate - now) / dayMs);

  if (daysUntilDue > 0)  return 'due';

  const daysOverdue = Math.abs(daysUntilDue);
  if (daysOverdue <= 90)  return 'overdue';
  if (daysOverdue <= 180) return 'defaulting';
  return 'suspended';
}

/**
 * Busca o status atual de anuidade de um dojô pela tabela karate_dojo_annuity_history.
 * Retorna { status, amount, days_overdue, due_date, paid_at, reference_period }.
 */
async function getDojoAnnuityStatus(dojoId, referenceYear) {
  const year = referenceYear || new Date().getFullYear().toString();

  // Prioridade: registro do ano corrente; senão, o mais recente
  const { rows } = await db.query(
    `SELECT id, dojo_id, reference_period, amount, due_date, paid_at, status, transaction_id
     FROM karate_dojo_annuity_history
     WHERE dojo_id = $1
     ORDER BY
       CASE WHEN reference_period = $2 THEN 0 ELSE 1 END,
       reference_period DESC
     LIMIT 1`,
    [dojoId, year]
  );

  const annuity = rows[0] || null;
  const status = computeAnnuityStatus(annuity);

  const daysOverdue = (() => {
    if (!annuity || !annuity.due_date || status === 'paid' || status === 'due') return 0;
    const dayMs = 1000 * 60 * 60 * 24;
    return Math.max(0, Math.round((new Date() - new Date(annuity.due_date)) / dayMs));
  })();

  return {
    annuity_id: annuity?.id || null,
    status,
    amount: annuity?.amount || 0,
    days_overdue: daysOverdue,
    due_date: annuity?.due_date || null,
    paid_at: annuity?.paid_at || null,
    reference_period: annuity?.reference_period || year,
    transaction_id: annuity?.transaction_id || null,
  };
}

/**
 * Calcula DRE simplificado para o período.
 * Receitas: transactions com type='income', company_id=federationId, status='paid'.
 * Despesas: transactions com type='expense', company_id=federationId.
 */
async function calcDre(federationId, from, to) {
  const params = [federationId];
  let dateFilter = '';
  if (from) { params.push(from); dateFilter += ` AND due_date >= $${params.length}`; }
  if (to)   { params.push(to);   dateFilter += ` AND due_date <= $${params.length}`; }

  const { rows: revenueRows } = await db.query(
    `SELECT category, COALESCE(SUM(amount), 0) AS amount
     FROM transactions
     WHERE company_id = $1 AND type = 'income' AND status = 'paid'${dateFilter}
     GROUP BY category
     ORDER BY amount DESC`,
    params
  );

  const { rows: expenseRows } = await db.query(
    `SELECT category, COALESCE(SUM(amount), 0) AS amount
     FROM transactions
     WHERE company_id = $1 AND type = 'expense'${dateFilter}
     GROUP BY category
     ORDER BY amount DESC`,
    params
  );

  const totalRevenue = revenueRows.reduce((s, r) => s + parseFloat(r.amount), 0);
  const totalExpense = expenseRows.reduce((s, r) => s + parseFloat(r.amount), 0);

  return {
    revenue: revenueRows.map(r => ({ category: r.category, amount: parseFloat(r.amount) })),
    expenses: expenseRows.map(r => ({ category: r.category, amount: parseFloat(r.amount) })),
    net: parseFloat((totalRevenue - totalExpense).toFixed(2)),
  };
}

/**
 * Calcula fluxo de caixa mensal para o período.
 */
async function calcCashflow(federationId, from, to) {
  const params = [federationId];
  let dateFilter = '';
  if (from) { params.push(from); dateFilter += ` AND due_date >= $${params.length}`; }
  if (to)   { params.push(to);   dateFilter += ` AND due_date <= $${params.length}`; }

  const { rows } = await db.query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', due_date), 'YYYY-MM') AS month,
       COALESCE(SUM(CASE WHEN type = 'income' AND status = 'paid' THEN amount ELSE 0 END), 0) AS inflow,
       COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS outflow
     FROM transactions
     WHERE company_id = $1 AND due_date IS NOT NULL${dateFilter}
     GROUP BY 1
     ORDER BY 1`,
    params
  );

  return rows.map(r => ({
    month: r.month,
    inflow: parseFloat(r.inflow),
    outflow: parseFloat(r.outflow),
    balance: parseFloat((r.inflow - r.outflow).toFixed(2)),
  }));
}

/**
 * Projeção de recebíveis (cobranças pendentes com due_date futuro).
 */
async function calcProjectedReceivables(federationId) {
  const { rows } = await db.query(
    `SELECT due_date, COALESCE(SUM(amount), 0) AS amount
     FROM transactions
     WHERE company_id = $1
       AND type = 'income'
       AND status IN ('pending', 'due')
       AND due_date >= CURRENT_DATE
     GROUP BY due_date
     ORDER BY due_date
     LIMIT 60`,
    [federationId]
  );
  return rows.map(r => ({ due_date: r.due_date, amount: parseFloat(r.amount) }));
}

module.exports = {
  computeAnnuityStatus,
  getDojoAnnuityStatus,
  calcDre,
  calcCashflow,
  calcProjectedReceivables,
};
