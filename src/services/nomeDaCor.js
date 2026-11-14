// ============================================================
// AURA. — O nome da cor de uma variante: UMA regra para todas as telas
// (CP2a da revisão de cores, 14/11/2026)
//
// Antes, cada tela tirava o nome de um lugar: o cupom imprimia o
// sku_suffix ("OFF WHITE-M"), o pedido da loja online e o Relatório de
// Produtos mostravam o hex cru ("#FAF9F6"), a vitrine usava uma paleta
// própria ("Off white" virava "Branco"), a transferência sumia com a cor
// quando não havia color_name. Agora todas leem daqui, e o app tem a
// gêmea em utils/nomeDaCor.ts (casos em comum em
// __tests__/fixtures/nomeDaCor.casos.json, copiados nos dois repositórios).
//
// A ORDEM (decisões do Caio, 14/11/2026):
//   1. color_name, como a lojista escreveu. Todo em maiúsculas sai em caixa
//      de frase ("AMORA" → "Amora"). Maiúsculas com 10 letras ou mais é o
//      corte do sku_suffix ("AZUL ESCUR") e NUNCA aparece: cai na paleta
//      até a lojista confirmar o nome inteiro. Hex (5 ou 6 dígitos) não é
//      nome. É a mesma regra da etiqueta (app: nomeGravadoParaEtiqueta).
//   2. Sem color_name: o nome lido do sku_suffix, quando dá para ler sem
//      chutar (menos de 10 letras, sem dígito, diferente do da paleta) —
//      a mesma regra do Caixa desde o tq-55 (app: nomeProprioDaCor).
//   3. A paleta do app (utils/colorNames.ts, hexToName): os mesmos 26 tons
//      que a etiqueta usa quando não há nome. Congelada de propósito: a
//      etiqueta de quem não confirma nada sai igual, byte a byte.
//
// Funções puras, sem banco e sem nada de produto_variants no meio: o
// Studio (que vem para o Negócio) chama nomeDaCor({ hex, colorName }) do
// mesmo jeito, com o rótulo que a lojista der à amostra.
// ============================================================
'use strict';

/** A paleta do app (utils/colorNames.ts, NAMED_COLORS): 26 tons, RGB. */
const PALETA_LEGADA = [
  ['Preto', 0, 0, 0], ['Branco', 255, 255, 255], ['Cinza', 128, 128, 128],
  ['Cinza claro', 200, 200, 200], ['Cinza escuro', 64, 64, 64],
  ['Vermelho', 239, 68, 68], ['Vinho', 128, 0, 32], ['Rosa', 236, 72, 153],
  ['Rosa claro', 255, 182, 193], ['Laranja', 249, 115, 22], ['Amarelo', 234, 179, 8],
  ['Marrom', 139, 69, 19], ['Caramelo', 189, 113, 0], ['Bege', 245, 222, 179],
  ['Nude', 240, 235, 223], ['Verde', 34, 197, 94], ['Verde escuro', 0, 100, 0],
  ['Verde agua', 139, 232, 179], ['Azul', 59, 130, 246], ['Azul escuro', 0, 0, 139],
  ['Azul claro', 173, 216, 230], ['Azul marinho', 0, 0, 80], ['Roxo', 139, 92, 246],
  ['Violeta', 109, 40, 217], ['Dourado', 218, 165, 32], ['Prata', 192, 192, 192],
];

