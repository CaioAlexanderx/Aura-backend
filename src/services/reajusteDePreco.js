// ============================================================
// AURA. — Reajuste de preco em lote: conta pura (p-51, 30/10/2026)
//
// Sem banco aqui: a rota (routes/productPriceAdjustments.js) le os
// produtos e as variantes com preco proprio, e este modulo devolve a
// previa item a item. A mesma funcao serve a previa (dry_run) e o aplicar
// (que refaz a conta com as linhas travadas na transacao).
//
// Tudo em CENTAVOS inteiros para nao herdar erro de ponto flutuante
// (59,90 x 1,1 = 65,89000000000001).
//
// Modos (value em % nos tres primeiros, em reais no fixo):
//   percent  novo = atual x (1 +- value/100)
//   fixed    novo = atual +- value
//   markup   novo = custo x (1 + value/100)
//   margin   novo = custo / (1 - value/100)
// Terminacao (,90 / ,99 / ,00) sempre para CIMA.
//
// Sem custo (cost_price nulo ou 0): fica de fora no markup e na margem;
// no percentual e no fixo muda e a margem volta null.
// card_price nulo = automatico (o app calcula): continua nulo. Manual:
// acompanha na mesma proporcao do preco de venda.
// ============================================================
'use strict';

const MODES = ['percent', 'fixed', 'markup', 'margin'];
const ROUNDINGS = ['none', '90', '99', '00'];
const MAX_PRODUCTS = 2000;
// NUMERIC(10,2): 99.999.999,99
const MAX_CENTS = 9999999999;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseNumero(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;
  let s = raw.replace(/R\$|%/g, '').trim();
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
}

/**
 * Valida o corpo do POST. Devolve { input } ou { error, code }.
 */
function lerPedido(body) {
  const b = body || {};
  const erro = (error, code = 'INVALID_INPUT') => ({ error, code });

  if (!Array.isArray(b.product_ids) || b.product_ids.length === 0) {
    return erro('product_ids deve ser uma lista com pelo menos um produto');
  }
  const ids = [...new Set(b.product_ids.map((x) => String(x || '').trim()))];
  if (ids.length > MAX_PRODUCTS) {
    return erro(`No maximo ${MAX_PRODUCTS} produtos por reajuste`, 'TOO_MANY_PRODUCTS');
  }
  if (ids.some((x) => !UUID_RE.test(x))) return erro('product_ids tem um id invalido');

  if (!MODES.includes(b.mode)) return erro('mode deve ser percent, fixed, markup ou margin');
  const mode = b.mode;

  let direction = null;
  if (mode === 'percent' || mode === 'fixed') {
    if (b.direction !== 'up' && b.direction !== 'down') return erro('direction deve ser up ou down');
    direction = b.direction;
  }

  const value = parseNumero(b.value);
  if (!Number.isFinite(value) || value <= 0) return erro('value deve ser um numero maior que zero');
  if (mode === 'percent' && value > 1000) return erro('value em percent vai ate 1000');
  if (mode === 'percent' && direction === 'down' && value >= 100) return erro('Para diminuir, o percentual deve ser menor que 100');
  if (mode === 'fixed' && value > 100000) return erro('value em fixed vai ate 100000');
  if (mode === 'markup' && value > 10000) return erro('value em markup vai ate 10000');
  if (mode === 'margin' && value >= 100) return erro('A margem deve ser menor que 100');

  const rounding = b.rounding === undefined || b.rounding === null || b.rounding === '' ? 'none' : String(b.rounding);
  if (!ROUNDINGS.includes(rounding)) return erro('rounding deve ser none, 90, 99 ou 00');

  if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') return erro('dry_run deve ser true ou false');
  if (b.allow_below_cost !== undefined && typeof b.allow_below_cost !== 'boolean') return erro('allow_below_cost deve ser true ou false');

  return {
    input: {
      productIds: ids,
      mode,
      direction,
      value,
      rounding,
      dryRun: b.dry_run !== false,
      allowBelowCost: b.allow_below_cost === true,
    },
  };
}

function paraCentavos(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const reais = (c) => (c === null || c === undefined ? null : c / 100);
const fracao = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);

