// ============================================================
// AURA -- Crediario: razao e parcelas contam a mesma historia?
//
// Incidente Valen / jackson ICL (07/10/2026): o cliente tinha R$4.770 em
// parcelas abertas e saldo de -R$140 no razao. Os debitos tinham sido
// apagados (o "Excluir" antigo da timeline, corrigido em 10/09) e as parcelas
// ficaram. Como a lista de em aberto saia do saldo, ele sumiu da tela -- e
// ninguem soube ate o lojista nao conseguir receber. O levantamento achou 36
// clientes em 7 lojas na mesma situacao, acumulados em silencio desde agosto.
//
// A regra que este modulo confere:
//   parcelas abertas (amount_due - covered_amount) <= saldo do razao
// O contrario e normal (fiado 1x nao gera parcela); parcela aberta ACIMA do
// saldo nao e -- alguem vai cobrar um valor que o razao nao reconhece.
//
// So leitura. Quem decide o que fazer com cada caso e gente: parcela orfa
// pode ser divida real (repoe o debito) ou lancamento refeito (cancela).
// ============================================================
'use strict';

const TOLERANCE = 0.009;

const MISMATCH_SQL = `
  WITH inst AS (
    SELECT company_id, customer_id,
           SUM(GREATEST(amount_due - COALESCE(covered_amount, 0), 0)) AS open_installments,
           COUNT(*) AS open_count
      FROM credit_installments
     WHERE status IN ('pending','overdue')
     GROUP BY company_id, customer_id
  )
  SELECT i.company_id,
         COALESCE(co.trade_name, co.legal_name) AS company_name,
         i.customer_id,
         c.name                                 AS customer_name,
         i.open_installments,
         i.open_count,
         COALESCE(cb.balance, 0)                AS balance,
         i.open_installments - COALESCE(cb.balance, 0) AS gap
    FROM inst i
    JOIN companies co ON co.id = i.company_id
    JOIN customers c  ON c.id  = i.customer_id
    LEFT JOIN customer_credit_balances cb
           ON cb.customer_id = i.customer_id AND cb.company_id = i.company_id
   WHERE i.open_installments - COALESCE(cb.balance, 0) > ${TOLERANCE}
     AND co.is_active = true
   ORDER BY gap DESC
   LIMIT $1`;

/**
 * Clientes cujas parcelas abertas somam mais que o saldo do razao.
 * @returns {Promise<Array<{company_id, company_name, customer_id, customer_name,
 *   open_installments:number, open_count:number, balance:number, gap:number,
 *   hidden:boolean}>>}  hidden = saldo <= 0 (fora da lista ate 07/10/2026)
 */
async function findLedgerMismatches(db, { limit = 500 } = {}) {
  const { rows } = await db.query(MISMATCH_SQL, [limit]);
  return rows.map((r) => {
    const balance = parseFloat(r.balance) || 0;
    return {
      company_id:        r.company_id,
      company_name:      r.company_name,
      customer_id:       r.customer_id,
      customer_name:     r.customer_name,
      open_installments: parseFloat(r.open_installments) || 0,
      open_count:        parseInt(r.open_count, 10) || 0,
      balance,
      gap:               parseFloat(r.gap) || 0,
      hidden:            balance <= 0,
    };
  });
}

/** Agrupa por loja para o log: uma linha por loja, a maior diferenca primeiro. */
function summarizeByCompany(mismatches) {
  const byCompany = new Map();
  for (const m of mismatches) {
    if (!byCompany.has(m.company_id)) {
      byCompany.set(m.company_id, {
        company_id: m.company_id, company_name: m.company_name,
        customers: 0, hidden: 0, gap: 0,
      });
    }
    const s = byCompany.get(m.company_id);
    s.customers += 1;
    if (m.hidden) s.hidden += 1;
    s.gap = Math.round((s.gap + m.gap) * 100) / 100;
  }
  return [...byCompany.values()].sort((a, b) => b.gap - a.gap);
}

module.exports = { findLedgerMismatches, summarizeByCompany, MISMATCH_SQL };
