// ============================================================
// AURA -- Crediario: EXCLUIR UM CARNE (09/11/2026)
//
// Incidente relatado pelo Caio: a ficha nao tinha como excluir um carne. A
// lojista lancava um carne errado e so conseguia desfazer lancamento por
// lancamento na Linha do tempo -- e um carne renegociado nem isso (o acrescimo
// da renegociacao da 409 RESCHEDULE_ADJUSTMENT no undoManualEntry).
//
// Regras do Caio (09/11/2026):
//   1. Carne SEM recebimento, de lancamento manual ou renegociado: exclui.
//      Numa transacao so: desfaz os debitos, cancela as parcelas abertas,
//      devolve ao FIFO qualquer cobertura, marca o carne 'cancelled' e
//      atualiza o credit_used. O saldo do cliente cai EXATAMENTE o que o
//      carne tem em aberto.
//   2. Carne com QUALQUER recebimento: nao exclui. 409 CARNE_TEM_RECEBIMENTO
//      com a lista dos recebimentos (id, data, valor) -- a lojista desfaz cada
//      um na Linha do tempo (DELETE /payments/:txid) e depois exclui.
//   3. Carne que nasceu de venda do Caixa: nao exclui so a divida (o estoque
//      ficaria fora). 409 CARNE_DE_VENDA com o sale_id -- o caminho e a
//      devolucao da venda, que tira a divida e devolve o estoque.
//   4. Carne cancelado ou juntado em outro: nao ha o que excluir (409).
//
// O QUE E "RECEBIMENTO" AQUI
// O recebimento livre (FIFO, sem carne) e o uso dominante: o pagamento fica no
// razao com account_id NULO e abate parcela de qualquer carne. Entao "tem
// recebimento" e qualquer um destes:
//   a. pagamento no razao com account_id = este carne;
//   b. distribuicao (credit_payment_allocations) numa parcela deste carne --
//      inclusive parcela ja cancelada por uma renegociacao (o dinheiro entrou);
//   c. parcela viva deste carne com cobertura ou 'paid' sem distribuicao
//      gravada (pagamento anterior a migration 335).
// Como (a)-(c) bloqueiam, nenhuma parcela deste carne tem cobertura quando a
// exclusao segue. Mesmo assim a cobertura e somada e devolvida ao FIFO das
// parcelas abertas do CLIENTE (o carne inteiro sai, entao o escopo do carne nao
// serve) -- defesa contra uma regra nova de recebimento que ninguem lembrou
// de por aqui.
//
// CARNE RENEGOCIADO (decisao documentada)
// A renegociacao (reschedule.js) trabalha NO MESMO carne: cancela as parcelas
// abertas, grava o cronograma novo (sem transaction_id) e lanca o delta do
// total no razao com source='reschedule' -- type='debit' (acrescimo) ou
// type='refund' (desconto). O debito original continua inteiro. Logo, num
// carne sem recebimento:
//     debitos (manual + acrescimo) - descontos = resto do cronograma novo
// Excluir apaga TODOS esses lancamentos do carne (o par debito/estorno sai
// junto) e cancela o cronograma novo. As parcelas que a renegociacao ja tinha
// cancelado ficam como estao: nada e reaberto, nenhuma divida antiga volta.
//
// O QUE NAO "RESSUSCITA" A DIVIDA
// O "Parcelar saldo" (reschedule sem parcela aberta) monta o cronograma deste
// carne em cima do saldo de OUTRAS compras (o debito fica onde estava) e pode
// lancar o desconto aqui. Num carne assim o razao dele nao bate com as
// parcelas: apagar o desconto faria a divida de origem voltar a crescer e
// cancelar as parcelas faria ela reaparecer como "saldo sem parcela". Sem
// adivinhar de onde veio, a exclusao recusa: 409 CARNE_DIVERGENTE, com os dois
// numeros. Medido em producao em 09/11/2026: 6 carnes abertos nesse estado
// (4 com parcelas e nenhum lancamento, 2 so com o desconto da renegociacao).
// Nada e consertado aqui; e caso de Tecnologia, um a um.
//
// Chamar DENTRO de uma transacao do chamador (client ja em BEGIN).
// ============================================================
'use strict';

const { reallocateCovered } = require('./undoManualEntry');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['pending', 'overdue'];
/** Diferenca aceita entre o razao do carne e o resto das parcelas. */
const CENT = 0.01;

