// ============================================================
// AURA -- Crediario: tira de um carne JUNTADO ou RENEGOCIADO o valor de uma
// venda cancelada ou devolvida.
//
// Defeito (caso real, Layali): "Juntar carnes" e "Renegociar" criam um
// cronograma novo com sale_id nulo e levam os debitos para o carne novo.
// cancelCreditSale / refundCreditSale so enxergam parcelas pelo sale_id e
// nao achavam nada: o debito saia do razao, as parcelas do carne novo
// ficavam vivas (orfas) e o carne travava com CARNE_DIVERGENTE.
//
// Regra: o valor sai das parcelas ABERTAS sem venda (sale_id nulo) do carne
// que guarda a divida hoje, das que vencem por ultimo para as primeiras.
//   - So o que falta pagar (amount_due - covered_amount) e reduzido; nunca a
//     parte ja coberta nem parcela paga.
//   - Parcela sem nada coberto que zera vira 'cancelled'; a que tem parte
//     coberta encolhe ate o coberto e vira 'paid' (o mesmo que a juncao faz).
//   - O que nao cabe no aberto fica como credito da cliente: o pagamento
//     continua no razao e o saldo ja o mostra (balance negativo).
// Carne com parcelas da propria venda (caminho normal) nao passa por aqui.
// Chamar DENTRO da transacao do cancelamento/devolucao.
// ============================================================
'use strict';

const { withSavepoint } = require('./carneAuto');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const EPS = 0.005;

/**
 * @returns {Promise<null|{account_id, removed, shrunk, excess_credit, installments:Array}>}
 *   null = nada a fazer (carne normal, sem parcela aberta solta, schema antigo).
 */
async function shrinkMergedCarne(client, {
  companyId, customerId, accountId, saleId, amount,
  kind = 'cancel', refId = null, createdBy = null,
}) {
  let remaining = round2(amount);
  if (!accountId || !customerId || remaining <= EPS) return null;

  const done = await withSavepoint(client, 'carne_encolhe', async () => {
    const { rows: open } = await client.query(
      `SELECT id, installment_number, amount_due, covered_amount, status
         FROM credit_installments
        WHERE company_id = $1 AND account_id = $2 AND sale_id IS NULL
          AND status IN ('pending', 'overdue')
        ORDER BY due_date DESC, installment_number DESC
        FOR UPDATE`,
      [companyId, accountId]
    );
    if (!open.length) return null;

    const changed = [];
    for (const inst of open) {
      if (remaining <= EPS) break;
      const due = round2(inst.amount_due);
      const cov = round2(inst.covered_amount);
      const falta = round2(due - cov);
      if (falta <= EPS) continue;

      if (remaining >= falta - EPS) {
        // Zera o que faltava. Sem cobertura: cancela. Com cobertura: encolhe
        // ate o coberto e fecha como paga (a cobertura nao e tocada).
        const toStatus = cov > EPS ? 'paid' : 'cancelled';
        const toDue = cov > EPS ? cov : due;
        await client.query(
          `UPDATE credit_installments
              SET status = $3, amount_due = $4, updated_at = NOW()
            WHERE id = $1 AND company_id = $2`,
          [inst.id, companyId, toStatus, toDue]
        );
        changed.push({
          id: inst.id, number: inst.installment_number, action: toStatus === 'paid' ? 'closed' : 'cancelled',
          amount: falta, prev_status: inst.status, prev_amount_due: due, prev_covered: cov,
          new_status: toStatus, new_amount_due: toDue,
        });
        remaining = round2(remaining - falta);
      } else {
        const newDue = round2(due - remaining);
        await client.query(
          `UPDATE credit_installments SET amount_due = $3, updated_at = NOW()
            WHERE id = $1 AND company_id = $2`,
          [inst.id, companyId, newDue]
        );
        changed.push({
          id: inst.id, number: inst.installment_number, action: 'reduced',
          amount: remaining, prev_status: inst.status, prev_amount_due: due, prev_covered: cov,
          new_status: inst.status, new_amount_due: newDue,
        });
        remaining = 0;
      }
    }
    return changed;
  }, null);

  if (!done) return null;

  const requested = round2(amount);
  const shrunk = round2(requested - remaining);
  const result = {
    kind,
    sale_id: saleId,
    account_id: accountId,
    removed: requested,
    shrunk,
    excess_credit: remaining > EPS ? remaining : 0,
    installments: done,
  };

  // Recibo do ajuste (mesma tabela da renegociacao/juncao). Falha aqui nao
  // desfaz o cancelamento: a tabela pode faltar em deploy parcial.
  await withSavepoint(client, 'carne_encolhe_recibo', async () => {
    await client.query(
      `INSERT INTO credit_reschedule_receipts
         (company_id, customer_id, account_id, idempotency_key, result)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, idempotency_key) DO NOTHING`,
      [companyId, customerId, accountId,
       `carne-ajuste-${kind}-${saleId}-${refId || 'x'}-${accountId}`,
       JSON.stringify({ ...result, type: 'carne_ajuste', created_by: createdBy })]
    );
  }, null);

  return result;
}

module.exports = { shrinkMergedCarne };
