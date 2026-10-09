// ============================================================
// AURA -- Crediario: EDITAR um recebimento ja registrado.
//
// Caso Looks da Jenny (08/10/2026): a lojista lancou R$200 na ficha da
// "Maria Eduarda" errada, percebeu na hora, lancou na certa e ficou sem ter
// como tirar o primeiro -- nao havia botao, e o desfazer do backend recusava
// pagamento com data retroativa (a janela de 24h contava da data informada).
// A correcao foi por SQL a mao. Erro de digitacao em pagamento (valor, dia,
// forma ou cliente) e rotina de balcao e precisa ser corrigido pela loja.
//
// Editar = DESFAZER + RELANCAR, na mesma transacao do chamador. Nao existe
// "UPDATE no pagamento": o valor, o dia e o cliente decidem em quais parcelas
// ele cai, o que entra no Financeiro e no caixa. Reaproveitar undoPayment e
// applyPayment garante que o resultado e identico ao de quem tivesse lancado
// certo da primeira vez -- e que nenhum dos dois caminhos diverge do outro.
//
// O que muda e o que fica:
//   - amount, method, paid_at, customer_id: o que vier em `changes` troca; o
//     que nao vier fica como estava no pagamento original.
//   - carne (account_id): mantido se o cliente e o mesmo; ao mover para outro
//     cliente o pagamento entra pelo FIFO geral dele.
//   - o id do pagamento MUDA (o original e apagado); quem chama recebe os dois.
//
// Pagamento sem distribuicao gravada (anterior a migration 335) continua nao
// podendo ser desfeito automaticamente: o 409 PAYMENT_WITHOUT_ALLOCATIONS do
// undoPayment sobe como esta.
// ============================================================
'use strict';

