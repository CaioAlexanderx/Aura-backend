// ============================================================
// AURA. — Preencher custos em massa: regras puras (12/11/2026)
//
// Sem banco aqui: a rota (routes/productCostFills.js) le os produtos e
// este modulo valida o pedido e monta a previa item a item. A mesma conta
// serve a previa (dry_run) e o aplicar (refeita com as linhas travadas).
//
// Decisoes do Caio (mockup aprovado em 12/11):
//   - o lojista sempre pode digitar o custo a mao; o atalho (markup ou
//     margem sobre o preco de venda) so SUGERE, no app. O servidor grava o
//     numero que veio de cada linha e guarda de onde ele veio (digitado,
//     sugerido ou "mesmo custo para os marcados") e o atalho usado;
//   - custo ao centavo (NUMERIC(10,2)), sem final ,90/,99;
//   - um custo por produto (products.cost_price); variante nao tem custo.
//
// "Sem custo" e a MESMA conta da conferencia de estoque
// (services/conferenciaDeEstoque.js, sqlDoEscopo):
//   COALESCE(NULLIF(weighted_avg_cost, 0), NULLIF(cost_price, 0)) IS NULL
// Servico (unit 'srv') nao tem estoque e fica de fora.
//
// Tudo em CENTAVOS inteiros (59,90 / 1,8 nao vira 33,277777...).
// ============================================================
'use strict';

const ORIGENS = ['digitado', 'sugerido', 'mesmo'];
const MODOS = ['markup', 'margem'];
const MAX_ITENS = 3000;
// NUMERIC(10,2): 99.999.999,99
const MAX_CENTAVOS = 9999999999;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mesma expressao da conferencia: com ela, "sem custo" aqui e "sem custo"
// la sao sempre o mesmo produto. Texto comum (nao template), por ser
// pedaco de SELECT.
const SQL_SEM_CUSTO = 'COALESCE(NULLIF(p.weighted_avg_cost, 0), NULLIF(p.cost_price, 0)) IS NULL';
const SQL_NAO_SERVICO = "lower(COALESCE(p.unit, '')) <> 'srv'";

class ErroDeCusto extends Error {
  constructor(status, code, error, extra = {}) {
    super(error);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
  get body() {
    return { error: this.message, code: this.code, ...this.extra };
  }
}

function lerNumero(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== 'string') return NaN;
  let s = raw.replace(/R\$|%/g, '').trim();
  if (!s) return NaN;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return Number(s);
}

const centavos = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100));
const reais = (c) => (c === null || c === undefined ? null : c / 100);
const numOuNull = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** Produto sem custo pela regra da conferencia (nulo ou zero nos dois). */
function estaSemCusto(p) {
  const medio = numOuNull(p.weighted_avg_cost);
  const custo = numOuNull(p.cost_price);
  return !(medio !== null && medio !== 0) && !(custo !== null && custo !== 0);
}

/**
 * Custo sugerido pelo preco de venda (mesma conta do app, para os testes e
 * para quem ler o historico). Arredonda ao centavo e mais nada.
 *   markup: custo = preco / (1 + pct/100)
 *   margem: custo = preco x (1 - pct/100), pct < 100
 * @returns {number|null} em reais
 */
function sugerirCusto(preco, modo, pct) {
  const p = Number(preco);
  const v = Number(pct);
  if (!(p > 0) || !Number.isFinite(v) || v < 0) return null;
  const c = Math.round(p * 100);
  if (modo === 'markup') return Math.round(c / (1 + v / 100)) / 100;
  if (modo === 'margem') {
    if (v >= 100) return null;
    return Math.round(c * (1 - v / 100)) / 100;
  }
  return null;
}

/**
 * Valida o corpo do POST /cost-fills. Lanca ErroDeCusto (400).
 * @returns {{ dryRun:boolean, itens:Array<{productId:string, custoCentavos:number, origem:string}>,
 *             atalho:{modo:string, percentual:number}|null, countId:string|null }}
 */
function lerPedido(body) {
  const b = body && typeof body === 'object' ? body : {};
  const erro = (error, code = 'PEDIDO_INVALIDO') => new ErroDeCusto(400, code, error);

  if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') throw erro('dry_run deve ser true ou false.');
  const dryRun = b.dry_run !== false;

  if (!Array.isArray(b.itens) || b.itens.length === 0) {
    throw erro('Mande pelo menos um produto com custo.', 'SEM_ITENS');
  }
  if (b.itens.length > MAX_ITENS) {
    throw erro(`No máximo ${MAX_ITENS} produtos por vez.`, 'ITENS_DEMAIS');
  }

  const vistos = new Set();
  const itens = b.itens.map((it, i) => {
    const x = it && typeof it === 'object' ? it : {};
    const pid = String(x.product_id || '').trim().toLowerCase();
    if (!UUID_RE.test(pid)) throw erro(`O item ${i + 1} está sem produto válido.`);
    if (vistos.has(pid)) throw erro('O mesmo produto veio duas vezes.', 'PRODUTO_REPETIDO');
    vistos.add(pid);
    const n = lerNumero(x.custo);
    const c = Number.isFinite(n) ? Math.round(n * 100) : NaN;
    if (!Number.isFinite(c) || c <= 0) {
      throw new ErroDeCusto(400, 'CUSTO_INVALIDO', 'O custo precisa ser maior que zero.', { product_id: pid });
    }
    if (c > MAX_CENTAVOS) {
      throw new ErroDeCusto(400, 'CUSTO_INVALIDO', 'O custo ficou grande demais. Confira o número.', { product_id: pid });
    }
    const origem = x.origem === undefined || x.origem === null || x.origem === '' ? 'digitado' : String(x.origem);
    if (!ORIGENS.includes(origem)) throw erro('A origem do custo deve ser digitado, sugerido ou mesmo.');
    return { productId: pid, custoCentavos: c, origem };
  });

  let atalho = null;
  if (b.atalho !== undefined && b.atalho !== null) {
    const a = b.atalho && typeof b.atalho === 'object' ? b.atalho : {};
    if (!MODOS.includes(a.modo)) throw erro('O atalho deve ser markup ou margem.');
    const pct = lerNumero(a.percentual);
    if (!Number.isFinite(pct) || pct < 0) throw erro('O percentual do atalho precisa ser um número.');
    if (a.modo === 'margem' && pct >= 100) throw erro('A margem precisa ser menor que 100%.');
    if (pct > 10000) throw erro('O percentual do atalho vai até 10.000%.');
    atalho = { modo: a.modo, percentual: Math.round(pct * 100) / 100 };
  }
  if (!atalho && itens.some((i) => i.origem === 'sugerido')) {
    throw erro('Custo sugerido precisa dizer qual atalho foi usado.', 'ATALHO_OBRIGATORIO');
  }

  let countId = null;
  if (b.count_id !== undefined && b.count_id !== null && b.count_id !== '') {
    countId = String(b.count_id).trim().toLowerCase();
    if (!UUID_RE.test(countId)) throw erro('count_id inválido.');
  }

  return { dryRun, itens, atalho, countId };
}

