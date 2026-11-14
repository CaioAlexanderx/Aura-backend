// ============================================================
// AURA. — Nome da cor ao salvar a grade (14/11/2026)
//
// O DEFEITO. Antes da migration 414 o nome da cor só existia dentro do
// product_variants.sku_suffix, em maiúsculas e cortado em 10 letras
// ("AZUL ESCUR-M"). O GET /variations devolvia esse pedaço em
// colors[].name quando color_name era NULL; o editor do app mostrava o
// pedaço e o Salvar o mandava de volta; o PUT gravava o pedaço em
// color_name como se a lojista o tivesse digitado. Cada Salvar de grade
// de um produto antigo transformava "AZUL ESCUR" em nome "oficial"
// (cerca de 2.841 variantes em 11 lojas em 13/11).
//
// AS REGRAS DAQUI (puras, sem banco):
//   1. color_name só recebe nome de verdade: vazio, hex de 6 dígitos e
//      hex de 5 dígitos (o lote antigo de variants.js) ficam de fora.
//   2. Cor que já existe no produto com color_name NULL (variante antiga):
//      o nome que chega e é só eco do que o servidor devolveu — o pedaço
//      do sufixo, em maiúsculas, ou o nome da paleta do app para aquele
//      hex (o que o app antigo manda quando o GET devolve name null) —
//      não é gravado. O color_name continua NULL e o sku_suffix daquela
//      variante não muda.
//   3. Nome vazio ou ausente numa cor que já tem color_name: mantém o que
//      está gravado. Não apaga.
//   4. Cor nova no produto: grava o nome que veio (regra 1), como antes.
//
// O sku_suffix continua o de sempre (productsVariations.skuSuffixFromAttrs);
// quando o nome que chegou não é aceito, a parte da cor sai do sufixo que
// a variante já tem, para que o cupom e a busca por SKU não mudem.
// ============================================================
'use strict';

/** Hex com 6 dígitos, ou 5 (o lote antigo de variants.js gravava 5). */
const SO_HEX = /^#?[0-9A-Fa-f]{5,6}$/;
const HEX6 = /^[0-9A-F]{6}$/i;

/**
 * Paleta do app (utils/colorNames.ts, NAMED_COLORS): é o nome que o editor
 * antigo põe na cor quando o GET não devolve nome. Mesmos 26 tons e a
 * mesma distância (RGB euclidiana), para reconhecer o eco.
 */
const PALETA_DO_APP = [
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

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Nome da paleta do app para o hex (o hexToName de utils/colorNames.ts), ou null. */
function nomeDaPaletaDoApp(hex) {
  const limpo = String(hex || '').replace('#', '').trim();
  if (!HEX6.test(limpo)) return null;
  const r = parseInt(limpo.slice(0, 2), 16);
  const g = parseInt(limpo.slice(2, 4), 16);
  const b = parseInt(limpo.slice(4, 6), 16);
  let melhor = null;
  let menor = Infinity;
  for (const [nome, cr, cg, cb] of PALETA_DO_APP) {
    const d = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb);
    if (d < menor) { menor = d; melhor = nome; }
  }
  return melhor;
}

/**
 * Nome que pode ir para product_variants.color_name: só tira o espaço das
 * pontas; vazio, não-texto, hex (6 ou 5 dígitos, com ou sem #) viram null.
 * Teto de 60 caracteres só para não gravar lixo.
 */
function colorNameParaGravar(name) {
  if (typeof name !== 'string') return null;
  const t = name.trim();
  if (!t || SO_HEX.test(t)) return null;
  return t.slice(0, 60);
}

/**
 * A parte da cor dentro do sku_suffix da variante: "OFF-WHITE-M" com
 * tamanho M → "OFF-WHITE"; sem tamanho, o sufixo inteiro. Sufixo em outro
 * formato → o que vem antes do primeiro hífen. Hex puro → null.
 */
function parteDaCorNoSufixo(skuSuffix, tamanho) {
  const s = String(skuSuffix || '').trim();
  if (!s) return null;
  const tam = tamanho ? String(tamanho).toUpperCase().slice(0, 10) : '';
  let parte;
  if (!tam) parte = s;
  else if (s.toUpperCase().endsWith('-' + tam)) parte = s.slice(0, s.length - tam.length - 1);
  else parte = s.split('-')[0];
  if (!parte || HEX6.test(parte)) return null;
  return parte;
}

