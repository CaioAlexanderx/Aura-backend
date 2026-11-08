// ============================================================
// AURA. — Promocao em lote (De/Por): conta pura (p-84, 08/11/2026)
//
// Sem banco aqui: a rota (routes/productPromotions.js) le produtos e
// variantes, e este modulo valida o pedido e monta a previa item a item. A
// mesma funcao serve a previa (dry_run, padrao) e o aplicar (que refaz a
// conta com as linhas travadas na transacao).
//
// Contrato: side-session-notes/.../contrato-de-por.md (backend p-84/p-85,
// app p-86/p-87). Resumo:
//   - alvo {product_id} = o produto + cada variante ativa com price_override
//     (item proprio, igual ao Ajustar preco). Variante sem price_override
//     segue o produto e nao vira item.
//   - alvo {product_id, variant_id} = so aquela variante; base =
//     price_override ?? preco do produto.
//   - modo percent (valor em %), fixed (R$ a menos) ou preco (o "Por").
//     Terminacao ,90/,99/,00 so nos modos calculados, sempre para CIMA
//     (igual ao Ajustar preco); `preco_por` no alvo fixa o valor do item.
//   - abaixo do custo: sai sozinho (vai em `fora`), a menos que o alvo traga
//     aceitar_abaixo_do_custo: true (o "Incluir" da previa).
//   - quem ja esta em promocao (ativa ou agendada) e SUBSTITUIDO; a previa
//     marca ja_em_promocao e mostra a promocao atual.
//   - Por >= De nao e promocao: vai em `fora` (sem_desconto).
//
// Tudo em CENTAVOS inteiros para nao herdar erro de ponto flutuante.
// ============================================================
'use strict';

const { terminar } = require('./reajusteDePreco');
const { statusDaPromocao } = require('./precoEfetivo');

const MAX_ALVOS = 2000;
const MODOS = ['percent', 'fixed', 'preco'];
const TERMINACOES = ['none', '90', '99', '00'];
// NUMERIC(12,2) da 427 cabe mais, mas o "Por" e sempre menor que o "De"
// (NUMERIC(10,2)): 99.999.999,99.
const MAX_CENTS = 9999999999;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseNumero(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;
  let s = raw.replace(/R\$|%/g, '').trim();
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
}

/**
 * Data do pedido. ISO com hora (qualquer fuso) vale como veio. So o dia
 * (AAAA-MM-DD) vale no horario de Brasilia: comeco = 00:00:00, fim =
 * 23:59:59 do dia (regra do contrato).
 */
