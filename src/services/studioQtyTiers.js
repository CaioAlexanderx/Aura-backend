// ============================================================
// AURA Studio — Desconto progressivo por quantidade (S6)
//
// `studio_pricing_rules.qty_tiers` existe desde o configurador de preço
// do lojista, mas NUNCA foi aplicado na loja: o único código que lia o
// campo era o simulador de custo em studioPricing.js, que calcula preço
// sugerido a partir de custo + mão de obra + margem. Isso é outra coisa.
//
// Aqui o tier incide sobre o PREÇO DE VENDA do produto, que é o que o
// cliente vê. E, principalmente, nada de custo, mão de obra ou margem
// atravessa para o payload público — o simulador não pode ser reusado
// justamente por misturar as duas coisas.
//
// Forma de cada faixa (mesma que o configurador grava):
//   { min_qty, max_qty|null, unit_price?, unit_multiplier? }
//
// `unit_price` manda sobre `unit_multiplier` quando os dois vêm: preço
// fixo de faixa é uma decisão explícita da lojista, multiplicador é
// derivado.
// ============================================================
'use strict';

function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function parseTiers(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];

  const out = [];
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const min = num(t.min_qty);
    if (min == null || min < 1) continue;              // faixa sem inicio nao vale
    const max = t.max_qty == null ? null : num(t.max_qty);
    if (max != null && max < min) continue;            // faixa invertida: ignora
    const unitPrice = t.unit_price == null ? null : num(t.unit_price);
    const mult      = t.unit_multiplier == null ? null : num(t.unit_multiplier);
    if (unitPrice == null && mult == null) continue;   // faixa que nao muda nada
    // unit_price <= 0 sai fora, nao so o negativo: faixa gratuita nao
    // existe no configurador da lojista, e `unit_price: 0` (ou um null que
    // vira 0 no caminho) entregaria o produto DE GRACA. Achado pelo teste
    // do lado do app, onde Number(null) === 0 passava pela guarda.
    if (unitPrice != null && unitPrice <= 0) continue;
    if (mult != null && mult <= 0) continue;
    out.push({ min_qty: min, max_qty: max, unit_price: unitPrice, unit_multiplier: mult });
  }
  // Ordena por min_qty: a primeira faixa que casar vence, e o configurador
  // nao garante ordem.
  return out.sort((a, b) => a.min_qty - b.min_qty);
}

function matchTier(tiers, qty) {
  const q = parseInt(qty, 10);
  if (!Number.isFinite(q) || q < 1) return null;
  // Da maior faixa para a menor: com faixas sobrepostas, o cliente que
  // compra mais nunca paga mais.
  for (let i = tiers.length - 1; i >= 0; i--) {
    const t = tiers[i];
    if (q >= t.min_qty && (t.max_qty == null || q <= t.max_qty)) return t;
  }
  return null;
}

function applyTier(basePrice, tier) {
  const base = num(basePrice) || 0;
  if (!tier) return base;
  if (tier.unit_price != null) return tier.unit_price;
  if (tier.unit_multiplier != null) return base * tier.unit_multiplier;
  return base;
}

/**
 * Preço unitário do produto para uma quantidade.
 * Sem faixa aplicável devolve o preço de tabela — nunca encarece.
 */
function unitPriceForQty(basePrice, rawTiers, qty) {
  const tiers = parseTiers(rawTiers);
  if (!tiers.length) return num(basePrice) || 0;
  const preco = applyTier(basePrice, matchTier(tiers, qty));
  const base = num(basePrice) || 0;
  // Uma faixa que sai mais cara que o preco de tabela e erro de cadastro,
  // e o cliente nao pode pagar por ele. A escada exibida usa o mesmo teto.
  return preco > base ? base : preco;
}

/**
 * Escada para exibir na página: uma linha por faixa, já com o preço
 * unitário resultante e o desconto em relação ao preço de tabela.
 * Só sai o que o cliente pode ver — nenhum campo de custo.
 */
function buildLadder(basePrice, rawTiers) {
  const base = num(basePrice) || 0;
  const tiers = parseTiers(rawTiers);
  if (!tiers.length || base <= 0) return [];

  return tiers
    .map((t) => {
      const unit = Math.min(applyTier(base, t), base);
      return {
        min_qty: t.min_qty,
        max_qty: t.max_qty,
        unit_price: Math.round(unit * 100) / 100,
        discount_pct: Math.round(((base - unit) / base) * 1000) / 10,
      };
    })
    // Faixa sem desconto nenhum nao merece uma linha na vitrine.
    .filter((l) => l.discount_pct > 0);
}

module.exports = { parseTiers, matchTier, unitPriceForQty, buildLadder };
