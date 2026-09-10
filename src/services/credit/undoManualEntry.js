// ============================================================
// AURA -- Crediario: desfazer um lancamento manual SEM deixar parcela orfa.
//
// Incidente Jenniffer (looks da jenny), cliente Ana Lucia (10/09/2026):
//   16/06  /manual-entry  R$919 -> debito no ledger + parcela 1/1 de R$919
//   08/07  /manual-entry  R$739 (o que faltava pagar) -> debito + parcela 1/1
//          ... e o debito de R$739 foi DESFEITO pela timeline da ficha.
//   A rota DELETE /transaction/:txid apagava so a linha do ledger. A parcela
//   de R$739 ficou 'pending', o FIFO de pagamentos passou a cobri-la, e a
//   ficha mostrou EM ABERTO R$199 (ledger) com parcelas somando R$938.
//
// O que este modulo garante, dentro de UMA transacao do chamador:
//   1. So debito manual (type='debit', sem sale_id) pode ser desfeito aqui.
//      Pagamento/devolucao tem outros efeitos (caixa, recebivel) e nunca foram
//      expostos ao botao "Excluir" da timeline.
//   2. As parcelas que nasceram com esse debito sao canceladas:
//        a. transaction_id = tx.id            (migration 324; lancamentos novos
//                                              e backfill dos antigos)
//        b. legado sem vinculo: mesmo created_at do debito -- ambos vem do
//           NOW() da mesma transacao quando a data nao foi retroativa
//        c. legado com data retroativa: o grupo de parcelas (mesmo created_at,
//           mesmo carne) cuja soma bate com o valor do debito, o mais proximo
//           no tempo
//   3. O que essas parcelas ja tinham coberto NAO some: volta ao FIFO das
//      demais parcelas abertas do cliente (mesma regra do applyPayment). O
//      que sobrar fica como credito no ledger -- exatamente o que o saldo da
//      view customer_credit_balances passa a dizer.
//   4. So entao o debito e apagado.
// ============================================================
'use strict';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const OPEN_STATUSES = ['pending', 'overdue'];

