// ============================================================
// AURA. — Concluir o pedido do balcao pela venda do Caixa (B5a / p-62c, 17/11/2026)
//
// O Caixa conclui o pedido guardado com o POST /pdv/sale de sempre, mais
// `order_id` no corpo. O pdv.js chama estas funcoes DENTRO da transacao da
// venda, no molde do Matcon (matconSaleHooks) e da Comanda (comandaSaleHooks):
// sem order_id nada daqui toca o banco e a venda e a de hoje, byte a byte
// (__tests__/pdv.vendaRapida.banco.test.js prova nos dois caminhos).
//
//   pedidoDoCorpo(req, { signalSale })      antes de abrir a transacao
//     - order_id junto com comanda_id, quote_id ou a venda com sinal: 422
//       PEDIDO_COM_OUTRO_VINCULO (cada um fecha uma coisa diferente);
//     - id fora do formato, ou a trava PEDIDO_LIBERADO desligada para quem
//       nao e da equipe: 404 PEDIDO_NAO_ENCONTRADO (o recurso nao existe
//       para o lojista; ignorar o campo seria vender o valor cheio de novo).
//
//   travarPedido(client, { companyId, orderId })   logo depois do BEGIN
//     SELECT ... FOR UPDATE do pedido: mesma loja, origem 'balcao', aberto
//     (confirmed, preparing, ready). Duas conclusoes ao mesmo tempo: a
//     segunda espera a primeira e recebe 409 PEDIDO_JA_CONCLUIDO. Le o SINAL
//     DO SERVIDOR (studio_payments deposit pago, o do B4a), nunca do corpo.
//
//   valoresDaConclusao(...)   a conta do dinheiro (regra do Caio, D-S1 = A):
//     - a venda nasce com o VALOR CHEIO (o unico faturamento);
//     - saldo = total - sinal. O sinal maior que a venda (a cliente tirou
//       peca) e 422 nesta fase: a sobra do sinal e do card B5b;
//     - crediario pela regra de hoje (parte 'crediario' dos pagamentos, ou a
//       forma 'crediario' sozinha = o saldo inteiro; cliente obrigatorio),
//       nunca maior que o saldo (422);
//     - cashAmount = total - crediario - sinal: os sale_payments e a receita
//       pdv-sale-<venda> levam SO o que entrou hoje. O Painel soma sinal (no
//       dia do sinal) + hoje = valor cheio, uma vez so. A taxa da maquininha
//       sai dos pagamentos de hoje (a do sinal ja foi lancada no B4a);
//     - com `payments`, a soma do que nao e crediario tem de bater com o que
//       falta hoje (422 PEDIDO_PAGAMENTOS_NAO_BATEM): o app nao consegue
//       cobrar o sinal de novo nem deixar o caixa diferente da receita.
//
//   afterSaleInsert(client, { companyId, sale, pedido })   depois dos pagamentos
//     - o pedido vira 'delivered' com sale_id e delivered_at, SEM
//       stock_deducted: quem baixou o estoque foi a venda, pelo caminho normal
//       (a Troca so oferece pedido online com stock_deducted, e o pedido do
//       balcao nunca o tem);
//     - sales.order_id e o promised_date do pedido vao para a venda;
//     - a conta "Pedido a receber" (pedido-areceber-<pedido>) vai a
//       'cancelled' com a nota "Quitada pela venda #N" — NUNCA 'confirmed'
//       (somaria com a pdv-sale e com o sinal). Sinal igual ao total ja a
//       tinha quitado no B4a: aqui nada muda nela.
//
//   CANCELAR / DESFAZER A VENDA DO PEDIDO (revisao da Celia, 17/11): recusado
//     com 409 ORDER_SALE em todo caminho que cancela a venda ou tira item dela
//     (DELETE /pdv/sale/:id, POST /sales/:id/cancel, DELETE
//     /transactions/:tx/sale-items/:item). Cancelar devolveria o estoque e a
//     pdv-sale, mas o pedido ficaria 'delivered' e o sinal sem destino. O
//     B5b tira esta trava quando o cancelamento reabrir o pedido. Venda sem
//     order_id: os caminhos sao os de hoje (a coluna so e lida junto).
//     Editar venda tem a trava propria (editarVenda.js, ORDER_SALE).
//
// Fica para o B5b: sobra do sinal (credito na ficha ou devolucao) e a linha
// "Sinal ja recebido" no cupom e no detalhe da venda. Condicao da Celia para
// o B5b: quando a cliente gastar o credito do sinal numa venda, essa parte
// nao pode lancar receita no Painel de novo.
//
// Multi-CNPJ: o pedido e da loja da venda (company_id = :id). Pedido de outra
// loja, mesmo do grupo, e 404: "Concluir na [loja]" troca a loja do Caixa
// antes (app, card A5b).
// ============================================================
'use strict';

