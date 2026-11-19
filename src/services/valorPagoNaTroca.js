// ============================================================
// AURA. — Valor pago do item devolvido na troca (INC-2026-11-19-01)
//
// Defeito (medido em produção, 19/11/2026): a troca devolvia o item pelo
// preço de TABELA que o app mandava no payload (returned_items[].unit_price),
// sem o desconto do item (lápis) e sem a parte do desconto da venda inteira.
// Caso real: blusa de R$ 79,90 vendida com R$ 25,00 de desconto na venda
// (total R$ 54,90) virou R$ 79,90 de crédito na ficha. 7 trocas em 5 lojas
// desde 10/10.
//
// REGRA: o item devolvido vale o QUE A CLIENTE PAGOU por ele, calculado no
// servidor a partir da linha original. O unit_price do payload é ignorado
// para dinheiro (o campo continua aceito, só não vale).
//   - pago da linha = total_price da linha (já com o lápis) menos a parte
//     rateada do desconto da venda (sales.discount_amount ou
//     digital_orders.discount_amount), proporcional ao total de cada linha;
//   - o rateio é O MESMO da NFC-e (descontoDaVendaNaNfce.aplicarDescontoNasLinhas):
//     centavos inteiros, a sobra do arredondamento na maior linha (empate: a
//     primeira, na ordem de sale_items.id), frete fora do rateio. Assim a
//     devolução bate com o vDesc de cada item da nota original;
//   - pago por unidade = pago da linha / quantidade da linha, em centavos;
//   - devolução parcial e em mais de uma troca: o valor é proporcional à
//     quantidade, e a soma das devoluções da linha nunca passa do que foi
//     pago por ela (o que já voltou em trocas anteriores sai do teto; a
//     última unidade leva o que restou, para baixo, em centavos inteiros).
//
// Funções puras. Usadas por services/trocaV2.js (o que grava) e pelas buscas
// da troca (routes/pdv.js e services/trocaPedidoOnline.js — o que o app
// mostra: valor_pago_unit e valor_pago_total por item).
// ============================================================
'use strict';

const { centavos, aplicarDescontoNasLinhas, linhasDaVendaGravada, ehFrete } = require('./descontoDaVendaNaNfce');

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pago de cada linha da venda, em centavos, na ordem recebida.
 *
 * @param {object[]} itens linhas da venda/pedido: { quantity, unit_price,
 *   total_price, product_id, product_name_snapshot }. Sem total_price, a
 *   linha vale quantidade x preço (sem lápis).
 * @param {number|string} descontoVenda desconto da venda inteira, em reais
 * @returns {number[]} centavos pagos por linha
 */
function pagoPorLinhaC(itens, descontoVenda) {
  const lista = Array.isArray(itens) ? itens : [];
  if (!lista.length) return [];
  const normalizadas = lista.map((r) => {
    const quantity = num(r && r.quantity);
    const unit_price = num(r && r.unit_price);
    const temTotal = r && r.total_price !== undefined && r.total_price !== null && r.total_price !== ''
      && Number.isFinite(parseFloat(r.total_price));
    return {
      ...r,
      quantity, unit_price,
      total_price: temTotal ? parseFloat(r.total_price) : Math.round(quantity * unit_price * 100) / 100,
    };
  });
  const linhas = linhasDaVendaGravada(normalizadas);
  const brutos = linhas.map((l) => centavos(Math.round(l.quantity * l.unit_price * 100) / 100));
  const bases = linhas.map((l, i) => Math.max(0, brutos[i] - Math.min(Math.max(l.lapisC || 0, 0), brutos[i])));

  const descontoC = centavos(descontoVenda);
  if (!(descontoC > 0)) return bases;

  const r = aplicarDescontoNasLinhas(linhas, descontoC / 100);
  if (r.erro) {
    // Desconto cobre todo o valor dos produtos: a cliente não pagou nada por
    // eles. Frete (fora do rateio) segue com o próprio valor.
    return linhas.map((l, i) => (ehFrete(l) ? bases[i] : 0));
  }
  return r.itens.map((it, i) => Math.max(0, brutos[i] - centavos(it.discount || 0)));
}

/**
 * Valor pago por linha, em reais e centavos, pronto para a busca da troca.
 * @returns {{ linhaPagaC: number, unitPagoC: number, valor_pago_total: number, valor_pago_unit: number }[]}
 */
