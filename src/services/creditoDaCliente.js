// ============================================================
// AURA. — Crédito da cliente usado na venda do Caixa
// (INC-2026-11-17-03, 17/11/2026)
//
// O crédito a favor (troca com "Crédito para", devolução do crediário, sobra
// de pagamento) fica no razão da ficha: customer_credit_transactions, saldo
// negativo na view customer_credit_balances. Até aqui o Caixa não mostrava
// esse saldo e a venda não tinha como gastá-lo: só a forma crediário abatia,
// e de lado (o "A Receber" e as parcelas nasciam pelo valor cheio).
//
// Contrato no POST /pdv/sale: o crédito entra como uma forma de pagamento,
//   payments: [{ method: 'credito_cliente', value: 50 }, { method: 'pix', value: 150 }]
// ou, venda inteira no crédito, payment_method: 'credito_cliente' sem payments.
//
// O que grava (regra do sinal do Pedido, aprovada pela Célia):
//   - sales.total_amount = valor cheio (o Faturamento conta a venda inteira);
//   - sale_payments e a receita pdv-sale-<venda> só com o pagamento de hoje
//     (o dinheiro do crédito entrou antes, na venda original ou na troca);
//   - no razão, um 'debit' da venda marcado payment_method='credito_cliente':
//     o saldo da ficha anda de −50 para 0. Débito porque é o que a view já
//     soma: toda conta de saldo (view, ficha, extrato) fica certa sem mudar.
//     A marca separa este débito do débito de venda no crediário onde isso
//     importa (fiado do fechamento, novo fiado, editar venda, devolução).
//
// Multi-CNPJ: o crédito é da cliente NA loja da venda (company_id da venda),
// a mesma regra do saldo do crediário. A cliente pode ser de outra loja do
// mesmo dono (o seletor do Caixa lista a carteira do dono).
// ============================================================
'use strict';

const METODO = 'credito_cliente';

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/** Quanto da venda vai no crédito da cliente, pelo corpo do POST. */
function valorPedido({ payment_method, payments, totalAmount }) {
  if (Array.isArray(payments) && payments.length > 0) {
    let soma = 0;
    for (const p of payments) {
      if (String((p && p.method) || '').toLowerCase() === METODO) {
        soma += parseFloat(p.value ?? p.amount ?? 0) || 0;
      }
    }
    return round2(soma);
  }
  if (String(payment_method || '').toLowerCase() === METODO) return round2(totalAmount);
  return 0;
}

/** Soma do que não é crediário nem crédito da cliente (o pagamento de hoje). */
function somaDoPagamentoDeHoje(payments) {
  let soma = 0;
  for (const p of payments || []) {
    const m = String((p && p.method) || '').toLowerCase();
    if (m === 'crediario' || m === METODO) continue;
    const v = parseFloat(p.value ?? p.amount ?? 0) || 0;
    if (v > 0) soma += v;
  }
  return round2(soma);
}

/**
 * Crédito que a cliente pode usar na loja. Positivo = disponível; zero quando
 * ela deve, está quitada ou o saldo negativo não veio de crédito.
 *
 * Só conta o crédito de ORIGEM conhecida (17/11/2026, medido em produção):
 * a troca com "Crédito para" (payment crediario_credito) e a devolução do
 * crediário (refund crediario_credito), menos o que já foi usado em venda.
 * O saldo negativo que vem de desconto de renegociação (crediario_ajuste) ou
 * de pagamento acima da dívida NÃO aparece no Caixa: lá a ficha pode estar
 * errada e o Caixa estaria oferecendo dinheiro que a cliente nunca deixou.
 * O teto continua sendo o saldo da ficha (quem deve noutra compra usa o
 * crédito só no que sobra).
 *
 * `travar` segura o saldo até o fim da transação (duas vendas ao mesmo tempo
 * não gastam o mesmo crédito).
 */
// Origem do crédito usado, gravada em `source` no débito da baixa
// (17/11/2026, revisão da Célia). Cada origem tem uma regra de receita:
//   - TROCA: a troca já lançou "Troca - Devolucao" como despesa confirmada
//     pelo valor devolvido (trocaV2.insertAggregateTransactions), inclusive
//     quando o valor foi para a ficha. A saída já está no Financeiro; a parte
//     da venda paga com esse crédito ENTRA na receita da venda.
//   - DEVOLUÇÃO do crediário (refund.js): não grava despesa nenhuma, só abate
//     a dívida e o "A Receber". O que a cliente pagou entrou como receita no
//     recebimento; a parte paga com esse crédito NÃO entra (regra do sinal).
const ORIGEM_TROCA = 'credito_troca';
const ORIGEM_DEVOLUCAO = 'credito_devolucao';