/**
 * Previa item a item a partir das linhas lidas (travadas, no aplicar).
 * Status por item:
 *   grava          entra na gravacao
 *   mudou_no_meio  ganhou custo depois que a lista abriu (entrada de
 *                  mercadoria, outra pessoa): fica com o custo que tem
 *   servico        unit 'srv': fora
 *   nao_encontrado nao e desta loja (compartilhado de outra loja entra
 *                  aqui), foi excluido ou desativado
 * @param {{ produtos:Array, pedido:object, lojasDoGrupo:number }} args
 */
function montarPrevia({ produtos, pedido, lojasDoGrupo }) {
  const porId = new Map(produtos.map((p) => [String(p.id).toLowerCase(), p]));
  const resumo = {
    gravar: 0, digitados: 0, sugeridos: 0, mesmo: 0,
    compartilhados: 0, lojas_do_grupo: lojasDoGrupo,
    acima_do_preco: 0, mudou_no_meio: 0, servicos: 0, nao_encontrados: 0,
  };
  const itens = pedido.itens.map((it) => {
    const p = porId.get(it.productId);
    if (!p || p.is_active === false) {
      resumo.nao_encontrados += 1;
      return { product_id: it.productId, nome: p ? p.name : null, status: 'nao_encontrado' };
    }
    const precoC = centavos(p.price);
    const compartilhado = p.is_group_shared === true;
    const base = {
      product_id: it.productId,
      nome: p.name,
      preco: reais(precoC),
      origem: it.origem,
      compartilhado,
      lojas: compartilhado ? lojasDoGrupo : 1,
    };
    if (String(p.unit || '').toLowerCase() === 'srv') {
      resumo.servicos += 1;
      return { ...base, status: 'servico' };
    }
    if (!estaSemCusto(p)) {
      resumo.mudou_no_meio += 1;
      const atual = numOuNull(p.weighted_avg_cost) || numOuNull(p.cost_price);
      return { ...base, status: 'mudou_no_meio', custo_atual: atual === null ? null : Math.round(atual * 100) / 100 };
    }
    const acima = precoC !== null && precoC > 0 && it.custoCentavos >= precoC;
    resumo.gravar += 1;
    if (it.origem === 'digitado') resumo.digitados += 1;
    else if (it.origem === 'sugerido') resumo.sugeridos += 1;
    else resumo.mesmo += 1;
    if (compartilhado) resumo.compartilhados += 1;
    if (acima) resumo.acima_do_preco += 1;
    return {
      ...base,
      status: 'grava',
      custo_antes: numOuNull(p.cost_price),
      custo_depois: reais(it.custoCentavos),
      acima_do_preco: acima,
      _custoCentavos: it.custoCentavos,
      _medioAntes: numOuNull(p.weighted_avg_cost),
    };
  });
  return { resumo, itens };
}

/** Item sem os campos internos (prefixo _). */
function itemPublico(i) {
  const out = {};
  for (const [k, v] of Object.entries(i)) if (!k.startsWith('_')) out[k] = v;
  return out;
}

/**
 * Desfazer: o item volta ao "antes" SO se o custo e o custo medio ainda
 * sao os que o preenchimento deixou. Entrada de mercadoria mexe nos dois
 * (productSuppliers.js); qualquer diferenca = "mudou depois", fica como esta.
 */
function mudouDepois(item, produtoAtual) {
  if (!produtoAtual) return 'not_found';
  if (centavos(produtoAtual.cost_price) !== centavos(item.cost_after)) return 'changed';
  const medio = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10000));
  if (medio(produtoAtual.weighted_avg_cost) !== medio(item.weighted_avg_before)) return 'changed';
  return null;
}

module.exports = {
  ORIGENS,
  MODOS,
  MAX_ITENS,
  UUID_RE,
  SQL_SEM_CUSTO,
  SQL_NAO_SERVICO,
  ErroDeCusto,
  lerNumero,
  estaSemCusto,
  sugerirCusto,
  lerPedido,
  montarPrevia,
  itemPublico,
  mudouDepois,
};
