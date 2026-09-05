// ============================================================
// AURA Studio — a cotacao do pedido em lote
//
// ── UMA ESCADA SO (04/09/2026) ─────────────────────────────────────────
// Ate hoje o lote tinha uma tabela FIXA nossa (10/20/50/100 → 5/10/15/20%)
// e o produto avulso usava a escada que a LOJISTA configura em
// `studio_pricing_rules.qty_tiers`. Na mesma caneca, a pagina do produto
// dizia "10 ja da 10%" e o orcamento em lote dizia "faltam 8 para 10%".
// Sem faixa cadastrada, o lote inventava 5% que a lojista nunca deu.
//
// Decisao do Caio: uma escada, personalizavel por ela. O lote passa a
// ler a MESMA tabela do produto, pelas MESMAS funcoes
// (services/studioQtyTiers.js). Sem faixa cadastrada, nao ha desconto —
// o preco de tabela vezes a quantidade, e ponto.
//
// ── PRAZO POR FAIXA ────────────────────────────────────────────────────
// A mesma tabela ganha `lead_days`: quantos dias uteis a lojista leva
// para produzir aquela faixa. Cinquenta canecas nao ficam prontas no
// prazo de uma. Sem `lead_days` na faixa, o lote diz "a loja informa" —
// que e verdade, e nao um numero inventado.
//
// Este modulo continua sendo a UNICA porta da cotacao de lote: o painel
// (studioBulkHub) e a loja publica (studioStorefront) importam daqui.
// ============================================================
'use strict';

const { unitPriceForQty, buildLadder, leadDaysForQty } = require('./studioQtyTiers');

/**
 * As faixas no formato que a tela do lote desenha: `from`, `pct`, `label`.
 *
 * Deriva de `buildLadder`, que ja calcula o desconto de cada faixa em
 * relacao ao preco de tabela. Faixa sem desconto nao vira degrau — nao
 * ha "proximo degrau" para uma faixa que nao muda o preco.
 */
function faixasParaTela(basePrice, rawTiers) {
  return buildLadder(basePrice, rawTiers).map((f) => ({
    from: f.min_qty,
    pct: f.discount_pct,
    label: `${f.discount_pct}% off acima de ${f.min_qty}`,
    lead_days: f.lead_days ?? null,
  }));
}

/**
 * A cotacao completa de um lote. Uma conta, dois consumidores.
 *
 * `unit_price` e o preco DE TABELA, e `discount_pct` o desconto que a
 * faixa da lojista aplica sobre ele — a tela do lote calcula o proximo
 * degrau a partir desse par, e o painel grava os dois no evento.
 *
 * Arredonda no fim, como o painel sempre fez — mudar o arredondamento
 * aqui mudaria o total de eventos que ja existem.
 */
function cotarLote(qty, unitPrice, rawTiers) {
  const n = Math.max(0, Math.floor(Number(qty) || 0));
  const tabela = Math.max(0, Number(unitPrice) || 0);

  const unitario = n > 0 ? unitPriceForQty(tabela, rawTiers, n) : tabela;
  const pct = tabela > 0
    ? Math.round(((tabela - unitario) / tabela) * 1000) / 10
    : 0;

  const cheio = tabela * n;
  const total = +(unitario * n).toFixed(2);

  return {
    qty: n,
    unit_price: tabela,
    discount_pct: pct,
    total_amount: total,
    savings: +(cheio - total).toFixed(2),
    tiers: faixasParaTela(tabela, rawTiers),
    // null = "a loja informa". E o que a tela escreve; nao e um numero.
    prazo_dias: n > 0 ? leadDaysForQty(rawTiers, n) : null,
  };
}

module.exports = { faixasParaTela, cotarLote };
