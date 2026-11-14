// ============================================================
// AURA. — Nomes de cor para conferir (CP5 da revisão de cores, 14/11/2026)
//
// Variantes antigas ficaram com o nome da cor em maiúsculas — cortado em 10
// letras ("AZUL ESCUR", vindo do sku_suffix) ou inteiro ("OFF WHITE"). Até
// a lojista confirmar, a tela e a nota mostram o nome da paleta para o
// cortado (services/nomeDaCor.js) e a caixa de frase para o inteiro.
//
// Aqui:
//   - listar(): só leitura. Agrupa por pedaço ("AZUL ESCUR"), com a
//     sugestão de nome inteiro:
//       1. um nome que a PRÓPRIA LOJA já escreveu e começa igual (único);
//       2. um nome da paleta única que começa igual (único) — o pedaço de
//          10 letras que já é o nome todo ("VERDE AGUA") ganha o acento;
//       3. nome inteiro em maiúsculas: a caixa de frase ("Off white"),
//          SÓ como sugestão (decisão 5 do Caio: nunca muda sozinho);
//       4. mais de um candidato → opções para ela escolher; nenhum → nada.
//   - confirmar(): grava em product_variants.color_name o nome que ela
//     confirmou, por produto e cor (hex). Nada de escrita em lote sem
//     confirmação: a rota só recebe o que a tela mandou, item a item.
//
// Variante sem color_name e com o sufixo cortado (nunca salva depois da
// 414) entra também: hoje sai com o nome da paleta, e o nome inteiro só
// existe se ela disser qual é.
// ============================================================
'use strict';

const { productVisibilityWhere } = require('../utils/companyGroup');
const { PALETA, chaveDoNome } = require('./paletaDeCores');
const { nomeDaCor, emCaixaDeFrase } = require('./nomeDaCor');
const { parteDaCorNoSufixo } = require('./nomeDaCorNaGrade');