const { pedidoLiberado } = require('./pedidoBalcao');
const { CHAVE_A_RECEBER } = require('./sinalDoPedido');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABERTOS = ['confirmed', 'preparing', 'ready'];

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const brl = (n) => `R$ ${round2(n).toFixed(2).replace('.', ',')}`;

// Texto novo (lista para o Caio aprovar).
const TEXTO_CANCELAR_VENDA_DO_PEDIDO = 'Esta venda concluiu um pedido. Cancele pelo pedido.';

/** Corpo do 409 de quem tenta cancelar a venda de um pedido; null = venda comum. */
function recusaDoCancelamento(orderId) {
  if (!orderId) return null;
  return { error: TEXTO_CANCELAR_VENDA_DO_PEDIDO, code: 'ORDER_SALE' };
}

function erro(statusCode, code, message, extra) {
  return Object.assign(new Error(message), { statusCode, code, ...(extra || {}) });
}

/**
 * O order_id do corpo, conferido sem banco. null = venda comum (nada daqui
 * roda). Lanca erro com statusCode/code para o handleSale responder.
 */
function pedidoDoCorpo(req, { signalSale = false } = {}) {
  const body = (req && req.body) || {};
  const raw = body.order_id;
  if (raw === undefined || raw === null || raw === '') return null;
  if (body.comanda_id || body.quote_id || signalSale) {
    throw erro(422, 'PEDIDO_COM_OUTRO_VINCULO',
      'A venda que conclui um pedido não pode cobrar comanda, orçamento ou sinal ao mesmo tempo. Conclua o pedido sozinho.');
  }
  const orderId = String(raw);
  if (!UUID_RE.test(orderId) || !pedidoLiberado(req)) {
    throw erro(404, 'PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado.');
  }
  return orderId.toLowerCase();
}

/**
 * Trava o pedido (FOR UPDATE) e le o sinal pago. Dentro da transacao da venda.
 * Devolve { id, order_number, status, total, customer_id, promised_date, sinal }.
 */
async function travarPedido(client, { companyId, orderId }) {
  const { rows } = await client.query(
    `SELECT id, order_number, origem, status::text AS status, total, customer_id,
            promised_date::text AS promised_date, sale_id
       FROM digital_orders
      WHERE id = $1 AND company_id = $2
      FOR UPDATE`,
    [orderId, companyId]
  );
  const p = rows[0];
  if (!p || p.origem !== 'balcao') throw erro(404, 'PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado.');
  if (p.status === 'delivered') {
    throw erro(409, 'PEDIDO_JA_CONCLUIDO', `O pedido ${p.order_number} já foi concluído no Caixa. Confira em Vendas antes de vender de novo.`);
  }
  if (p.status === 'cancelled') {
    throw erro(409, 'PEDIDO_CANCELADO', `O pedido ${p.order_number} foi cancelado e não pode ser concluído.`);
  }
  if (!ABERTOS.includes(p.status)) {
    throw erro(409, 'PEDIDO_FECHADO', `O pedido ${p.order_number} não está aberto.`);
  }
  // So o sinal que o Caixa registrou (registrarSinal grava a forma e a
  // entrada "Sinal de pedido"). Um deposito marcado pago por outra rota (Studio:
  // POST /studio/orders/:oid/payments, mark-paid) nao tem forma nem dinheiro
  // lancado: descontar esse valor da venda seria cobrar menos sem o dinheiro
  // ter entrado (revisao do Fable, 18/11).
  const { rows: [s] } = await client.query(
    `SELECT COALESCE(SUM(amount), 0) AS v FROM studio_payments
      WHERE order_id = $1 AND company_id = $2 AND kind = 'deposit' AND status = 'paid'
        AND forma IS NOT NULL`,
    [orderId, companyId]
  );
  return {
    id: p.id,
    order_number: p.order_number,
    status: p.status,
    total: round2(p.total),
    customer_id: p.customer_id || null,
    promised_date: p.promised_date || null,
    sinal: round2(Number(s && s.v) || 0),
  };
}

/**
 * Os valores da venda que conclui o pedido. `totalAmount` e o total que o
 * servidor calculou (itens, cupom, desconto). Sem banco.
 * Devolve { sinal, saldo, creditAmount, cashAmount }.
 */