/** Sobe ate a terminacao pedida (em centavos). 5320 com '90' = 5390; com '00' = 5400. */
function terminar(cents, rounding) {
  if (rounding === 'none' || !rounding) return cents;
  const alvo = { 90: 90, 99: 99, '00': 0 }[rounding];
  const inteiro = Math.floor(cents / 100);
  let c = inteiro * 100 + alvo;
  if (c < cents) c += 100;
  return c;
}

/** Preco novo em centavos, ou null quando o modo precisa de custo e nao ha. */
function precoNovo(atualCents, custoCents, input) {
  const { mode, direction, value } = input;
  const sinal = direction === 'down' ? -1 : 1;
  let bruto;
  if (mode === 'percent') bruto = atualCents * (1 + (sinal * value) / 100);
  else if (mode === 'fixed') bruto = atualCents + sinal * Math.round(value * 100);
  else {
    if (!custoCents || custoCents <= 0) return null;
    bruto = mode === 'markup' ? custoCents * (1 + value / 100) : custoCents / (1 - value / 100);
  }
  // Duas etapas para nao cair em 6588,999999 -> 6588.
  const cents = Math.round(Math.round(bruto * 1000) / 1000);
  if (cents <= 0) return cents;
  return terminar(cents, input.rounding);
}

function margem(precoCents, custoCents) {
  if (!custoCents || custoCents <= 0 || !precoCents || precoCents <= 0) return null;
  return (precoCents - custoCents) / precoCents;
}

/**
 * Calcula um item (produto ou variante com preco proprio).
 * base: { product_id, variant_id, name, variant_label, sku, owner_company_id,
 *         is_group_shared, priceCents, costCents, cardCents (so produto) }
 */
function calcularItem(base, input, ctx) {
  const temCusto = base.costCents !== null && base.costCents > 0;
  const groupShared = !!base.is_group_shared && ctx.groupSize > 1;
  const ownerIsOther = base.owner_company_id !== ctx.companyId;
  const cardManual = base.variant_id === null && base.cardCents !== null && base.cardCents > 0;

  const item = {
    product_id: base.product_id,
    variant_id: base.variant_id,
    name: base.name,
    variant_label: base.variant_label || null,
    sku: base.sku || null,
    cost_price: temCusto ? reais(base.costCents) : null,
    price_before: reais(base.priceCents),
    price_after: null,
    change_abs: null,
    change_pct: null,
    margin_before: fracao(margem(base.priceCents, base.costCents)),
    margin_after: null,
    card_price_mode: base.variant_id !== null ? null : cardManual ? 'manual' : 'auto',
    card_price_before: cardManual ? reais(base.cardCents) : null,
    card_price_after: cardManual ? reais(base.cardCents) : null,
    below_cost: false,
    group_shared: groupShared,
    owner_company_id: base.owner_company_id,
    owner_is_other: ownerIsOther,
    status: 'change',
    skip_reason: null,
  };

  const novo = precoNovo(base.priceCents, base.costCents, input);
  if (novo === null) {
    return { ...item, card_price_after: null, status: 'skipped', skip_reason: 'no_cost' };
  }
  if (novo <= 0) {
    return { ...item, card_price_after: null, status: 'skipped', skip_reason: 'not_positive' };
  }
  const novoLimitado = Math.min(novo, MAX_CENTS);

  let cardDepois = cardManual ? base.cardCents : null;
  if (cardManual && base.priceCents > 0) {
    cardDepois = Math.min(Math.round((base.cardCents * novoLimitado) / base.priceCents), MAX_CENTS);
    if (cardDepois <= 0) cardDepois = base.cardCents;
  }

  item.price_after = reais(novoLimitado);
  item.change_abs = reais(novoLimitado - base.priceCents);
  item.change_pct = base.priceCents > 0 ? fracao((novoLimitado - base.priceCents) / base.priceCents) : null;
  item.margin_after = fracao(margem(novoLimitado, base.costCents));
  item.card_price_after = cardManual ? reais(cardDepois) : null;
  item.below_cost = temCusto && novoLimitado < base.costCents;
  // Internos para gravar (removidos da resposta).
  item._priceCents = novoLimitado;
  item._cardCents = cardDepois;

  if (novoLimitado === base.priceCents && (!cardManual || cardDepois === base.cardCents)) {
    item.status = 'unchanged';
  }
  return item;
}