function valorPagoDasLinhas(itens, descontoVenda) {
  const pagos = pagoPorLinhaC(itens, descontoVenda);
  return pagos.map((linhaPagaC, i) => {
    const qty = num(itens[i] && itens[i].quantity);
    const unitPagoC = qty > 0 ? Math.round(linhaPagaC / qty) : 0;
    return {
      linhaPagaC,
      unitPagoC,
      valor_pago_total: linhaPagaC / 100,
      valor_pago_unit: unitPagoC / 100,
    };
  });
}

/**
 * Preço por unidade (centavos) desta devolução, com o teto do que ainda não
 * voltou da linha.
 *
 * @param {object} p
 * @param {number} p.unitPagoC     pago por unidade da linha (centavos)
 * @param {number} p.linhaPagaC    pago pela linha inteira (centavos)
 * @param {number} p.jaDevolvidoC  soma já devolvida desta linha em trocas
 *                                 anteriores não canceladas (centavos)
 * @param {number} p.qty           quantidade devolvida agora
 */
function unitarioDaDevolucaoC({ unitPagoC, linhaPagaC, jaDevolvidoC, qty }) {
  const q = num(qty);
  if (!(q > 0)) return 0;
  const restante = Math.max(0, num(linhaPagaC) - Math.max(0, num(jaDevolvidoC)));
  const unit = Math.max(0, Math.round(num(unitPagoC)));
  if (q * unit <= restante + 1e-6) return unit;
  return Math.max(0, Math.floor((restante + 1e-6) / q));
}

/**
 * Aplica a regra aos itens devolvidos de uma origem (venda ou pedido).
 * Reescreve ret.unit_price com o pago por unidade (reais). O valor do
 * payload fica em ret.unit_price_informado só para log.
 *
 * @param {object[]} devolvidos  itens devolvidos desta troca (mutados)
 * @param {object} ctx
 * @param {(ret) => string} ctx.chave            chave da linha original do item devolvido
 * @param {Map<string, {linhaPagaC, unitPagoC}>} ctx.pagoPorChave
 * @param {Map<string, number>} ctx.jaDevolvidoCPorChave  centavos já devolvidos
 */
function aplicarValorPago(devolvidos, { chave, pagoPorChave, jaDevolvidoCPorChave }) {
  const acumulado = new Map();
  for (const ret of devolvidos || []) {
    const k = chave(ret);
    const pago = pagoPorChave.get(k);
    if (!pago) continue;
    const qty = num(ret.quantity);
    const ja = (jaDevolvidoCPorChave.get(k) || 0) + (acumulado.get(k) || 0);
    const unitC = unitarioDaDevolucaoC({ unitPagoC: pago.unitPagoC, linhaPagaC: pago.linhaPagaC, jaDevolvidoC: ja, qty });
    const informado = parseFloat(ret.unit_price);
    if (Number.isFinite(informado) && Math.abs(Math.round(informado * 100) - unitC) > 0) {
      ret.unit_price_informado = informado;
    }
    ret.unit_price = unitC / 100;
    acumulado.set(k, (acumulado.get(k) || 0) + Math.round(qty * unitC));
  }
  return devolvidos;
}

/**
 * Busca da troca: acrescenta a cada item da venda/pedido o valor pago
 * (valor_pago_unit e valor_pago_total, em reais), pela mesma regra que a
 * troca usa ao gravar. Campos novos; nada renomeado. `descontoVenda` e o
 * desconto da venda inteira (sales.discount_amount / digital_orders.discount_amount).
 * Os itens precisam vir na ordem de sale_items.id (desempate do rateio).
 */
function comValorPago(row, descontoVenda) {
  if (!row || !Array.isArray(row.items) || !row.items.length) return row;
  const pagos = valorPagoDasLinhas(row.items, descontoVenda);
  row.items = row.items.map((it, i) => ({
    ...it,
    valor_pago_unit: pagos[i].valor_pago_unit,
    valor_pago_total: pagos[i].valor_pago_total,
  }));
  return row;
}

module.exports = {
  comValorPago,
  pagoPorLinhaC,
  valorPagoDasLinhas,
  unitarioDaDevolucaoC,
  aplicarValorPago,
};