/**
 * O crédito disponível, por origem. `troca` e `devolucao` são o que sobra de
 * cada origem; `total` tem teto no saldo a favor da ficha. A troca é gasta
 * primeiro (ver `repartir`).
 */
async function saldoPorOrigem(client, { companyId, customerId, travar = false }) {
  if (!companyId || !customerId) return { total: 0, troca: 0, devolucao: 0 };
  if (travar) {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('credito_cliente:' || $1::text || ':' || $2::text, 0))`,
      [companyId, customerId]
    );
  }
  // Mesma conta da view customer_credit_balances (debit soma, o resto abate).
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(CASE type WHEN 'debit' THEN amount ELSE -amount END), 0) AS balance,
            COALESCE(SUM(amount) FILTER (WHERE type = 'payment' AND payment_method = 'crediario_credito'), 0) AS troca,
            COALESCE(SUM(amount) FILTER (WHERE type = 'refund' AND payment_method = 'crediario_credito'), 0) AS devolucao,
            COALESCE(SUM(amount) FILTER (WHERE type = 'debit' AND payment_method = $3 AND source = $4), 0) AS usado_devolucao,
            COALESCE(SUM(amount) FILTER (WHERE type = 'debit' AND payment_method = $3 AND source IS DISTINCT FROM $4), 0) AS usado_troca
       FROM customer_credit_transactions
      WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId, METODO, ORIGEM_DEVOLUCAO]
  );
  const r = rows[0] || {};
  const aFavor = Math.max(0, -(parseFloat(r.balance) || 0));
  const troca = round2(Math.max(0, (parseFloat(r.troca) || 0) - (parseFloat(r.usado_troca) || 0)));
  const devolucao = round2(Math.max(0, (parseFloat(r.devolucao) || 0) - (parseFloat(r.usado_devolucao) || 0)));
  return { total: round2(Math.min(aFavor, troca + devolucao)), troca, devolucao };
}

/** O total disponível (o que o Caixa mostra). */
async function saldoAFavor(client, opts) {
  return (await saldoPorOrigem(client, opts)).total;
}

/** Reparte o valor usado pelas origens: a troca primeiro. */
function repartir(amount, origens) {
  const deTroca = round2(Math.min(amount, origens.troca));
  return { deTroca, deDevolucao: round2(amount - deTroca) };
}

function erro(statusCode, code, message, extra) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}

/**
 * Confere o crédito pedido, dentro da transação da venda e antes do INSERT
 * da venda. Devolve { amount, saldoAntes } ou lança erro com statusCode/code.
 */
async function conferir(client, { companyId, customerId, amount, totalAmount, crediarioAmount, payments, signalSale }) {
  if (signalSale) {
    throw erro(422, 'CREDITO_NA_VENDA_COM_SINAL', 'A venda com sinal não usa o crédito da cliente.');
  }
  if (!customerId) {
    throw erro(422, 'CREDITO_EXIGE_CLIENTE', 'Para usar o crédito, escolha a cliente da venda.');
  }
  const restoDaVenda = round2(totalAmount - crediarioAmount);
  if (amount > restoDaVenda + 0.005) {
    throw erro(422, 'CREDITO_MAIOR_QUE_VENDA',
      `O crédito usado passa do valor da venda (R$ ${restoDaVenda.toFixed(2).replace('.', ',')}).`,
      { total_amount: totalAmount });
  }
  const origens = await saldoPorOrigem(client, { companyId, customerId, travar: true });
  const saldoAntes = origens.total;
  if (amount > saldoAntes + 0.005) {
    throw erro(422, 'CREDITO_INSUFICIENTE',
      `A cliente tem R$ ${saldoAntes.toFixed(2).replace('.', ',')} de crédito nesta loja.`,
      { saldo_a_favor: saldoAntes });
  }
  // Com `payments`, o que entra hoje tem de fechar com o resto. Sem essa
  // conferência o app poderia cobrar o crédito de novo (receita em dobro).
  if (Array.isArray(payments) && payments.length > 0) {
    const hoje = somaDoPagamentoDeHoje(payments);
    const falta = round2(totalAmount - crediarioAmount - amount);
    if (Math.abs(hoje - falta) > 0.01) {
      throw erro(422, 'CREDITO_PAGAMENTOS_NAO_BATEM',
        `Os pagamentos não fecham com o que falta pagar (R$ ${falta.toFixed(2).replace('.', ',')}).`,
        { falta_pagar: falta });
    }
  }
  const { deTroca, deDevolucao } = repartir(round2(amount), origens);
  // Na receita da venda entra só a parte de crédito de troca (ver ORIGEM_TROCA).
  return { amount: round2(amount), saldoAntes, deTroca, deDevolucao, naReceita: deTroca };
}

/**
 * 17/11/2026 (J, aprovado pelo Caio): a venda no crediário de uma cliente que
 * tem crédito de origem conhecida (troca, devolução) e não usou todo ele é
 * recusada, com o saldo, para o Caixa usar o crédito primeiro. Sem isso o
 * createCreditSale abria o "A Receber" e as parcelas pelo valor cheio,
 * ignorando o crédito (a ficha abatia, o Financeiro cobrava a mais).
 *
 * Escolhido no lugar de abater dentro do createCreditSale: nada muda no
 * razão, nas parcelas nem no "A Receber" de ninguém; só a venda dessa
 * cliente pede um passo a mais, e o crédito sai pela forma credito_cliente,
 * com a receita certa por origem.
 *
 * `restante`: o que sobra de crédito depois do usado nesta venda (quando a
 * venda já usou crédito, o `conferir` já leu e travou o saldo). Sem ele, lê.
 * Venda com sinal fica fora (o sinal não usa crédito; ver `conferir`).
 */
async function exigirCreditoAntesDoCrediario(client, { companyId, customerId, crediarioAmount, restante }) {
  if (!(crediarioAmount > 0.005) || !customerId) return;
  const sobra = restante !== undefined
    ? round2(restante)
    : await saldoAFavor(client, { companyId, customerId });
  if (sobra > 0.005) {
    throw erro(422, 'CREDITO_ANTES_DO_CREDIARIO',
      `A cliente tem R$ ${sobra.toFixed(2).replace('.', ',')} de crédito nesta loja. Use o crédito na venda antes de lançar no crediário.`,
      { saldo_a_favor: sobra });
  }
}

/** Baixa do crédito no razão, presa à venda: um débito por origem usada. */
async function baixar(client, { companyId, customerId, saleId, saleNumber, deTroca, deDevolucao, createdBy }) {
  const nota = saleNumber != null ? `Crédito usado na venda #${saleNumber}` : 'Crédito usado na venda';
  const linhas = [];
  for (const [valor, origem] of [[deTroca, ORIGEM_TROCA], [deDevolucao, ORIGEM_DEVOLUCAO]]) {
    if (!(valor > 0.005)) continue;
    const { rows } = await client.query(
      `INSERT INTO customer_credit_transactions
         (company_id, customer_id, sale_id, type, amount, payment_method, notes, created_by, source)
       VALUES ($1, $2, $3, 'debit', $4, $5, $6, $7, $8)
       RETURNING id`,
      [companyId, customerId, saleId, round2(valor), METODO, nota, createdBy || null, origem]
    );
    linhas.push(rows[0] || null);
  }
  return linhas;
}

/** Crédito usado numa venda (0 quando não usou). */
async function usadoNaVenda(q, { companyId, saleId }) {
  try {
    const { rows } = await q.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM customer_credit_transactions
        WHERE sale_id = $1 AND company_id = $2 AND type = 'debit' AND payment_method = $3`,
      [saleId, companyId, METODO]
    );
    return round2(rows[0]?.total || 0);
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return 0;
    throw e;
  }
}

// Filtro SQL: o débito é de venda no crediário (e não crédito usado).
// `alias` é o da customer_credit_transactions na consulta.
function naoEhCreditoUsado(alias) {
  const col = alias ? `${alias}.payment_method` : 'payment_method';
  return `${col} IS DISTINCT FROM '${METODO}'`;
}

module.exports = {
  METODO,
  ORIGEM_TROCA,
  ORIGEM_DEVOLUCAO,
  saldoPorOrigem,
  repartir,
  exigirCreditoAntesDoCrediario,
  valorPedido,
  somaDoPagamentoDeHoje,
  saldoAFavor,
  conferir,
  baixar,
  usadoNaVenda,
  naoEhCreditoUsado,
};