/**
 * Monta a previa inteira.
 * products: linhas de products (id, company_id, name, sku, price, cost_price, card_price, is_group_shared)
 * variants: linhas de product_variants com preco proprio (id, product_id, price_override, label)
 */
function montarPrevia({ products, variants, input, companyId, groupSize }) {
  const ctx = { companyId, groupSize };
  const porProduto = new Map();
  for (const v of variants || []) {
    if (!porProduto.has(v.product_id)) porProduto.set(v.product_id, []);
    porProduto.get(v.product_id).push(v);
  }

  const ordenados = [...(products || [])].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR') || String(a.id).localeCompare(String(b.id)));

  const items = [];
  for (const p of ordenados) {
    const costCents = paraCentavos(p.cost_price);
    const comum = {
      product_id: p.id,
      name: p.name,
      sku: p.sku,
      owner_company_id: p.company_id,
      is_group_shared: p.is_group_shared,
      costCents,
    };
    items.push(calcularItem({
      ...comum, variant_id: null, variant_label: null,
      priceCents: paraCentavos(p.price) || 0,
      cardCents: paraCentavos(p.card_price),
    }, input, ctx));
    const vs = (porProduto.get(p.id) || []).sort((a, b) =>
      String(a.label || '').localeCompare(String(b.label || ''), 'pt-BR') || String(a.id).localeCompare(String(b.id)));
    for (const v of vs) {
      items.push(calcularItem({
        ...comum, variant_id: v.id, variant_label: v.label || null,
        priceCents: paraCentavos(v.price_override) || 0,
        cardCents: null,
      }, input, ctx));
    }
  }

  const encontrados = new Set((products || []).map((p) => String(p.id)));
  const notFoundIds = input.productIds.filter((id) => !encontrados.has(id));

  const mudam = items.filter((i) => i.status === 'change');
  const comMargem = mudam.filter((i) => i.margin_before !== null && i.margin_after !== null);
  const media = (k) => (comMargem.length ? fracao(comMargem.reduce((s, i) => s + i[k], 0) / comMargem.length) : null);
  const produtosQueMudam = new Set(mudam.map((i) => i.product_id));
  const produtosDeGrupo = new Set(items.filter((i) => i.group_shared).map((i) => i.product_id));
  const produtosDeOutra = new Set(items.filter((i) => i.owner_is_other).map((i) => i.product_id));

  const summary = {
    selected: input.productIds.length,
    not_found: notFoundIds.length,
    products_changed: mudam.filter((i) => i.variant_id === null).length,
    variants_changed: mudam.filter((i) => i.variant_id !== null).length,
    items_changed: mudam.length,
    unchanged: items.filter((i) => i.status === 'unchanged').length,
    skipped_no_cost: items.filter((i) => i.skip_reason === 'no_cost').length,
    skipped_not_positive: items.filter((i) => i.skip_reason === 'not_positive').length,
    below_cost: mudam.filter((i) => i.below_cost).length,
    group_shared: produtosDeGrupo.size,
    owner_is_other: produtosDeOutra.size,
    card_price_changed: mudam.filter((i) => i.card_price_mode === 'manual' && i.card_price_after !== i.card_price_before).length,
    margin_avg_before: media('margin_before'),
    margin_avg_after: media('margin_after'),
  };

  return { items, summary, notFoundIds, productsChangedCount: produtosQueMudam.size };
}

/** Tira os campos internos (_priceCents/_cardCents) antes de responder. */
function itemPublico(i) {
  const { _priceCents, _cardCents, ...resto } = i;
  return resto;
}

module.exports = {
  MAX_PRODUCTS,
  MODES,
  ROUNDINGS,
  lerPedido,
  terminar,
  precoNovo,
  calcularItem,
  montarPrevia,
  itemPublico,
  paraCentavos,
};