function httpError(message, status, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// ---------------------------------------------------------------
// Parcelas que nasceram junto com o lancamento manual `tx`.
// ---------------------------------------------------------------
async function findLinkedInstallments(client, companyId, tx) {
  const where = `
      FROM credit_installments
     WHERE company_id = $1 AND customer_id = $2
       AND sale_id IS NULL
       AND status <> 'cancelled'`;

  // a. vinculo explicito (coluna pode nao existir num deploy parcial: 42703)
  let hasTxCol = true;
  try {
    const { rows } = await client.query(
      `SELECT id, amount_due, covered_amount, status ${where}
          AND transaction_id = $3
          FOR UPDATE`,
      [companyId, tx.customer_id, tx.id]
    );
    if (rows.length) return rows;
  } catch (err) {
    if (err.code !== '42703') throw err;
    hasTxCol = false;
  }

  // Heuristicas de legado valem so para debito criado pelo /manual-entry.
  // Um "acrescimo" de renegociacao tambem e debito sem venda, mas as parcelas
  // gravadas no mesmo instante sao o cronograma novo inteiro -- nao dele.
  if (tx.source && tx.source !== 'manual') return [];

  const semVinculo = hasTxCol ? 'AND ci.transaction_id IS NULL' : '';

  // Candidatas: parcelas sem venda do mesmo cliente e carne do debito.
  // Nenhum instante passa pelo JS. O Date do node-pg guarda milissegundo e o
  // timestamptz guarda microssegundo (NOW() = 19:18:49.882506): ler created_at
  // e devolve-lo como parametro truncava o valor e a igualdade nunca casava.
  // Toda comparacao de instante e feita em SQL contra a linha do debito ($3).
  const candidatas = `
      FROM credit_installments ci
      JOIN customer_credit_transactions t ON t.id = $3
     WHERE ci.company_id = $1 AND ci.customer_id = $2
       AND ci.sale_id IS NULL
       AND ci.status <> 'cancelled'
       AND ci.account_id IS NOT DISTINCT FROM t.account_id
       ${semVinculo}`;

  // b. mesmo instante
  {
    const { rows } = await client.query(
      `SELECT ci.id, ci.amount_due, ci.covered_amount, ci.status ${candidatas}
          AND ci.created_at = t.created_at
          FOR UPDATE OF ci`,
      [companyId, tx.customer_id, tx.id]
    );
    if (rows.length) return rows;
  }

  // c. grupo cuja soma bate com o debito (o mais proximo no tempo)
  const { rows } = await client.query(
    `WITH grupo AS (
       SELECT ci.created_at ${candidatas}
        GROUP BY ci.created_at, t.amount, t.created_at
       HAVING ABS(SUM(ci.amount_due) - t.amount) < 0.005
        ORDER BY ABS(EXTRACT(EPOCH FROM (ci.created_at - t.created_at))) ASC
        LIMIT 1
     )
     SELECT ci.id, ci.amount_due, ci.covered_amount, ci.status ${candidatas}
        AND ci.created_at = (SELECT created_at FROM grupo)
        FOR UPDATE OF ci`,
    [companyId, tx.customer_id, tx.id]
  );
  return rows;
}

// ---------------------------------------------------------------
// Devolve `amount` ao FIFO das parcelas abertas do cliente (escopo do carne
// quando o debito era de um carne). Espelha o laco do applyPayment.
// Retorna quanto conseguiu alocar; o resto vira credito no ledger.
// ---------------------------------------------------------------
async function reallocateCovered(client, companyId, customerId, accountId, amount) {
  let toAllocate = round2(amount);
  if (toAllocate <= 0.005) return 0;

  const scope  = accountId ? 'AND account_id = $3' : '';
  const params = accountId ? [companyId, customerId, accountId] : [companyId, customerId];
  const { rows } = await client.query(
    `SELECT id, amount_due, covered_amount, status
       FROM credit_installments
      WHERE company_id = $1 AND customer_id = $2 ${scope}
        AND status = ANY($${params.length + 1})
      ORDER BY due_date ASC, installment_number ASC
      FOR UPDATE`,
    [...params, OPEN_STATUSES]
  );

  let allocated = 0;
  for (const inst of rows) {
    if (toAllocate <= 0.005) break;
    const covered   = Number(inst.covered_amount) || 0;
    const amountDue = Number(inst.amount_due) || 0;
    const uncovered = round2(amountDue - covered);
    if (uncovered <= 0.005) continue;

    const coverNow   = Math.min(toAllocate, uncovered);
    const newCovered = round2(covered + coverNow);
    const paid       = newCovered >= amountDue - 0.005;

    await client.query(
      `UPDATE credit_installments
          SET covered_amount = $3,
              status         = $4,
              paid_at        = CASE WHEN $5 THEN NOW() ELSE paid_at END,
              updated_at     = NOW()
        WHERE id = $1 AND company_id = $2`,
      [inst.id, companyId, newCovered, paid ? 'paid' : inst.status, paid]
    );

    allocated  = round2(allocated + coverNow);
    toAllocate = round2(toAllocate - coverNow);
  }
  return allocated;
}

// ---------------------------------------------------------------
// undoManualEntry -- DENTRO de uma transacao do chamador.
// ---------------------------------------------------------------
async function undoManualEntry(client, { companyId, transactionId }) {
  const { rows: txRows } = await client.query(
    `SELECT id, customer_id, type, amount, account_id, source, created_at
       FROM customer_credit_transactions
      WHERE id = $1 AND company_id = $2 AND sale_id IS NULL
      FOR UPDATE`,
    [transactionId, companyId]
  );
  if (!txRows.length) {
    throw httpError(
      'Lancamento nao encontrado ou vinculado a uma venda (cancele a venda no PDV)',
      404, 'NOT_FOUND'
    );
  }
  const tx = txRows[0];
  if (tx.type !== 'debit') {
    throw httpError(
      'So um lancamento manual de debito pode ser desfeito por aqui.',
      409, 'NOT_MANUAL_DEBIT'
    );
  }

  const linked = await findLinkedInstallments(client, companyId, tx);
  const ids    = linked.map((i) => i.id);
  const freed  = round2(linked.reduce((s, i) => s + (Number(i.covered_amount) || 0), 0));

  if (ids.length) {
    await client.query(
      `UPDATE credit_installments
          SET status = 'cancelled', covered_amount = 0, updated_at = NOW()
        WHERE id = ANY($1) AND company_id = $2`,
      [ids, companyId]
    );
  }

  await client.query(
    `DELETE FROM customer_credit_transactions WHERE id = $1 AND company_id = $2`,
    [tx.id, companyId]
  );

  const reallocated = await reallocateCovered(
    client, companyId, tx.customer_id, tx.account_id || null, freed
  );

  const { rows: bal } = await client.query(
    `SELECT balance FROM customer_credit_balances
      WHERE customer_id = $1 AND company_id = $2`,
    [tx.customer_id, companyId]
  );

  return {
    deleted:                true,
    customer_id:            tx.customer_id,
    new_balance:            parseFloat(bal[0]?.balance || 0),
    cancelled_installments: ids.length,
    reallocated_amount:     reallocated,
    credit_left:            round2(freed - reallocated),
  };
}

module.exports = { undoManualEntry, findLinkedInstallments, reallocateCovered };
