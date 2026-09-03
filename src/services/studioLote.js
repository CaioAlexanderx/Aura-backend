// ============================================================
// AURA Studio — a escada de desconto do pedido em lote
//
// Ela nasceu dentro de routes/studioBulkHub.js, onde so o painel a lia.
// O redesign da vitrine (S0, 03/09/2026) trouxe o orcamento em lote para
// a loja publica, e a tabela passou a ter DOIS leitores.
//
// Escada de preco com duas implementacoes e a conta do cliente divergindo
// da conta da lojista: a pessoa fecha por R$ 538,80 na loja e o evento
// nasce no painel com outro total. Por isso a regra mora aqui, e os dois
// lados importam daqui.
//
// Isto NAO e `services/studioQtyTiers.js`. Aquele le a escada que a
// lojista configurou por produto (`studio_pricing_rules.qty_tiers`) e
// vale para a venda avulsa. Esta e a escada do LOTE, que hoje e igual
// para toda loja. Se um dia virar configuravel, vira aqui, uma vez.
// ============================================================
'use strict';

/**
 * As faixas, da maior para a menor.
 *
 * Ordem decrescente de proposito: `descontoPorQuantidade` devolve a
 * primeira que couber, e a primeira que cabe tem que ser a mais generosa.
 */
const FAIXAS = [
  { de: 100, pct: 20 },
  { de:  50, pct: 15 },
  { de:  20, pct: 10 },
  { de:  10, pct:  5 },
];

/** O percentual de desconto para uma quantidade. Zero abaixo de 10. */
function descontoPorQuantidade(qty) {
  const n = Math.floor(Number(qty) || 0);
  for (const f of FAIXAS) if (n >= f.de) return f.pct;
  return 0;
}

/**
 * As faixas no formato que a tela desenha, da menor para a maior.
 *
 * A tela mostra a escada inteira para a pessoa ver o proximo degrau
 * ("faltam 38 nomes para R$ 39,90 cada"), entao aqui sai crescente.
 */
function faixasParaTela() {
  return FAIXAS.slice().reverse().map((f) => ({
    from: f.de,
    pct: f.pct,
    label: `${f.pct}% off acima de ${f.de}`,
  }));
}

/**
 * A cotacao completa de um lote. Uma conta, dois consumidores.
 *
 * Arredonda no fim, como o painel sempre fez — mudar o arredondamento
 * aqui mudaria o total de eventos que ja existem.
 */
function cotarLote(qty, unitPrice) {
  const n = Math.max(0, Math.floor(Number(qty) || 0));
  const preco = Math.max(0, Number(unitPrice) || 0);
  const pct = descontoPorQuantidade(n);
  const cheio = preco * n;
  const total = +(cheio * (1 - pct / 100)).toFixed(2);
  return {
    qty: n,
    unit_price: preco,
    discount_pct: pct,
    total_amount: total,
    savings: +(cheio * (pct / 100)).toFixed(2),
    tiers: faixasParaTela(),
  };
}

module.exports = { FAIXAS, descontoPorQuantidade, faixasParaTela, cotarLote };