/** O pedaço que o GET antigo devolvia: o que vem antes do primeiro hífen. */
function pedacoAntesDoHifen(skuSuffix) {
  const primeiro = String(skuSuffix || '').split('-')[0];
  if (!primeiro || HEX6.test(primeiro)) return null;
  return primeiro;
}

function chaveDoHex(hex) {
  return String(hex || '').trim().toUpperCase();
}

/**
 * Agrupa as variantes ativas por cor.
 * @param linhas [{ colorHex, sizeValue, sku_suffix, color_name }]
 * @returns Map(HEX → { gravado, pedacos: Set, parteDoSku })
 *   gravado     o primeiro color_name não-nulo daquela cor (ou null)
 *   pedacos     o que o GET pode ter devolvido como nome (eco)
 *   parteDoSku  a parte da cor do sufixo, para variante nova da mesma cor
 */
function coresDoProduto(linhas) {
  const porCor = new Map();
  for (const l of linhas || []) {
    if (!l || !l.colorHex) continue;
    const k = chaveDoHex(l.colorHex);
    if (!porCor.has(k)) porCor.set(k, { gravado: null, pedacos: new Set(), parteDoSku: null });
    const c = porCor.get(k);
    const gravado = typeof l.color_name === 'string' ? l.color_name.trim() : '';
    if (gravado && !c.gravado) c.gravado = gravado;
    const parte = parteDaCorNoSufixo(l.sku_suffix, l.sizeValue);
    const antes = pedacoAntesDoHifen(l.sku_suffix);
    if (parte) { c.pedacos.add(parte); if (!c.parteDoSku) c.parteDoSku = parte; }
    if (antes) c.pedacos.add(antes);
  }
  return porCor;
}

/**
 * O que fazer com o nome que chegou para uma cor.
 * @param hex       hex da cor (#RRGGBB)
 * @param recebido  colors[].name do corpo do PUT
 * @param info      entrada de coresDoProduto para esse hex (undefined = cor nova)
 * @returns {
 *   gravar:     nome para gravar em color_name nas variantes que JÁ existem
 *               (null = não mexe no color_name delas),
 *   paraNova:   color_name de variante nova dessa cor (null = NULL),
 *   nomeDoSku:  nome que entra no sku_suffix (skuSuffixFromAttrs),
 *   manterSku:  true = variante existente fica com o sku_suffix que tem,
 * }
 */
function resolverNomeDaCor(hex, recebido, info) {
  const limpo = colorNameParaGravar(recebido);
  const bruto = typeof recebido === 'string' && recebido.trim() ? recebido : null;

  // Cor nova no produto: como sempre.
  if (!info) {
    return { gravar: limpo, paraNova: limpo, nomeDoSku: bruto, manterSku: false };
  }

  // Cor que já tem nome gravado: nome novo troca; vazio mantém.
  if (info.gravado) {
    if (limpo) return { gravar: limpo, paraNova: limpo, nomeDoSku: bruto, manterSku: false };
    return { gravar: null, paraNova: info.gravado, nomeDoSku: info.gravado, manterSku: true };
  }

  // Variante antiga (color_name NULL): eco do servidor não vira nome.
  const ehPedaco = !!limpo
    && limpo === limpo.toUpperCase()
    && limpo !== limpo.toLowerCase()
    && info.pedacos.has(limpo);
  const paleta = nomeDaPaletaDoApp(hex);
  const ehPaleta = !!limpo && !!paleta && semAcento(limpo) === semAcento(paleta);
  if (!limpo || ehPedaco || ehPaleta) {
    return { gravar: null, paraNova: null, nomeDoSku: info.parteDoSku || bruto, manterSku: true };
  }
  return { gravar: limpo, paraNova: limpo, nomeDoSku: bruto, manterSku: false };
}

/**
 * Nome sugerido para a cor no GET /variations: a parte da cor do sufixo
 * ("AZUL ESCUR", "OFF-WHITE"). Só sugestão — nunca é o nome gravado.
 */
function nomeSugeridoDoSufixo(skuSuffix, tamanho) {
  return parteDaCorNoSufixo(skuSuffix, tamanho);
}

module.exports = {
  colorNameParaGravar,
  nomeDaPaletaDoApp,
  parteDaCorNoSufixo,
  coresDoProduto,
  resolverNomeDaCor,
  nomeSugeridoDoSufixo,
  chaveDoHex,
};