const HEX = /^#[0-9A-Fa-f]{6}$/;
/** Maiúsculas (com acento), espaço, hífen e apóstrofo — o que o sufixo guarda. */
const SO_LETRAS_MAIUSCULAS = /^[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ' -]*$/;
const CORTE = 10;
const MAX_ITENS_NO_CONFIRMAR = 2000;

function tudoMaiusculo(t) {
  return t === t.toLocaleUpperCase('pt-BR') && t !== t.toLocaleLowerCase('pt-BR');
}

/**
 * O pedaço desta variante, ou null se ela não está "para conferir".
 * @returns {{ pedaco: string, tipo: 'cortado'|'maiusculo', origem: 'color_name'|'sufixo' } | null}
 */
function pedacoDaVariante(v) {
  if (!v || !HEX.test(String(v.hex || ''))) return null;
  const gravado = typeof v.color_name === 'string' ? v.color_name.trim() : '';
  if (gravado) {
    // Hex de 5 dígitos do lote antigo ("FFFFF") não é nome: a tela já mostra a paleta.
    if (/^#?[0-9A-Fa-f]{5,6}$/.test(gravado)) return null;
    if (!tudoMaiusculo(gravado) || !SO_LETRAS_MAIUSCULAS.test(gravado)) return null;
    return { pedaco: gravado, tipo: gravado.length >= CORTE ? 'cortado' : 'maiusculo', origem: 'color_name' };
  }
  const parte = parteDaCorNoSufixo(v.sku_suffix, v.tamanho);
  if (!parte || parte.length < CORTE || !SO_LETRAS_MAIUSCULAS.test(parte)) return null;
  return { pedaco: parte, tipo: 'cortado', origem: 'sufixo' };
}

/**
 * A sugestão de nome inteiro para um pedaço.
 * @param pedaco      "AZUL ESCUR"
 * @param tipo        'cortado' | 'maiusculo'
 * @param nomesDaLoja nomes que a lojista já escreveu (não maiúsculos)
 * @returns {{ sugestao: {nome, fonte}|null, opcoes: string[] }}
 *   fonte: 'loja' | 'paleta' | 'caixa_de_frase'
 */
function sugerir(pedaco, tipo, nomesDaLoja) {
  const k = chaveDoNome(pedaco);
  const unicos = (lista) => Array.from(new Set(lista));
  if (!k) return { sugestao: null, opcoes: [] };

  if (tipo === 'cortado') {
    const daLoja = unicos((nomesDaLoja || []).filter((n) => {
      const kn = chaveDoNome(n);
      return kn.length > k.length && kn.startsWith(k);
    }));
    if (daLoja.length === 1) return { sugestao: { nome: daLoja[0], fonte: 'loja' }, opcoes: [] };
    if (daLoja.length > 1) return { sugestao: null, opcoes: daLoja.sort((a, b) => a.localeCompare(b, 'pt-BR')) };
    const daPaleta = unicos(PALETA.filter((c) => chaveDoNome(c.nome).startsWith(k)).map((c) => c.nome));
    if (daPaleta.length === 1) return { sugestao: { nome: daPaleta[0], fonte: 'paleta' }, opcoes: [] };
    if (daPaleta.length > 1) return { sugestao: null, opcoes: daPaleta };
    return { sugestao: null, opcoes: [] };
  }

  // Nome inteiro em maiúsculas: a paleta, se é exatamente um nome dela
  // ("BORDO" → "Bordô"); senão a caixa de frase. Sempre só sugestão.
  const exato = PALETA.find((c) => chaveDoNome(c.nome) === k);
  if (exato) return { sugestao: { nome: exato.nome, fonte: 'paleta' }, opcoes: [] };
  return { sugestao: { nome: emCaixaDeFrase(pedaco), fonte: 'caixa_de_frase' }, opcoes: [] };
}

/**
 * Agrupa as linhas (uma por variante) por pedaço.
 * @param linhas [{ product_id, product_name, company_id, variant_id, color_name, sku_suffix, hex, tamanho }]
 * @param nomesDaLoja nomes escritos pela lojista no grupo
 */
function agrupar(linhas, nomesDaLoja) {
  const grupos = new Map();
  for (const l of linhas || []) {
    const p = pedacoDaVariante(l);
    if (!p) continue;
    const chave = p.tipo + ':' + p.pedaco;
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        chave, pedaco: p.pedaco, tipo: p.tipo,
        hex: String(l.hex).toUpperCase(),
        // O que sai hoje no Caixa, na nota, no cupom e na vitrine.
        hoje: nomeDaCor({ hex: l.hex, colorName: l.color_name, skuSuffix: l.sku_suffix, tamanho: l.tamanho }),
        variantes: 0,
        _itens: new Map(),
      });
    }
    const g = grupos.get(chave);
    g.variantes += 1;
    const hex = String(l.hex).toUpperCase();
    const k = l.product_id + '|' + hex;
    if (!g._itens.has(k)) g._itens.set(k, { product_id: l.product_id, product_name: l.product_name, company_id: l.company_id, hex });
  }
  const tipoOrdem = { cortado: 0, maiusculo: 1 };
  return Array.from(grupos.values())
    .map((g) => {
      const itens = Array.from(g._itens.values());
      const { sugestao, opcoes } = sugerir(g.pedaco, g.tipo, nomesDaLoja);
      return {
        chave: g.chave, pedaco: g.pedaco, tipo: g.tipo, hex: g.hex, hoje: g.hoje,
        variantes: g.variantes,
        produtos: new Set(itens.map((i) => i.product_id)).size,
        itens,
        sugestao, opcoes,
        // "Confirmar todas" só vale para isto (decisão 4 do Caio).
        unica_da_paleta: !!(sugestao && sugestao.fonte === 'paleta' && g.tipo === 'cortado'),
      };
    })
    .sort((a, b) => (tipoOrdem[a.tipo] - tipoOrdem[b.tipo]) || (b.variantes - a.variantes) || a.pedaco.localeCompare(b.pedaco, 'pt-BR'));
}

// ─── banco ───────────────────────────────────────────────────────────────

