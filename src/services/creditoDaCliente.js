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
 * Saldo a favor da cliente na loja. Positivo = crédito disponível; zero quando
 * ela deve ou está quitada. `travar` segura o saldo até o fim da transação
 * (duas vendas ao mesmo tempo não gastam o mesmo crédito).
 */
async function saldoAFavor(client, { companyId, customerId, travar = false }) {
  if (!companyId || !customerId) return 0;
  if (travar) {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('credito_cliente:' || $1::text || ':' || $2::text, 0))`,
      [companyId, customerId]
    );
  }
  const { rows } = await client.query(
    `SELECT balance FROM customer_credit_balances WHERE company_id = $1 AND customer_id = $2`,
    [companyId, customerId]
  );
  const balance = parseFloat(rows[0]?.balance || 0) || 0;
  return balance < 0 ? round2(-balance) : 0;
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
  const saldoAntes = await saldoAFavor(client, { companyId, customerId, travar: true });
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
  return { amount: round2(amount), saldoAntes };
}

/** Baixa do crédito no razão, presa à venda. */
async function baixar(client, { companyId, customerId, saleId, saleNumber, amount, createdBy }) {
  const nota = saleNumber != null ? `Crédito usado na venda #${saleNumber}` : 'Crédito usado na venda';
  const { rows } = await client.query(
    `INSERT INTO customer_credit_transactions
       (company_id, customer_id, sale_id, type, amount, payment_method, notes, created_by)
     VALUES ($1, $2, $3, 'debit', $4, $5, $6, $7)
     RETURNING id`,
    [companyId, customerId, saleId, amount, METODO, nota, createdBy || null]
  );
  return rows[0] || null;
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
  valorPedido,
  somaDoPagamentoDeHoje,
  saldoAFavor,
  conferir,
  baixar,
  usadoNaVenda,
  naoEhCreditoUsado,
};