const HEX = /^#[0-9A-Fa-f]{6}$/;
/** Hex que não é nome: 6 dígitos, ou 5 (o lote antigo de variants.js), com ou sem #. */
const SO_HEX = /^#?[0-9A-Fa-f]{5,6}$/;
/** Maiúsculas (com acento), espaço, hífen e apóstrofo: o que o sku_suffix guarda. */
const NOME_EM_MAIUSCULAS = /^[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ' -]*$/;

const ATRIBUTOS_DE_COR = new Set(['cor', 'color', 'colour', 'cores']);
const ATRIBUTOS_DE_TAMANHO = new Set(['tamanho', 'size', 'tam', 'tam.', 'numero', 'numeracao', 'medida']);

function semAcento(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function emCaixaDeFrase(s) {
  const baixo = String(s).toLocaleLowerCase('pt-BR');
  return baixo.charAt(0).toLocaleUpperCase('pt-BR') + baixo.slice(1);
}

function tudoMaiusculo(t) {
  return t === t.toLocaleUpperCase('pt-BR') && t !== t.toLocaleLowerCase('pt-BR');
}

/** O hexToName do app: o tom mais perto dos 26, ou null se não for hex. */
function nomeDaPaleta(hex) {
  const limpo = String(hex == null ? '' : hex).trim().replace('#', '');
  if (!/^[0-9A-Fa-f]{6}$/.test(limpo)) return null;
  const r = parseInt(limpo.slice(0, 2), 16);
  const g = parseInt(limpo.slice(2, 4), 16);
  const b = parseInt(limpo.slice(4, 6), 16);
  let melhor = null;
  let menor = Infinity;
  for (const [nome, cr, cg, cb] of PALETA_LEGADA) {
    const d = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb);
    if (d < menor) { menor = d; melhor = nome; }
  }
  return melhor;
}

/**
 * color_name que pode aparecer, ou null. Mesma regra da etiqueta
 * (app: nomeGravadoParaEtiqueta): vazio, hex e o MAIÚSCULO de 10+ letras
 * (o corte do sku_suffix) ficam de fora; todo maiúsculo sai em caixa de
 * frase.
 */
function nomeGravadoQueAparece(colorName) {
  const t = typeof colorName === 'string' ? colorName.trim() : '';
  if (!t || SO_HEX.test(t)) return null;
  const maiusculo = tudoMaiusculo(t);
  if (maiusculo && t.length >= 10) return null;
  return maiusculo ? emCaixaDeFrase(t) : t;
}

/**
 * Nome próprio da cor lido do sku_suffix, ou null (app: nomeProprioDaCor,
 * tq-55). Só quando dá para ler sem chutar: o sufixo no formato
 * NOME(-TAMANHO), nome com menos de 10 letras, sem dígito, diferente do
 * nome da paleta para o mesmo hex.
 */
function nomeDoSufixo(skuSuffix, hex, tamanho) {
  if (!skuSuffix || !hex || !HEX.test(hex)) return null;
  let s = String(skuSuffix).trim();
  const tam = tamanho ? String(tamanho).trim().toUpperCase().slice(0, 10) : '';
  if (tam) {
    if (!s.endsWith('-' + tam)) return null;
    s = s.slice(0, s.length - tam.length - 1);
  }
  if (!s || s.length >= 10) return null;
  if (/[0-9]/.test(s) || !NOME_EM_MAIUSCULAS.test(s)) return null;
  const digitos = hex.slice(1).toUpperCase();
  if (/^[A-F]{5,6}$/.test(s) && digitos.startsWith(s)) return null;
  if (semAcento(s) === semAcento(nomeDaPaleta(hex))) return null;
  return emCaixaDeFrase(s);
}

/**
 * O nome da cor para mostrar.
 * @param {object} o
 * @param {string} o.hex         valor do atributo Cor (#RRGGBB)
 * @param {string} [o.colorName] product_variants.color_name (ou o rótulo da amostra, no Studio)
 * @param {string} [o.skuSuffix] product_variants.sku_suffix
 * @param {string} [o.tamanho]   valor do atributo Tamanho, quando há
 * @returns {string|null} null só quando o hex é inválido e não há nome
 */
function nomeDaCor(o) {
  const p = o || {};
  return nomeGravadoQueAparece(p.colorName)
    || nomeDoSufixo(p.skuSuffix, p.hex, p.tamanho)
    || nomeDaPaleta(p.hex)
    || null;
}

function nomeDoAtributo(a) {
  return semAcento(a && (a.attribute != null ? a.attribute : (a.attribute_name != null ? a.attribute_name : (a.name != null ? a.name : a.a))));
}
function valorDoAtributo(a) {
  const v = a && (a.value != null ? a.value : a.v);
  return v == null ? '' : String(v).trim();
}
function ehAtributoDeCor(a) {
  return ATRIBUTOS_DE_COR.has(nomeDoAtributo(a)) || HEX.test(valorDoAtributo(a));
}

/**
 * Nome da cor de uma variante a partir dos atributos dela.
 * Cor gravada como hex → nomeDaCor; gravada como nome ("Marrom", das
 * variantes juntadas de produtos duplicados) → o próprio nome, sem o
 * "(#hex)" que alguns imports deixavam. Sem atributo de cor → null.
 * @param v { color_name, sku_suffix, attributes: [{attribute|attribute_name|a, value|v}] }
 */
function nomeDaCorDaVariante(v) {
  const attrs = Array.isArray(v && v.attributes) ? v.attributes : [];
  const cor = attrs.find((a) => ehAtributoDeCor(a) && valorDoAtributo(a));
  if (!cor) return null;
  const bruto = valorDoAtributo(cor);
  if (HEX.test(bruto)) {
    const tam = attrs.find((a) => ATRIBUTOS_DE_TAMANHO.has(nomeDoAtributo(a)));
    return nomeDaCor({ hex: bruto, colorName: v.color_name, skuSuffix: v.sku_suffix, tamanho: tam ? valorDoAtributo(tam) : null });
  }
  const semHex = bruto.replace(/\(?\s*#[0-9a-fA-F]{6}\s*\)?/g, '').trim();
  return semHex || bruto;
}

function ordemDoAtributo(a) {
  if (ehAtributoDeCor(a)) return 0;
  if (ATRIBUTOS_DE_TAMANHO.has(nomeDoAtributo(a))) return 1;
  return 2;
}

/**
 * Rótulo da variante: a cor primeiro (pelo nome), depois o tamanho, depois
 * o resto. Sem atributo nenhum, o sku_suffix. Nada legível → null.
 * @param v        { color_name, sku_suffix, attributes }
 * @param separador ' · ' (Caixa, cupom, pedido) ou ' / ' (relatórios, estoque)
 */
function rotuloDaVariante(v, separador) {
  const sep = separador == null ? ' · ' : separador;
  const attrs = (Array.isArray(v && v.attributes) ? v.attributes : [])
    .filter((a) => valorDoAtributo(a))
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (ordemDoAtributo(x.a) - ordemDoAtributo(y.a)) || (x.i - y.i))
    .map((x) => x.a);
  if (!attrs.length) {
    const s = v && v.sku_suffix != null ? String(v.sku_suffix).trim() : '';
    return s || null;
  }
  let corFeita = false;
  const partes = [];
  for (const a of attrs) {
    if (!corFeita && ehAtributoDeCor(a)) {
      corFeita = true;
      const n = nomeDaCorDaVariante({ ...v, attributes: attrs });
      if (n) partes.push(n);
      continue;
    }
    partes.push(valorDoAtributo(a));
  }
  return partes.length ? partes.join(sep) : null;
}

// ─── Para as consultas que montavam o rótulo em SQL ─────────────────────
// Antes: string_agg(pvv.value, ' / ' ORDER BY pvv.attribute_name), que
// devolve "#FAF9F6 / M" (o hex cru). Agora a consulta traz as três
// colunas abaixo e o rótulo sai de rotuloDaVariante, em JS.

/**
 * Colunas para o SELECT. `idDaVariante` é a expressão SQL com o id da
 * variante ('pv.id', 'si.variant_id'): tudo sai por subconsulta, então
 * serve também em consulta com GROUP BY (agrupando pelo id) e em UNION
 * (o outro lado usa COLUNAS_DO_ROTULO_NULAS). Nomes com "_rotulo_" para
 * não colidir com nada da linha.
 */
function colunasDoRotulo(idDaVariante) {
  const id = String(idDaVariante || '');
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(id)) throw new Error('colunasDoRotulo: id inválido');
  return `(SELECT _pv.color_name FROM product_variants _pv WHERE _pv.id = ${id}) AS _rotulo_color_name,
          (SELECT _pv.sku_suffix FROM product_variants _pv WHERE _pv.id = ${id}) AS _rotulo_sku_suffix,
          (SELECT json_agg(json_build_object('attribute', _rv.attribute_name, 'value', _rv.value) ORDER BY _rv.attribute_name)
             FROM product_variant_values _rv WHERE _rv.variant_id = ${id}) AS _rotulo_attrs`;
}
/** O outro lado de um UNION, sem variante. */
const COLUNAS_DO_ROTULO_NULAS = 'NULL::text AS _rotulo_color_name, NULL::text AS _rotulo_sku_suffix, NULL::json AS _rotulo_attrs';

/**
 * Troca row[campo] pelo rótulo com o nome da cor e tira as colunas de
 * apoio. Linha sem variante (attrs nulos e sem sufixo) fica como veio.
 * @returns a própria linha (muta e devolve, para usar em map)
 */
function aplicarRotulo(row, campo, separador) {
  if (!row || typeof row !== 'object') return row;
  const tinha = Object.prototype.hasOwnProperty.call(row, '_rotulo_attrs');
  if (tinha) {
    const attrs = Array.isArray(row._rotulo_attrs) ? row._rotulo_attrs : [];
    if (attrs.length || row._rotulo_sku_suffix) {
      const r = rotuloDaVariante({ color_name: row._rotulo_color_name, sku_suffix: row._rotulo_sku_suffix, attributes: attrs }, separador);
      if (r) row[campo] = r;
    }
  }
  delete row._rotulo_color_name;
  delete row._rotulo_sku_suffix;
  delete row._rotulo_attrs;
  return row;
}

module.exports = {
  colunasDoRotulo,
  COLUNAS_DO_ROTULO_NULAS,
  aplicarRotulo,
  PALETA_LEGADA,
  nomeDaPaleta,
  nomeGravadoQueAparece,
  nomeDoSufixo,
  nomeDaCor,
  nomeDaCorDaVariante,
  rotuloDaVariante,
  emCaixaDeFrase,
};