function carneError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

const NOT_FOUND = () => carneError(404, 'CARNE_NAO_ENCONTRADO', 'Carne nao encontrado para este cliente.');

/**
 * Lancamento do razao que esta exclusao sabe desfazer: debito sem venda
 * (manual, legado sem source, ou acrescimo de renegociacao) e o desconto da
 * renegociacao. Qualquer outra coisa trava a exclusao.
 */
function isRemovableLedgerRow(t) {
  if (t.sale_id) return false;
  const source = t.source || 'manual';
  if (t.type === 'debit')  return source === 'manual' || source === 'reschedule';
  if (t.type === 'refund') return source === 'reschedule';
  return false;
}

/**
 * Recebimentos que tocam este carne (ver cabecalho, a-c). Lista para a tela:
 * [{ id, date, amount }], do mais antigo para o mais novo. `id` e o do razao
 * (o mesmo do DELETE /payments/:txid); null quando a cobertura e anterior a
 * distribuicao gravada e nao da para dizer qual pagamento foi.
 */
async function findReceipts(client, companyId, accountId) {
  const { rows } = await client.query(
    `SELECT t.id, t.created_at, t.amount
       FROM customer_credit_transactions t
      WHERE t.company_id = $1
        AND t.type = 'payment'
        AND (t.account_id = $2
             OR EXISTS (SELECT 1
                          FROM credit_payment_allocations pa
                          JOIN credit_installments i ON i.id = pa.installment_id
                         WHERE pa.transaction_id = t.id
                           AND i.account_id = $2 AND i.company_id = $1))
      ORDER BY t.created_at ASC`,
    [companyId, accountId]
  );
  const receipts = rows.map((r) => ({
    id:     r.id,
    date:   r.created_at,
    amount: round2(num(r.amount)),
  }));

  // (c) cobertura sem distribuicao gravada.
  const { rows: legacy } = await client.query(
    `SELECT COALESCE(SUM(i.covered_amount), 0) AS covered, COUNT(*)::int AS n
       FROM credit_installments i
      WHERE i.company_id = $1 AND i.account_id = $2
        AND i.status <> 'cancelled'
        AND (i.status = 'paid' OR COALESCE(i.covered_amount, 0) > 0.005)
        AND NOT EXISTS (SELECT 1 FROM credit_payment_allocations pa
                         WHERE pa.installment_id = i.id)`,
    [companyId, accountId]
  );
  const legacyCount = legacy[0] ? Number(legacy[0].n) : 0;
  if (!receipts.length && legacyCount > 0) {
    receipts.push({ id: null, date: null, amount: round2(num(legacy[0].covered)) });
  }
  return receipts;
}

/**
 * Exclui o carne `accountId` do cliente `customerId` da empresa `companyId`.
 * @returns {Promise<{deleted:true, account_id:string, customer_id:string,
 *   removed_amount:number, cancelled_installments:number,
 *   removed_transactions:number, reallocated_amount:number, new_balance:number}>}
 */
