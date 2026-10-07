// ============================================================
// AURA -- Crediario: linhas da lista de saldos (GET /credit/balances)
// ============================================================
'use strict';

// ------------------------------------------------------------
// Linhas da lista. 07/10/2026 (Valen / jackson ICL): a lista saia SO da view
// de saldo (customer_credit_balances) com `balance > 0`. Cliente cujo debito
// foi apagado do razao mas cujas parcelas seguem abertas tem saldo <= 0 -- ou
// nem aparece na view -- e sumia da tela, inclusive da busca por nome: o
// lojista nao tinha como achar o que receber. Agora "em aberto" e saldo > 0
// OU parcela aberta, e a linha diz quanto ha em parcelas (open_installments)
// e se as duas contas divergem (ledger_mismatch).
//
// Defensivo 42P01/42703: sem credit_installments (ou sem covered_amount) a
// lista volta ao formato antigo, so pela view. Cache module-level.
// ------------------------------------------------------------
let installmentsAvailable = true;

function searchClause(q, params) {
  if (!q) return '';
  params.push(`%${q}%`);
  const i = params.length;
  return ` AND (c.name ILIKE $${i} OR c.phone ILIKE $${i} OR c.cpf_cnpj ILIKE $${i})`;
}

async function listBalanceRows(db, companyId, { onlyOpen = true, q = '' } = {}) {
  if (installmentsAvailable) {
    const params = [companyId];
    const search = searchClause(q, params);
    try {
      return await db.query(
        `WITH inst AS (
           SELECT customer_id,
                  SUM(GREATEST(amount_due - COALESCE(covered_amount, 0), 0)) AS open_installments
             FROM credit_installments
            WHERE company_id = $1 AND status IN ('pending','overdue')
            GROUP BY customer_id
         ),
         bal AS (
           SELECT customer_id, balance, total_debited, total_paid, last_activity_at
             FROM customer_credit_balances
            WHERE company_id = $1
         )
         SELECT c.id, c.name, c.phone, c.cpf_cnpj,
                COALESCE(bal.balance, 0)             AS balance,
                COALESCE(bal.total_debited, 0)       AS total_debited,
                COALESCE(bal.total_paid, 0)          AS total_paid,
                bal.last_activity_at,
                COALESCE(inst.open_installments, 0)  AS open_installments
           FROM bal
           FULL JOIN inst ON inst.customer_id = bal.customer_id
           JOIN customers c ON c.id = COALESCE(bal.customer_id, inst.customer_id)
          WHERE (bal.customer_id IS NOT NULL OR inst.open_installments > 0.009)
            ${onlyOpen ? 'AND (COALESCE(bal.balance, 0) > 0 OR COALESCE(inst.open_installments, 0) > 0.009)' : ''}
            ${search}
          ORDER BY GREATEST(COALESCE(bal.balance, 0), COALESCE(inst.open_installments, 0)) DESC,
                   bal.last_activity_at DESC NULLS LAST, c.name ASC
          LIMIT 500`,
        params
      );
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
      installmentsAvailable = false;
    }
  }
  const params = [companyId];
  const search = searchClause(q, params);
  return db.query(
    `SELECT c.id, c.name, c.phone, c.cpf_cnpj,
            cb.balance, cb.total_debited, cb.total_paid, cb.last_activity_at
       FROM customer_credit_balances cb
       JOIN customers c ON c.id = cb.customer_id
      WHERE cb.company_id = $1
        ${onlyOpen ? 'AND cb.balance > 0' : ''}
        ${search}
      ORDER BY cb.balance DESC, cb.last_activity_at DESC NULLS LAST
      LIMIT 500`,
    params
  );
}

module.exports = { listBalanceRows };
