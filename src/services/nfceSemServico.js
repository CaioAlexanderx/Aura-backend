// ============================================================
// AURA. — Servico fora da NFC-e (10/11/2026)
//
// Servico e products.unit = 'srv'. A NFC-e (e a NF-e modelo 55 da venda,
// que usa a mesma rota) e nota de MERCADORIA: um servico la dentro sairia
// com NCM 00000000 e CFOP 5102, como se fosse produto. Decisao do dono:
// na venda mista os produtos saem na NFC-e e os servicos ficam de fora
// (vao numa NFS-e separada).
//
// 10/11/2026 (migration 442): a nota sai da regra unica do item
// (services/notaDoItem.js): products.nota_fiscal escolhe; sem escolha, segue
// o tipo (unit 'srv'), exatamente como antes.
//
// Funcoes puras, usadas por routes/nfce.js:
//   - separarServicos: divide os itens da venda em produtos e servicos.
//   - pagamentosDosProdutos: reduz os pagamentos da venda ao total da nota.
// ============================================================
'use strict';

const { ehUnidadeServico: isServicoUnit, vaiNaNfse } = require('./notaDoItem');

/**
 * Divide os itens em produtos e servicos. E servico o item cujo produto
 * (lido com a regra de visibilidade do grupo) tem unit 'srv', ou o item que
 * ja chega com unit 'srv' no corpo. Produto nao encontrado e item avulso sem
 * unit 'srv' seguem como produto — como sempre foram.
 *
 * Migration 442: a escolha do cadastro (products.nota_fiscal) vence o tipo.
 * Produto 'nfse' sai da nota (vai na NFS-e); servico 'nfce' fica na nota.
 * Produto achado no banco: vale o cadastro. Sem ele (item avulso, ou base
 * sem a 442), vale a escolha que vier no item do corpo.
 *
 * @param {object[]} items
 * @param {Map<string, {unit?: string}>} productById
 * @returns {{ produtos: object[], servicos: object[] }}
 *   Sem servico, `produtos` e o PROPRIO array recebido (mesma referencia).
 */
function separarServicos(items, productById) {
  const ehServico = (i) => {
    const p = i && typeof i.product_id === 'string' ? productById.get(i.product_id) : null;
    const tipoServico = isServicoUnit(i && i.unit) || !!(p && isServicoUnit(p.unit));
    const escolha = p && p.nota_fiscal !== undefined ? p.nota_fiscal : (i ? i.nota_fiscal : null);
    return vaiNaNfse({ nota_fiscal: escolha, unit: tipoServico ? 'srv' : null });
  };
  if (!items.some(ehServico)) return { produtos: items, servicos: [] };
  return {
    produtos: items.filter((i) => !ehServico(i)),
    servicos: items.filter(ehServico),
  };
}

/** Mesma conta do /nfce/emit: quantidade x preco - desconto. */
function totaisDosItens(items) {
  let totalProducts = 0, totalDiscount = 0;
  for (const item of items) {
    totalProducts += (Number(item.quantity) || 1) * (Number(item.unit_price || item.price) || 0);
    totalDiscount += Number(item.discount) || 0;
  }
  const total = Math.round((totalProducts - totalDiscount) * 100) / 100;
  return { totalProducts, totalDiscount, total };
}

/**
 * Pagamentos da NFC-e de uma venda mista.
 *
 * REGRA: cada forma de pagamento entra na nota na MESMA PROPORCAO em que
 * pagou a venda inteira: valor_na_nota = valor x (total da nota / total da
 * venda). Arredonda em centavos pelo metodo do maior resto, entao a soma
 * fecha EXATAMENTE no total da nota (vNF) — a SEFAZ rejeita soma menor que a
 * nota e o /emit recusa soma diferente. Forma que fica com 0,00 sai da lista.
 * Os demais campos de cada pagamento (indPag do crediario, troco/change)
 * seguem como vieram: o troco e dinheiro fisico devolvido e nao muda por o
 * servico ter saido da nota.
 *
 * Por que proporcional: e neutro e deterministico. Preencher "na ordem"
 * escolheria arbitrariamente qual forma pagou os produtos (por ex., poria
 * o crediario inteiro no servico, ou inteiro na nota) — a proporcao mantem
 * o retrato real da venda (quanto foi a prazo, quanto no cartao).
 *
 * @param {object[]} payments  pagamentos da venda (value em reais)
 * @param {number} totalNota   total dos produtos (vNF), ja arredondado
 * @returns {object[]}
 */
function pagamentosDosProdutos(payments, totalNota) {
  const cents = payments.map((p) => Math.round(Number(p.value) * 100));
  const somaC = cents.reduce((s, c) => s + c, 0);
  const alvoC = Math.round(Number(totalNota) * 100);
  if (somaC <= 0) return [];
  const base = cents.map((c) => Math.floor((c * alvoC) / somaC));
  let resto = alvoC - base.reduce((s, c) => s + c, 0);
  const ordem = cents
    .map((c, idx) => ({ idx, frac: (c * alvoC) / somaC - base[idx] }))
    .sort((a, b) => (b.frac - a.frac) || (a.idx - b.idx));
  for (let k = 0; resto > 0 && k < ordem.length; k++, resto--) base[ordem[k].idx] += 1;
  return payments
    .map((p, idx) => ({ ...p, value: base[idx] / 100 }))
    .filter((p) => p.value > 0);
}

module.exports = { isServicoUnit, separarServicos, totaisDosItens, pagamentosDosProdutos };