const SQL_VARIANTES = (vis) => `
  SELECT p.id AS product_id, p.name AS product_name, p.company_id,
         pv.id AS variant_id, pv.color_name, pv.sku_suffix,
         (SELECT x.value FROM product_variant_values x
           WHERE x.variant_id = pv.id AND lower(x.attribute_name) IN ('cor', 'color') LIMIT 1) AS hex,
         (SELECT x.value FROM product_variant_values x
           WHERE x.variant_id = pv.id AND lower(x.attribute_name) IN ('tamanho', 'size') LIMIT 1) AS tamanho
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
   WHERE pv.is_active = true AND p.is_active = true AND ${vis}
     AND (
       (pv.color_name IS NOT NULL AND pv.color_name = upper(pv.color_name) AND pv.color_name <> lower(pv.color_name))
       OR (pv.color_name IS NULL AND char_length(split_part(COALESCE(pv.sku_suffix, ''), '-', 1)) >= ${CORTE})
     )`;

// Nomes que a lojista escreveu (não maiúsculos), no que esta loja enxerga.
const SQL_NOMES_DA_LOJA = (vis) => `
  SELECT DISTINCT btrim(pv.color_name) AS nome
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
   WHERE pv.is_active = true AND ${vis}
     AND pv.color_name IS NOT NULL AND btrim(pv.color_name) <> ''
     AND pv.color_name <> upper(pv.color_name)
   LIMIT 5000`;

/** Só leitura. */
async function listar(db, companyId) {
  const vis = productVisibilityWhere('$1', 'p.');
  const [{ rows: linhas }, { rows: nomes }] = await Promise.all([
    db.query(SQL_VARIANTES(vis), [companyId]),
    db.query(SQL_NOMES_DA_LOJA(vis), [companyId]),
  ]);
  const grupos = agrupar(linhas, nomes.map((n) => n.nome));
  return {
    grupos,
    total_grupos: grupos.length,
    total_variantes: grupos.reduce((n, g) => n + g.variantes, 0),
  };
}

/**
 * Lê e valida o corpo do POST: [{ product_id, hex, nome }].
 * @returns {{ itens } | { erro }}
 */
function lerConfirmacao(body) {
  const itens = body && Array.isArray(body.itens) ? body.itens : null;
  if (!itens || !itens.length) return { erro: 'Nada para confirmar.' };
  if (itens.length > MAX_ITENS_NO_CONFIRMAR) return { erro: 'Confirme no máximo ' + MAX_ITENS_NO_CONFIRMAR + ' de cada vez.' };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const saida = [];
  for (const it of itens) {
    const nome = typeof (it && it.nome) === 'string' ? it.nome.trim() : '';
    const hex = String((it && it.hex) || '').trim().toUpperCase();
    if (!uuid.test(String(it && it.product_id || ''))) return { erro: 'Produto inválido.' };
    if (!HEX.test(hex)) return { erro: 'Cor inválida.' };
    if (!nome || /^#?[0-9A-Fa-f]{5,6}$/.test(nome)) return { erro: 'Escreva o nome da cor.' };
    saida.push({ product_id: it.product_id, hex, nome: nome.slice(0, 60) });
  }
  return { itens: saida };
}

/**
 * Grava o nome confirmado, por produto e cor. Só toca variantes ativas
 * daquele produto (visível para a loja) cujo atributo Cor é aquele hex.
 * O sku_suffix não muda.
 * @returns {{ variantes: number, itens: number, recusados: number }}
 */
async function confirmar(client, companyId, itens) {
  const vis = productVisibilityWhere('$4', 'p.');
  let variantes = 0;
  let recusados = 0;
  for (const it of itens) {
    const { rowCount } = await client.query(
      `UPDATE product_variants pv SET color_name = $1, updated_at = NOW()
         FROM products p
        WHERE pv.product_id = p.id AND p.id = $2 AND pv.is_active = true AND ${vis}
          AND EXISTS (SELECT 1 FROM product_variant_values x
                       WHERE x.variant_id = pv.id AND lower(x.attribute_name) IN ('cor', 'color')
                         AND upper(x.value) = $3)`,
      [it.nome, it.product_id, it.hex, companyId]
    );
    if (rowCount > 0) variantes += rowCount; else recusados += 1;
  }
  return { variantes, itens: itens.length, recusados };
}

module.exports = {
  pedacoDaVariante,
  sugerir,
  agrupar,
  listar,
  lerConfirmacao,
  confirmar,
  SQL_VARIANTES,
  MAX_ITENS_NO_CONFIRMAR,
};
