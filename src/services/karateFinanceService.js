// ============================================================
// AURA KARATÊ — Finance Service (Track B)
// Helpers: status de anuidade, cálculo DRE/fluxo, cobrança.
//
// Status do dojô agora deriva de karate_dojo_annuity_history (migration 152),
// não do heurístico affiliation_since. Ver getDojoAnnuityStatus().
//
// NOTA DE SCHEMA (23/06): transactions.status é o enum transaction_status,
// cujos únicos valores são pending/confirmed/cancelled. Recebido = 'confirmed';
// em aberto/recebível = 'pending'. Filtros 'paid'/'due' eram inválidos (500).
// (karate_dojo_annuity_history.status é TEXTO e usa 'paid'/'pending'/'overdue' —
// esse é legítimo e NÃO é mexido aqui.)
// transactions.reference_id é uuid: comparar com uuid cru (sem ::text).
// ============================================================
'use strict';

const db = require('../config/database');

// ── Status de anuidade (derivado de karate_dojo_annuity_history) ─
// Sem cobrança lançada (sem registro, ou registro sem due_date) é um estado
// NEUTRO ('no_charge') — ausência de cobrança NÃO é inadimplência.
// 'suspended' passa a significar apenas "tinha cobrança e venceu há mais de
// 180 dias".
function computeAnnuityStatus(latestAnnuity) {
  if (!latestAnnuity) return 'no_charge';
  if (latestAnnuity.status === 'paid') return 'paid';
  const dueDate = latestAnnuity.due_date ? new Date(latestAnnuity.due_date) : null;
  if (!dueDate) return 'no_charge';
  const now = new Date();
  const dayMs = 1000 * 60 * 60 * 24;
  const daysUntilDue = Math.round((dueDate - now) / dayMs);
  if (daysUntilDue > 0)  return 'due';
  const daysOverdue = Math.abs(daysUntilDue);
  if (daysOverdue <= 90)  return 'overdue';
  if (daysOverdue <= 180) return 'defaulting';
  return 'suspended';
}

async function getDojoAnnuityStatus(dojoId, referenceYear) {
  const year = referenceYear || new Date().getFullYear().toString();
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
 * getPractitionerAnnuityStatus — situação da anuidade CPF de um praticante,
 * derivada de transactions (category='annuity_cpf', reference_type='customer').
 * Usada pela verificação pública da carteirinha.
 *   situacao: 'valida' | 'vencida'
 *   validade: data de referência (due_date) ou null
 * Sem cobrança lançada => 'valida' (não penaliza quem a federação ainda não cobrou).
 *
 * transactions.status é o enum (pending/confirmed/cancelled). "Recebida" = 'confirmed'.
 * transactions.reference_id é uuid: comparar com studentId (uuid) cru.
 */
async function getPractitionerAnnuityStatus(studentId, federationId) {
  const { rows } = await db.query(
    `SELECT due_date, status, paid_at
     FROM transactions
     WHERE federation_id = $1
       AND reference_type = 'customer'
       AND reference_id = $2
       AND category = 'annuity_cpf'
     ORDER BY due_date DESC NULLS LAST
     LIMIT 1`,
    [federationId, studentId]
  );
  const a = rows[0];
  if (!a) return { situacao: 'valida', validade: null, has_charge: false };
  if (a.status === 'confirmed' || a.paid_at) return { situacao: 'valida', validade: a.due_date || null, paid_at: a.paid_at || null, has_charge: true };
  if (a.due_date && new Date(a.due_date) < new Date()) {
    return { situacao: 'vencida', validade: a.due_date, has_charge: true };
  }
  return { situacao: 'valida', validade: a.due_date || null, has_charge: true };
}

async function calcDre(federationId, from, to) {
  const params = [federationId];
  let dateFilter = '';
  if (from) { params.push(from); dateFilter += ` AND due_date >= $${params.length}`; }
  if (to)   { params.push(to);   dateFilter += ` AND due_date <= $${params.length}`; }
  const { rows: revenueRows } = await db.query(
    `SELECT category, COALESCE(SUM(amount), 0) AS amount
     FROM transactions
     WHERE company_id = $1 AND type = 'income' AND status = 'confirmed'${dateFilter}
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

async function calcCashflow(federationId, from, to) {
  const params = [federationId];
  let dateFilter = '';
  if (from) { params.push(from); dateFilter += ` AND due_date >= $${params.length}`; }
  if (to)   { params.push(to);   dateFilter += ` AND due_date <= $${params.length}`; }
  const { rows } = await db.query(
    `SELECT
       TO_CHAR(DATE_TRUNC('month', due_date), 'YYYY-MM') AS month,
       COALESCE(SUM(CASE WHEN type = 'income' AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS inflow,
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

async function calcProjectedReceivables(federationId) {
  const { rows } = await db.query(
    `SELECT due_date, COALESCE(SUM(amount), 0) AS amount
     FROM transactions
     WHERE company_id = $1
       AND type = 'income'
       AND status = 'pending'
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
  getPractitionerAnnuityStatus,
  calcDre,
  calcCashflow,
  calcProjectedReceivables,
};