function valoresDaConclusao({ pedido, totalAmount, payment_method, payments, customerId }) {
  const total = round2(totalAmount);
  const sinal = round2(pedido.sinal);
  if (sinal > total + 0.004) {
    throw erro(422, 'PEDIDO_SINAL_MAIOR_QUE_VENDA',
      `O sinal já pago (${brl(sinal)}) passou do valor desta venda (${brl(total)}). Volte as peças do pedido para o carrinho antes de concluir.`,
      { sinal, total_amount: total });
  }
  const saldo = round2(total - sinal);

  // Crediario: a regra de hoje, sobre o saldo.
  const lista = Array.isArray(payments) && payments.length > 0 ? payments : null;
  let credito = 0;
  if (lista) {
    for (const p of lista) {
      if (String((p && p.method) || '').toLowerCase() === 'crediario') credito += parseFloat(p.value ?? p.amount ?? 0);
    }
    credito = round2(credito);
  } else if (String(payment_method || '').toLowerCase() === 'crediario') {
    credito = saldo;
  }
  const creditAmount = (credito > 0 && customerId) ? credito : 0;
  if (creditAmount > saldo + 0.004) {
    throw erro(422, 'PEDIDO_CREDIARIO_MAIOR',
      `O crediário (${brl(creditAmount)}) passou do que falta pagar (${brl(saldo)}). O sinal de ${brl(sinal)} já foi pago.`,
      { falta: saldo, sinal });
  }
  const cashAmount = round2(saldo - creditAmount);

  if (lista) {
    let hoje = 0;
    for (const p of lista) {
      if (String((p && p.method) || '').toLowerCase() === 'crediario') continue;
      const v = parseFloat(p.value ?? p.amount ?? 0);
      if (v > 0) hoje += v;
    }
    hoje = round2(hoje);
    if (Math.abs(hoje - cashAmount) > 0.01) {
      throw erro(422, 'PEDIDO_PAGAMENTOS_NAO_BATEM',
        `Os pagamentos de hoje (${brl(hoje)}) não batem com o que falta receber (${brl(cashAmount)}). O sinal de ${brl(sinal)} já foi pago e não se cobra de novo.`,
        { falta: cashAmount, pagamentos: hoje, sinal });
    }
  }
  return { sinal, saldo, creditAmount, cashAmount };
}

/**
 * Fecha o pedido com a venda. Dentro da transacao, depois dos pagamentos.
 * Devolve o resumo que vai na resposta da venda (`pedido`).
 */
async function afterSaleInsert(client, { companyId, sale, pedido, valores }) {
  const { rowCount } = await client.query(
    `UPDATE digital_orders
        SET status = 'delivered', sale_id = $1, delivered_at = NOW(), updated_at = NOW()
      WHERE id = $2 AND company_id = $3 AND origem = 'balcao'
        AND status::text = ANY($4::text[])`,
    [sale.id, pedido.id, companyId, ABERTOS]
  );
  if (rowCount !== 1) {
    // Nao deveria acontecer (o pedido esta travado desde o BEGIN).
    throw erro(409, 'PEDIDO_JA_CONCLUIDO', `O pedido ${pedido.order_number} mudou enquanto a venda era gravada. Confira em Pedidos.`);
  }

  const comData = !!pedido.promised_date;
  await client.query(
    `UPDATE sales SET order_id = $1${comData ? ', promised_date = $4::date' : ''}
      WHERE id = $2 AND company_id = $3`,
    comData ? [pedido.id, sale.id, companyId, pedido.promised_date] : [pedido.id, sale.id, companyId]
  );
  sale.order_id = pedido.id;
  if (comData) sale.promised_date = pedido.promised_date;

  const nota = `Quitada pela venda #${sale.sale_number != null ? sale.sale_number : String(sale.id).slice(0, 8)}`;
  await client.query(
    `UPDATE transactions
        SET status = 'cancelled',
            notes = CASE WHEN COALESCE(notes, '') = '' THEN $1 ELSE notes || ' · ' || $1 END,
            updated_at = NOW()
      WHERE idempotency_key = $2 AND company_id = $3 AND status = 'pending'`,
    [nota, CHAVE_A_RECEBER(pedido.id), companyId]
  );

  return {
    id: pedido.id,
    order_number: pedido.order_number,
    status: 'delivered',
    total_pedido: pedido.total,
    sinal_pago: valores.sinal,
    recebido_hoje: valores.cashAmount,
    no_crediario: valores.creditAmount,
  };
}

module.exports = {
  TEXTO_CANCELAR_VENDA_DO_PEDIDO,
  recusaDoCancelamento,
  pedidoDoCorpo,
  travarPedido,
  valoresDaConclusao,
  afterSaleInsert,
};