function lerData(raw, fimDoDia) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' && !(raw instanceof Date)) return undefined;
  if (typeof raw === 'string') {
    const m = DIA_RE.exec(raw.trim());
    if (m) {
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${fimDoDia ? '23:59:59' : '00:00:00'}-03:00`);
      return Number.isNaN(d.getTime()) ? undefined : d;
    }
  }
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Valida a lista de alvos. Devolve { alvos } ou { error, code }. */
function lerAlvos(raw, comPreco) {
  const erro = (error, code = 'INVALID_INPUT') => ({ error, code });
  if (!Array.isArray(raw) || raw.length === 0) return erro('targets deve ser uma lista com pelo menos um produto');
  if (raw.length > MAX_ALVOS) return erro(`No maximo ${MAX_ALVOS} itens por vez`, 'TOO_MANY_TARGETS');
  const vistos = new Map();
  for (const t of raw) {
    if (!t || typeof t !== 'object') return erro('targets tem um item invalido');
    const pid = String(t.product_id || '').trim();
    const vid = t.variant_id === undefined || t.variant_id === null || t.variant_id === '' ? null : String(t.variant_id).trim();
    if (!UUID_RE.test(pid)) return erro('targets tem um product_id invalido');
    if (vid !== null && !UUID_RE.test(vid)) return erro('targets tem um variant_id invalido');
    const alvo = { product_id: pid, variant_id: vid };
    if (comPreco) {
      if (t.preco_por !== undefined && t.preco_por !== null && t.preco_por !== '') {
        const n = parseNumero(t.preco_por);
        if (!Number.isFinite(n) || n <= 0) return erro('preco_por deve ser um valor maior que zero');
        alvo.precoPorCents = Math.round(n * 100);
      }
      if (t.aceitar_abaixo_do_custo !== undefined && typeof t.aceitar_abaixo_do_custo !== 'boolean') {
        return erro('aceitar_abaixo_do_custo deve ser true ou false');
      }
      alvo.aceitarAbaixo = t.aceitar_abaixo_do_custo === true;
    }
    vistos.set(`${pid}:${vid || ''}`, alvo);
  }
  return { alvos: [...vistos.values()] };
}

/** Corpo do POST /promotions. Devolve { input } ou { error, code }. */
function lerPedido(body, agora = new Date()) {
  const b = body || {};
  const erro = (error, code = 'INVALID_INPUT') => ({ error, code });

  const lidos = lerAlvos(b.targets, true);
  if (lidos.error) return lidos;

  if (!MODOS.includes(b.modo)) return erro('modo deve ser percent, fixed ou preco');
  const valor = parseNumero(b.valor);
  if (!Number.isFinite(valor) || valor <= 0) return erro('valor deve ser um numero maior que zero');
  if (b.modo === 'percent' && valor >= 100) return erro('O desconto deve ser menor que 100%');
  if (b.modo !== 'percent' && valor > 99999999.99) return erro('valor muito alto');

  const terminacao = b.terminacao === undefined || b.terminacao === null || b.terminacao === '' ? 'none' : String(b.terminacao);
  if (!TERMINACOES.includes(terminacao)) return erro('terminacao deve ser none, 90, 99 ou 00');

  const ini = b.starts_at === undefined || b.starts_at === null || b.starts_at === '' ? agora : lerData(b.starts_at, false);
  if (ini === undefined) return erro('starts_at deve ser uma data valida');
  const fim = lerData(b.ends_at, true);
  if (fim === undefined || fim === null) return erro('ends_at deve ser uma data valida');
  if (fim.getTime() <= ini.getTime()) return erro('O fim da promocao deve ser depois do comeco', 'INVALID_DATES');
  if (fim.getTime() <= agora.getTime()) return erro('O fim da promocao ja passou', 'INVALID_DATES');

  if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') return erro('dry_run deve ser true ou false');

  return {
    input: {
      alvos: lidos.alvos,
      modo: b.modo,
      valor,
      terminacao,
      startsAt: ini,
      endsAt: fim,
      dryRun: b.dry_run !== false,
    },
  };
}

/** Corpo do POST /promotions/encerrar. */
function lerPedidoEncerrar(body) {
  const b = body || {};
  const lidos = lerAlvos(b.targets, false);
  if (lidos.error) return lidos;
  if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') {
    return { error: 'dry_run deve ser true ou false', code: 'INVALID_INPUT' };
  }
  return { input: { alvos: lidos.alvos, dryRun: b.dry_run !== false } };
}

function paraCentavos(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const reais = (c) => (c === null || c === undefined ? null : c / 100);
const fracao = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);

function margem(precoCents, custoCents) {
  if (!custoCents || custoCents <= 0 || !precoCents || precoCents <= 0) return null;
  return fracao((precoCents - custoCents) / precoCents);
}

/** "Por" em centavos (antes de comparar com o "De" e o custo). */
function precoPor(baseCents, alvo, input) {
  if (alvo && alvo.precoPorCents !== undefined) return alvo.precoPorCents;
  const { modo, valor, terminacao } = input;
  let bruto;
  if (modo === 'preco') return Math.round(valor * 100);
  if (modo === 'percent') bruto = baseCents * (1 - valor / 100);
  else bruto = baseCents - Math.round(valor * 100);
  // Duas etapas para nao cair em 4791,999999 -> 4791.
  const c = Math.round(Math.round(bruto * 1000) / 1000);
  if (c <= 0) return c;
  return terminar(c, terminacao);
}

function promoAtual(row, agora) {
  const status = statusDaPromocao(row, agora);
  if (!status) return null;
  return {
    preco: Number(row.promo_price),
    starts_at: row.promo_starts_at,
    ends_at: row.promo_ends_at,
    status,
  };
}

/**
 * Lista de linhas (produto ou variante) que os alvos atingem, na ordem.
 * products: id, company_id, name, sku, price, cost_price, is_group_shared, promo_*
 * variants: id, product_id, price_override, label, promo_*
 * Devolve { linhas: [{alvo, produto, variante}], fora: [...] } (fora so
 * com nao_encontrado).
 */
function expandir(alvos, products, variants) {
  const prodPorId = new Map((products || []).map((p) => [String(p.id), p]));
  const varPorId = new Map((variants || []).map((v) => [String(v.id), v]));
  const varsDoProduto = new Map();
  for (const v of variants || []) {
    const k = String(v.product_id);
    if (!varsDoProduto.has(k)) varsDoProduto.set(k, []);
    varsDoProduto.get(k).push(v);
  }
  const ordem = (a, b) => String(a.label || '').localeCompare(String(b.label || ''), 'pt-BR') || String(a.id).localeCompare(String(b.id));

  const linhas = [];
  const fora = [];
  const vistas = new Set();
  // `exato`: a linha e a do proprio alvo (o preco_por do alvo vale so
  // para ela, nao para as variantes que o produto puxa junto).
  const add = (alvo, produto, variante, exato) => {
    const k = `${produto.id}:${variante ? variante.id : ''}`;
    if (vistas.has(k)) {
      if (exato) linhas.find((l) => `${l.produto.id}:${l.variante ? l.variante.id : ''}` === k).exato = alvo;
      return;
    }
    vistas.add(k);
    linhas.push({ alvo, produto, variante, exato: exato ? alvo : null });
  };
  for (const alvo of alvos) {
    const p = prodPorId.get(alvo.product_id);
    if (!p) { fora.push({ product_id: alvo.product_id, variant_id: alvo.variant_id, nome: null, motivo: 'nao_encontrado' }); continue; }
    if (alvo.variant_id) {
      const v = varPorId.get(alvo.variant_id);
      if (!v || String(v.product_id) !== String(p.id)) {
        fora.push({ product_id: alvo.product_id, variant_id: alvo.variant_id, nome: p.name, motivo: 'nao_encontrado' });
        continue;
      }
      add(alvo, p, v, true);
      continue;
    }
    add(alvo, p, null, true);
    const proprias = (varsDoProduto.get(String(p.id)) || []).filter((v) => v.price_override !== null && v.price_override !== undefined);
    for (const v of proprias.sort(ordem)) add(alvo, p, v, false);
  }
  return { linhas, fora };
}

/**
 * Previa da promocao. Devolve { items, fora } no formato do contrato, mais
 * os internos _promoCents em cada item (tirados por itemPublico).
 */
function montarPrevia({ products, variants, input, companyId, groupSize, agora = new Date() }) {
  const { linhas, fora } = expandir(input.alvos, products, variants);
  const items = [];
  for (const { alvo, produto: p, variante: v, exato } of linhas) {
    // Alvo explicito da linha (se houver) decide preco_por e o "Incluir".
    const dono = exato || alvo;
    const baseCents = v && v.price_override !== null && v.price_override !== undefined
      ? paraCentavos(v.price_override) : paraCentavos(p.price);
    const custoCents = paraCentavos(p.cost_price);
    const temCusto = custoCents !== null && custoCents > 0;
    const row = v || p;
    const comum = {
      product_id: p.id,
      variant_id: v ? v.id : null,
      nome: p.name,
      variant_label: v ? (v.label || null) : null,
      sku: p.sku || null,
    };
    if (!baseCents || baseCents <= 0) {
      fora.push({ ...comum, motivo: 'sem_preco', preco_de: reais(baseCents), preco_por: null });
      continue;
    }
    const porCents = Math.min(precoPor(baseCents, exato, input), MAX_CENTS);
    if (porCents <= 0) {
      fora.push({ ...comum, motivo: 'preco_invalido', preco_de: reais(baseCents), preco_por: null });
      continue;
    }
    if (porCents >= baseCents) {
      fora.push({ ...comum, motivo: 'sem_desconto', preco_de: reais(baseCents), preco_por: reais(porCents) });
      continue;
    }
    const abaixo = temCusto && porCents < custoCents;
    const atual = promoAtual(row, agora);
    const item = {
      ...comum,
      preco_de: reais(baseCents),
      preco_por: reais(porCents),
      desconto_pct: fracao((baseCents - porCents) / baseCents),
      ja_em_promocao: !!atual && atual.status !== 'encerrada',
      promo_atual: atual && atual.status !== 'encerrada' ? atual : null,
      abaixo_do_custo: abaixo,
      cost_price: temCusto ? reais(custoCents) : null,
      margem: { antes: margem(baseCents, custoCents), depois: margem(porCents, custoCents) },
      group_shared: !!p.is_group_shared && groupSize > 1,
      owner_is_other: String(p.company_id) !== String(companyId),
      _promoCents: porCents,
    };
    if (abaixo && !dono.aceitarAbaixo) {
      const { _promoCents, ...publico } = item;
      fora.push({ ...publico, motivo: 'abaixo_do_custo' });
      continue;
    }
    items.push(item);
  }
  return { items, fora };
}

/** Linhas que o encerrar limpa. Devolve { items, fora }. */
function montarEncerrar({ products, variants, input, agora = new Date() }) {
  const prodPorId = new Map((products || []).map((p) => [String(p.id), p]));
  const varPorId = new Map((variants || []).map((v) => [String(v.id), v]));
  const items = [];
  const fora = [];
  const vistas = new Set();
  const item = (p, v) => {
    const row = v || p;
    const baseCents = v && v.price_override !== null && v.price_override !== undefined
      ? paraCentavos(v.price_override) : paraCentavos(p.price);
    return {
      product_id: p.id,
      variant_id: v ? v.id : null,
      nome: p.name,
      variant_label: v ? (v.label || null) : null,
      preco_de: reais(baseCents),
      preco_por: Number(row.promo_price),
      status: statusDaPromocao(row, agora),
    };
  };
  const add = (p, v) => {
    const k = `${p.id}:${v ? v.id : ''}`;
    if (vistas.has(k)) return;
    vistas.add(k);
    items.push(item(p, v));
  };
  const comPromo = (r) => r && r.promo_price !== null && r.promo_price !== undefined;
  for (const alvo of input.alvos) {
    const p = prodPorId.get(alvo.product_id);
    if (!p) { fora.push({ product_id: alvo.product_id, variant_id: alvo.variant_id, nome: null, motivo: 'nao_encontrado' }); continue; }
    if (alvo.variant_id) {
      const v = varPorId.get(alvo.variant_id);
      if (!v || String(v.product_id) !== String(p.id)) {
        fora.push({ product_id: p.id, variant_id: alvo.variant_id, nome: p.name, motivo: 'nao_encontrado' });
      } else if (!comPromo(v)) {
        fora.push({ product_id: p.id, variant_id: v.id, nome: p.name, motivo: 'sem_promocao' });
      } else add(p, v);
      continue;
    }
    // Produto: limpa o produto e todas as variantes dele com promocao.
    const vs = (variants || []).filter((v) => String(v.product_id) === String(p.id) && comPromo(v));
    if (!comPromo(p) && vs.length === 0) {
      fora.push({ product_id: p.id, variant_id: null, nome: p.name, motivo: 'sem_promocao' });
      continue;
    }
    if (comPromo(p)) add(p, null);
    for (const v of vs) add(p, v);
  }
  return { items, fora };
}

function itemPublico(i) {
  const { _promoCents, ...resto } = i;
  return resto;
}

module.exports = {
  MAX_ALVOS,
  MODOS,
  TERMINACOES,
  lerPedido,
  lerPedidoEncerrar,
  lerData,
  precoPor,
  expandir,
  montarPrevia,
  montarEncerrar,
  itemPublico,
};
