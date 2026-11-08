// ============================================================
// AURA. — Preco efetivo (De/Por, p-84, 08/11/2026, migration 427)
//
// A regra UNICA de "que preco vale agora". Todo leitor que vende ou mostra
// preco usa este modulo; a migration 427 tem as funcoes SQL equivalentes
// (aura_em_promocao / aura_preco_efetivo) para consulta no banco, e o teste
// precoEfetivo.banco confere que as duas concordam.
//
//   em_promocao   = promo_price > 0 AND promo_price < base
//                   AND promo_starts_at <= agora AND promo_ends_at > agora
//   preco_efetivo = em_promocao ? promo_price : base
//
// `promo_price < base`: se a lojista baixar o preco normal para menos que o
// promocional, a promocao deixa de valer (o "Por" nunca fica acima do "De").
//
// Variante: base = price_override ?? price do produto. A promocao da propria
// variante vale para ela; variante SEM price_override e sem promocao propria
// ativa segue o produto (inclusive a promocao dele). Variante com
// price_override e item proprio: a promocao do produto nao passa para ela.
//
// Nada aqui depende de job: vencida a data, volta ao preco normal.
// Base sem a migration 427 (colunas ausentes, 42703): os leitores tentam
// com as colunas e, na falha, memorizam e leem sem elas (comColunasPromo).
// Sem as colunas a resposta traz os campos novos com promo nulo e
// preco_efetivo = preco normal, igual a hoje.
// ============================================================
'use strict';

const CAMPOS = ['promo_price', 'promo_starts_at', 'promo_ends_at'];

function numero(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function instante(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const cents = (n) => Math.round(n * 100);

/** A promocao vale agora para este preco base? */
function emPromocao(base, promo, agora = new Date()) {
  const b = numero(base);
  const p = numero(promo && promo.promo_price);
  const ini = instante(promo && promo.promo_starts_at);
  const fim = instante(promo && promo.promo_ends_at);
  if (b === null || p === null || !ini || !fim) return false;
  if (p <= 0 || cents(p) >= cents(b)) return false;
  const t = (agora instanceof Date ? agora : new Date(agora)).getTime();
  return ini.getTime() <= t && fim.getTime() > t;
}

/** Status de uma promocao gravada: null (sem), 'agendada', 'ativa' ou 'encerrada'. */
function statusDaPromocao(promo, agora = new Date()) {
  if (!promo || numero(promo.promo_price) === null) return null;
  const ini = instante(promo.promo_starts_at);
  const fim = instante(promo.promo_ends_at);
  if (!ini || !fim) return null;
  const t = (agora instanceof Date ? agora : new Date(agora)).getTime();
  if (fim.getTime() <= t) return 'encerrada';
  if (ini.getTime() > t) return 'agendada';
  return 'ativa';
}

function promoDe(row) {
  return {
    promo_price: numero(row && row.promo_price),
    promo_starts_at: (row && row.promo_starts_at) || null,
    promo_ends_at: (row && row.promo_ends_at) || null,
  };
}

/**
 * Campos novos de um PRODUTO. `price` e o preco normal ("De").
 * Devolve { promo_price, promo_starts_at, promo_ends_at, em_promocao, preco_efetivo }.
 */
function camposDoProduto(row, agora = new Date()) {
  const base = numero(row && row.price) || 0;
  const promo = promoDe(row);
  const ativa = emPromocao(base, promo, agora);
  return { ...promo, em_promocao: ativa, preco_efetivo: ativa ? promo.promo_price : base };
}

/**
 * Campos novos de uma VARIANTE, com o produto como referencia.
 * `produto` precisa de price e (se houver) das colunas promo_* do produto.
 * Os promo_* devolvidos sao os da promocao que se aplica a variante: a
 * propria quando gravada; senao, sem price_override, a do produto.
 */
function camposDaVariante(variante, produto, agora = new Date()) {
  const override = numero(variante && variante.price_override);
  const precoProduto = numero(produto && produto.price) || 0;
  const base = override !== null ? override : precoProduto;
  const propria = promoDe(variante);
  if (emPromocao(base, propria, agora)) {
    return { ...propria, em_promocao: true, preco_efetivo: propria.promo_price };
  }
  if (override === null) {
    const doProduto = camposDoProduto(produto, agora);
    if (doProduto.em_promocao || propria.promo_price === null) return doProduto;
  }
  return { ...propria, em_promocao: false, preco_efetivo: base };
}

/** So o numero (atalho para quem calcula total). */
function precoEfetivoDoProduto(row, agora) {
  return camposDoProduto(row, agora).preco_efetivo;
}

function precoEfetivoDaVariante(variante, produto, agora) {
  return camposDaVariante(variante, produto, agora).preco_efetivo;
}

/** Fragmento de SELECT com as colunas promo_* (alias opcional, ex.: 'p'). */
function colunasPromo(alias, prefixo = '') {
  const a = alias ? `${alias}.` : '';
  return CAMPOS.map((c) => `${a}${c} AS ${prefixo}${c}`).join(', ');
}

/** Mesmo fragmento, so que nulo (base sem a 427). */
function colunasPromoNulas(prefixo = '') {
  return [
    `NULL::numeric AS ${prefixo}promo_price`,
    `NULL::timestamptz AS ${prefixo}promo_starts_at`,
    `NULL::timestamptz AS ${prefixo}promo_ends_at`,
  ].join(', ');
}

// Base sem a 427: depois de um 42703, le sem as colunas por 5 minutos e
// tenta de novo (a migration pode ser aplicada com o processo no ar; sem
// voltar a tentar, a promocao gravada ficaria invisivel ate o proximo boot).
const NOVA_TENTATIVA_MS = 5 * 60 * 1000;
let semColunasAte = 0;

/**
 * Roda `fn(comPromo)` com as colunas; em 42703 de promo_*, memoriza e roda
 * sem. `fn` recebe true/false e monta a consulta com colunasPromo ou
 * colunasPromoNulas.
 */
async function comColunasPromo(fn) {
  if (Date.now() >= semColunasAte) {
    try {
      return await fn(true);
    } catch (err) {
      if (err && err.code === '42703' && /promo_/.test(String(err.message || ''))) {
        semColunasAte = Date.now() + NOVA_TENTATIVA_MS;
      } else {
        throw err;
      }
    }
  }
  return fn(false);
}

function _resetarParaTeste() { semColunasAte = 0; }

module.exports = {
  CAMPOS,
  emPromocao,
  statusDaPromocao,
  camposDoProduto,
  camposDaVariante,
  precoEfetivoDoProduto,
  precoEfetivoDaVariante,
  colunasPromo,
  colunasPromoNulas,
  comColunasPromo,
  _resetarParaTeste,
};
