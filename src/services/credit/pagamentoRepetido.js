// =============================================================
// AURA. -- Crediario: trava contra pagamento repetido (23/11/2026)
//
// Caso real (Looks Da Jenny, 21/11/2026): o mesmo recebimento de uma cliente
// foi lancado duas vezes na ficha -- o segundo de outro computador, com a
// data do pagamento voltada para o dia anterior, mesmo valor. Nao foi bug; o
// saldo da cliente ficou errado ate alguem notar.
//
// Regra aprovada pelo Caio: antes de gravar um recebimento, se ja existe,
// para a MESMA cliente na MESMA loja, um pagamento com o MESMO valor e a
// MESMA data de pagamento (o dia escolhido no lancamento, nao o dia em que
// foi digitado), a rota responde 409 PAGAMENTO_REPETIDO sem gravar nada. O
// app pergunta "Lancar mesmo assim?" e reenvia com confirmar_repetido: true.
//
// Nao bloqueia: parcela a parcela do mesmo valor e uso legitimo (07/10/2026,
// 4 x R$330 em 40 segundos). E so uma pergunta antes de gravar.
//
// O que NAO conta como pagamento igual:
//   - recebimento desfeito/removido: undoPayment apaga a linha do razao;
//   - credito de troca / sinal de pedido (payment_method 'crediario_credito');
//   - debito, devolucao (type <> 'payment').
//
// A data do pagamento e customer_credit_transactions.created_at: o
// applyPayment grava o dia retroativo ao meio-dia de Brasilia (BACKDATE_TS)
// e o de hoje com NOW(). Por isso a comparacao e sempre pelo dia em
// America/Sao_Paulo.
//
// Idempotency-Key: um reenvio com a MESMA chave de um pedido que ja gravou e
// replay -- devolve o resultado de antes, nunca o 409 (o pagamento que ele
// acharia "igual" e ele mesmo). As alocacoes do POST /customer/:cid/payment
// gravam a chave com sufixo '-alloc-N': quem chama passa a chave que a
// primeira alocacao gravaria.
// =============================================================

const CODE = 'PAGAMENTO_REPETIDO';

function hojeEmBrasilia(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

/** confirmar_repetido do corpo: so o booleano true (ou "true") confirma. */
function confirmouRepetido(body) {
  const v = body && body.confirmar_repetido;
  return v === true || v === 'true';
}

/**
 * Procura um pagamento igual ja gravado. Devolve
 * `{ data_pagamento: 'YYYY-MM-DD', valor }` ou null.
 *
 * @param {pg.PoolClient} client  (pode estar em BEGIN; so le)
 * @param {object}  p
 * @param {string}  p.companyId
 * @param {string}  p.customerId
 * @param {number}  p.amount
 * @param {string|null} p.paidAt  'YYYY-MM-DD' retroativo, ou null = hoje
 * @param {string|null} [p.idempotencyKey]  chave que ESTE pedido grava no razao
 */
async function acharPagamentoRepetido(client, { companyId, customerId, amount, paidAt, idempotencyKey = null, now }) {
  const valor = Math.round((Number(amount) || 0) * 100) / 100;
  if (!(valor > 0)) return null;

  if (idempotencyKey) {
    const { rows: ja } = await client.query(
      `SELECT 1 FROM customer_credit_transactions
        WHERE company_id = $1
          AND idempotency_key = $2
        LIMIT 1`,
      [companyId, idempotencyKey]
    );
    if (ja.length) return null; // replay: o applyPayment devolve o resultado de antes
  }

  const dataPagamento = paidAt || hojeEmBrasilia(now);
  const { rows } = await client.query(
    `SELECT id
       FROM customer_credit_transactions
      WHERE company_id  = $1
        AND customer_id = $2
        AND type = 'payment'
        AND payment_method IS DISTINCT FROM 'crediario_credito'
        AND ROUND(amount::numeric, 2) = ROUND($3::numeric, 2)
        AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date = $4::date
      LIMIT 1`,
    [companyId, customerId, valor, dataPagamento]
  );
  if (!rows.length) return null;
  return { data_pagamento: dataPagamento, valor };
}

/** Corpo do 409. `error` fica para quem ainda nao conhece o code. */
function corpoDoRepetido(achado) {
  return {
    error: 'Já existe um pagamento igual nesta data.',
    code: CODE,
    data_pagamento: achado.data_pagamento,
    valor: achado.valor,
  };
}

module.exports = {
  CODE,
  acharPagamentoRepetido,
  confirmouRepetido,
  corpoDoRepetido,
  hojeEmBrasilia,
};
