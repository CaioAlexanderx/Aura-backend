// ============================================================
// AURA — capa do produto sem foto (espelho)
//
// FONTE DE VERDADE: aura-app `components/studio/storefront/capaModel.ts`.
// Espelho, como storefrontTypography.js — repositorios separados.
//
// A loja comum mostrava UMA letra: o primeiro caractere do nome. Em
// catalogo real isso vira "K" para "KIT 3 PARES MEIA CANO LONGO" e "5"
// para "50 Sacolas Plastica" — sem informacao e sem desenho.
//
// ── POR QUE A REGRA E UMA STRING ────────────────────────────
//
// A mesma regra roda no servidor (para testar) e no navegador (dentro do
// <script> da loja). Serializar com Function.prototype.toString() parece
// resolver e nao resolve: sob instrumentacao de cobertura o istanbul
// reescreve cada funcao com contadores que so existem no escopo do
// MODULO, o toString() serializa o codigo instrumentado, e o codigo
// enviado ao navegador quebra com
//
//   ReferenceError: cov_177evhcc8t is not defined
//
// Aqui isso e latente e nao aparece porque `src/templates/**` esta fora
// do collectCoverageFrom — sorte, nao desenho. Bastaria alguem ampliar a
// cobertura para a loja quebrar em producao sem ninguem entender por que.
//
// Aqui a fonte E a string, e o Node deriva as funcoes dela. Uma regra so,
// impossivel de divergir, e imune a qualquer instrumentacao.
// ============================================================
'use strict';

/** O codigo que roda nos DOIS lados. */
const FONTE = `
var VAZIAS_INICIAIS = new Set([
  'de','da','do','das','dos','e','com','sem','para','por',
  'em','no','na','nos','nas','a','o','as','os','um','uma'
]);

/**
 * Ate duas iniciais, pulando numero e palavra vazia.
 *
 * O nome do produto do lojista e sujo por natureza: vem em CAIXA ALTA,
 * com medida no meio e codigo no fim.
 */
function iniciais(nome) {
  var limpo = String(nome == null ? '' : nome).trim();
  if (!limpo) return '?';

  var bruto = limpo.split(/[\\s\\-_/·,.]+/);
  var palavras = [];
  for (var i = 0; i < bruto.length; i++) {
    var w = bruto[i];
    if (!w) continue;
    // So entra palavra que COMECA com letra: descarta "3", "300g", "20x30cm".
    if (!/^\\p{L}/u.test(w)) continue;
    if (VAZIAS_INICIAIS.has(w.toLowerCase())) continue;
    palavras.push(w);
  }

  if (palavras.length === 0) {
    var m = limpo.match(/\\p{L}/u);
    return m ? m[0].toUpperCase() : '?';
  }

  return palavras.slice(0, 2).map(function (p) { return p[0].toUpperCase(); }).join('');
}

/**
 * Degrau de intensidade do tom da capa, derivado do nome.
 *
 * Uma grade inteira de capas identicas parece erro de carregamento. Na
 * Finesse — 500 produtos, 49 com foto — 373 ladrilhos sairam no MESMO
 * gradiente, e numa loja de vestidos as iniciais ainda por cima repetem:
 * "VL", "VL", "VL". Sem variacao de tom, a prateleira vira uma parede.
 *
 * ESCADA MAIS LONGA QUE A DO APP, DE PROPOSITO. A vitrine Studio tem 5
 * degraus porque a prateleira dela e de dezenas de produtos; aqui sao
 * centenas. O que os dois lados compartilham e a REGRA — degrau
 * deterministico derivado do nome — nao o comprimento da escada.
 */
var FORCAS = [52, 59, 66, 73, 80, 87, 94, 100];
var ANGULOS = [135, 160, 200, 315];

function gradienteDaCapa(nome) {
  var s = String(nome == null ? '' : nome);
  var hash = 0;
  for (var i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  // Math.imul, nao \`*\`: hash chega a 2^32 e o produto passa de 2^53, onde
  // o double perde os bits BAIXOS — que sao justamente os que o % le.
  // Com \`*\` todo produto caia no mesmo angulo.
  var giro = Math.imul(hash, 2654435761) >>> 0;
  return {
    forca: FORCAS[hash % FORCAS.length],
    // Bits ALTOS do giro. Os baixos nao servem: o multiplicador e impar,
    // entao giro % 4 === hash % 4 e o angulo sairia colado na
    // intensidade — 8 combinacoes em vez de 32.
    angulo: ANGULOS[(giro >>> 13) % ANGULOS.length]
  };
}

/** O CSS pronto — o template so injeta. */
function fundoDaCapa(nome) {
  var g = gradienteDaCapa(nome);
  return 'linear-gradient(' + g.angulo + 'deg,' +
    'color-mix(in oklab,var(--sf-ph-from) ' + g.forca + '%,var(--sf-bg-card)),' +
    'color-mix(in oklab,var(--sf-ph-to) ' + g.forca + '%,var(--sf-bg-card)))';
}
`;

// A string e um literal deste arquivo — nao ha entrada externa nenhuma.
// O eval acontece uma vez, no carregamento do modulo.
const { iniciais, gradienteDaCapa, fundoDaCapa } = new Function(
  FONTE +
    'return { iniciais: iniciais, gradienteDaCapa: gradienteDaCapa, fundoDaCapa: fundoDaCapa };',
)();

/** A regra para o <script> da pagina. */
function fonteClienteIniciais() {
  return (
    FONTE +
    '\nfunction INICIAIS(n){return iniciais(n);}' +
    '\nfunction FUNDO_CAPA(n){return fundoDaCapa(n);}\n'
  );
}

module.exports = { iniciais, gradienteDaCapa, fundoDaCapa, fonteClienteIniciais };