const { undoPayment } = require('./undoPayment');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function httpError(message, status, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function todaySp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/**
 * Valida `changes` contra o pagamento original e devolve os valores finais.
 * Funcao pura (testavel sem banco). Lanca httpError 400 no que nao presta.
 *
 * @param {{amount:number|string, payment_method:string|null, customer_id:string, paid_day:string}} original
 * @param {{amount?:any, method?:any, paid_at?:any, customer_id?:any}} changes
 * @param {string} [today] 'YYYY-MM-DD' em Sao Paulo (so para teste)
 */
function resolveChanges(original, changes, today) {
  const c = changes || {};
  const hoje = today || todaySp();
  const out = {
    amount:     round2(original.amount),
    method:     original.payment_method || null,
    paidDay:    original.paid_day,
    customerId: original.customer_id,
    changed:    [],
  };

  if (has(c, 'amount')) {
    const a = round2(c.amount);
    if (!Number.isFinite(a) || a <= 0) throw httpError('Informe um valor maior que zero.', 400, 'INVALID_AMOUNT');
    if (a !== out.amount) { out.amount = a; out.changed.push('amount'); }
  }
  if (has(c, 'method')) {
    const m = c.method === null ? null : String(c.method).trim();
    if (!m) throw httpError('Informe a forma de pagamento.', 400, 'INVALID_METHOD');
    if (m === 'crediario_credito') throw httpError('Forma de pagamento invalida.', 400, 'INVALID_METHOD');
    if (m !== out.method) { out.method = m; out.changed.push('method'); }
  }
  if (has(c, 'paid_at')) {
    const d = String(c.paid_at || '').slice(0, 10);
    if (!DATE_RE.test(d) || isNaN(Date.parse(d + 'T00:00:00Z'))) {
      throw httpError('Data invalida. Use uma data como 2026-09-26.', 400, 'INVALID_DATE');
    }
    if (d > hoje) throw httpError('A data do pagamento nao pode ser no futuro.', 400, 'INVALID_DATE');
    if (d !== out.paidDay) { out.paidDay = d; out.changed.push('paid_at'); }
  }
  if (has(c, 'customer_id')) {
    const id = String(c.customer_id || '');
    if (!UUID_RE.test(id)) throw httpError('Cliente nao encontrado.', 404, 'CUSTOMER_NOT_FOUND');
    if (id !== out.customerId) { out.customerId = id; out.changed.push('customer_id'); }
  }

  if (!out.changed.length) throw httpError('Nada para alterar neste pagamento.', 400, 'NOTHING_TO_CHANGE');
  // applyPayment trata paidAt null como "agora": so data ANTERIOR a hoje e retroativa.
  out.paidAt = out.paidDay < hoje ? out.paidDay : null;
  return out;
}

/**
 * editPayment -- DENTRO de uma transacao do chamador.
 *
 * @param {object} client
 * @param {object} opts
 * @param {string} opts.companyId
 * @param {string} opts.transactionId   pagamento original
 * @param {object} opts.changes         { amount?, method?, paid_at?, customer_id? }
 * @param {string|null} opts.createdBy
 * @param {string|null} opts.sessaoId   sessao de caixa aberta (best-effort)
 * @param {Function} opts.findCustomer  (client, companyId, customerId) -> row | null
 * @param {Function} opts.loadContext   (client, companyId, customerId) -> {config, profile}
 */
async function editPayment(client, {
  companyId, transactionId, changes, createdBy = null, sessaoId = null,
  findCustomer, loadContext,
}) {
  if (!UUID_RE.test(String(transactionId || ''))) {
    throw httpError('Recebimento nao encontrado', 404, 'NOT_FOUND');
  }
  const { rows } = await client.query(
    `SELECT id, customer_id, type, amount, payment_method, account_id,
            to_char(created_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS paid_day
       FROM customer_credit_transactions
      WHERE id = $1 AND company_id = $2
      FOR UPDATE`,
    [transactionId, companyId]
  );
  if (!rows.length) throw httpError('Recebimento nao encontrado', 404, 'NOT_FOUND');
  const original = rows[0];
  if (original.type !== 'payment') {
    throw httpError('So um recebimento pode ser editado por aqui.', 409, 'NOT_PAYMENT');
  }

  const next = resolveChanges(original, changes);
  const moved = next.customerId !== original.customer_id;

  if (moved) {
    const target = await findCustomer(client, companyId, next.customerId);
    if (!target) throw httpError('Cliente nao encontrado.', 404, 'CUSTOMER_NOT_FOUND');
  }

  // 1. Desfaz o original (sem janela: quem valida o que pode e o undoPayment).
  const undone = await undoPayment(client, { companyId, transactionId: original.id, windowHours: null });

  // 2. Relanca com os valores finais -- o mesmo caminho do "Receber".
  const ctx = (await loadContext(client, companyId, next.customerId)) || {};
  const ledger = require('./ledger'); // lazy: ledger abre o pool no require
  const applied = await ledger.applyPayment(client, {
    companyId,
    customerId: next.customerId,
    amount:     next.amount,
    method:     next.method,
    sessaoId,
    createdBy,
    paidAt:     next.paidAt,
    accountId:  moved ? null : (original.account_id || null),
    config:     ctx.config,
    profile:    ctx.profile,
  });

  const { rows: bal } = await client.query(
    `SELECT customer_id, balance FROM customer_credit_balances
      WHERE company_id = $1 AND customer_id = ANY($2::uuid[])`,
    [companyId, [original.customer_id, next.customerId]]
  );
  const saldo = (id) => parseFloat((bal.find((b) => b.customer_id === id) || {}).balance || 0);

  return {
    edited:                  true,
    changed:                 next.changed,
    previous_transaction_id: original.id,
    transaction_id:          applied.transaction ? applied.transaction.id : null,
    customer_id:             next.customerId,
    previous_customer_id:    original.customer_id,
    moved,
    amount:                  next.amount,
    method:                  next.method,
    paid_at:                 next.paidDay,
    new_balance:             saldo(next.customerId),
    previous_customer_balance: moved ? saldo(original.customer_id) : null,
    credit_generated:        round2(applied.legacy_amount || 0),
    installments_reopened:   undone.installments_reopened,
  };
}

module.exports = { editPayment, resolveChanges };