async function deleteCarne(client, { companyId, customerId, accountId }) {
  if (!UUID_RE.test(String(accountId || '')) || !UUID_RE.test(String(customerId || ''))) {
    throw NOT_FOUND();
  }

  // 1. O carne, travado. Empresa E cliente da URL -- nada de cruzar CNPJ.
  const { rows: accRows } = await client.query(
    `SELECT id, status, merged_into_account_id
       FROM credit_accounts
      WHERE id = $1 AND company_id = $2 AND customer_id = $3
      FOR UPDATE`,
    [accountId, companyId, customerId]
  );
  if (!accRows.length) throw NOT_FOUND();
  const acc = accRows[0];
  if (acc.merged_into_account_id) {
    throw carneError(409, 'CARNE_JUNTADO',
      'Este carne foi juntado a outro. Exclua o carne que ficou com as parcelas.',
      { merged_into_account_id: acc.merged_into_account_id });
  }
  if (acc.status !== 'open') {
    throw carneError(409, 'CARNE_JA_EXCLUIDO', 'Este carne ja foi excluido.');
  }

  // 2. Parcelas do carne, travadas: um recebimento simultaneo espera aqui e,
  //    depois do COMMIT, ja nao encontra parcela aberta neste carne.
  const { rows: insts } = await client.query(
    `SELECT id, sale_id, status, amount_due, covered_amount
       FROM credit_installments
      WHERE company_id = $1 AND account_id = $2
      FOR UPDATE`,
    [companyId, accountId]
  );

  const { rows: ledgerRows } = await client.query(
    `SELECT id, type, source, sale_id, amount
       FROM customer_credit_transactions
      WHERE company_id = $1 AND account_id = $2
      FOR UPDATE`,
    [companyId, accountId]
  );

  // 3. Nasceu de venda do Caixa? (regra 3)
  const saleIds = [...new Set([
    ...ledgerRows.filter((t) => t.sale_id && t.type !== 'payment').map((t) => t.sale_id),
    ...insts.filter((i) => i.sale_id).map((i) => i.sale_id),
  ])];
  if (saleIds.length) {
    throw carneError(409, 'CARNE_DE_VENDA',
      'Este carne nasceu de uma venda do Caixa. Para tirar a divida, faca a devolucao da venda.',
      { sale_id: saleIds[0], sale_ids: saleIds });
  }

  // 4. Algum recebimento? (regra 2)
  const receipts = await findReceipts(client, companyId, accountId);
  if (receipts.length) {
    throw carneError(409, 'CARNE_TEM_RECEBIMENTO',
      'Este carne ja tem recebimentos. Desfaca cada um na Linha do tempo e depois exclua o carne.',
      { receipts });
  }

  // 5. So lancamento que esta exclusao sabe desfazer.
  if (ledgerRows.some((t) => !isRemovableLedgerRow(t))) {
    throw carneError(409, 'CARNE_DIVERGENTE',
      'Este carne tem um lancamento que nao pode ser desfeito por aqui.');
  }

  // 6. O razao do carne precisa bater com o resto das parcelas abertas.
  const ledgerOpen = round2(ledgerRows.reduce(
    (s, t) => s + (t.type === 'debit' ? num(t.amount) : -num(t.amount)), 0));
  const openInsts = insts.filter((i) => OPEN_STATUSES.includes(i.status));
  const scheduleOpen = round2(openInsts.reduce(
    (s, i) => s + Math.max(0, num(i.amount_due) - num(i.covered_amount)), 0));
  if (Math.abs(ledgerOpen - scheduleOpen) >= CENT) {
    throw carneError(409, 'CARNE_DIVERGENTE',
      'As parcelas deste carne nao batem com a divida dele. Fale com o suporte da Aura antes de excluir.',
      { ledger_open: ledgerOpen, installments_open: scheduleOpen });
  }

  // 7. Cancela as parcelas abertas. Pagas e ja canceladas ficam como estao
  //    (nenhuma divida antiga reabre).
  const openIds = openInsts.map((i) => i.id);
  const freed = round2(openInsts.reduce((s, i) => s + num(i.covered_amount), 0));
  if (openIds.length) {
    await client.query(
      `UPDATE credit_installments
          SET status = 'cancelled', covered_amount = 0, updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND company_id = $2`,
      [openIds, companyId]
    );
  }

  // 8. Desfaz os lancamentos do carne (debitos e o par da renegociacao).
  const txIds = ledgerRows.map((t) => t.id);
  if (txIds.length) {
    await client.query(
      `DELETE FROM customer_credit_transactions
        WHERE id = ANY($1::uuid[]) AND company_id = $2 AND account_id = $3`,
      [txIds, companyId, accountId]
    );
  }

  // 9. Cobertura de volta ao FIFO do cliente (0 hoje; ver cabecalho).
  const reallocated = await reallocateCovered(client, companyId, customerId, null, freed);

  // 10. O carne sai da ficha. A linha fica: parcelas canceladas apontam para ela.
  await client.query(
    `UPDATE credit_accounts SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND company_id = $2`,
    [accountId, companyId]
  );

  // 11. credit_used + saldo novo.
  await require('./ledger')._updateCreditUsed(client, companyId, customerId);
  const { rows: bal } = await client.query(
    `SELECT balance FROM customer_credit_balances
      WHERE customer_id = $1 AND company_id = $2`,
    [customerId, companyId]
  );

  return {
    deleted:                true,
    account_id:             accountId,
    customer_id:            customerId,
    removed_amount:         ledgerOpen,
    cancelled_installments: openIds.length,
    removed_transactions:   txIds.length,
    reallocated_amount:     reallocated,
    new_balance:            round2(num(bal[0] && bal[0].balance)),
  };
}

module.exports = { deleteCarne, findReceipts, isRemovableLedgerRow };
