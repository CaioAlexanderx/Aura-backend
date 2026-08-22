// ============================================================
// AURA — capa do produto sem foto (espelho)
//
// FONTE DE VERDADE: aura-app `components/studio/storefront/capaModel.ts`.
// Espelho, como storefrontTypography.js — repositorios separados.
//
// A loja comum mostrava UMA letra: o primeiro caractere do nome. Em
// catalogo real isso vira "K" para "KIT 3 PARES MEIA CANO LONGO" e "5"
// para "50 Sacolas Plastica" — sem informacao e sem desenho.
// ============================================================
'use strict';

const VAZIAS_INICIAIS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'para', 'por',
  'em', 'no', 'na', 'nos', 'nas', 'a', 'o', 'as', 'os', 'um', 'uma',
]);

/**
 * Ate duas iniciais, pulando numero e palavra vazia.
 *
 * O nome do produto do lojista e sujo por natureza: vem em CAIXA ALTA,
 * com medida no meio e codigo no fim.
 */
function iniciais(nome) {
  const limpo = String(nome == null ? '' : nome).trim();
  if (!limpo) return '?';

  const palavras = limpo
    .split(/[\s\-_/·,.]+/)
    .filter(Boolean)
    // So entra palavra que COMECA com letra: descarta "3", "300g", "20x30cm".
    .filter((p) => /^\p{L}/u.test(p))
    .filter((p) => !VAZIAS_INICIAIS.has(p.toLowerCase()));

  if (palavras.length === 0) {
    const m = limpo.match(/\p{L}/u);
    return m ? m[0].toUpperCase() : '?';
  }

  return palavras.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

/**
 * Degrau de intensidade do tom da capa, derivado do nome.
 *
 * Uma grade inteira de capas identicas parece erro de carregamento. Na
 * Finesse — 500 produtos, 49 com foto — 373 ladrilhos sairam no MESMO
 * gradiente, e numa loja de vestidos as iniciais ainda por cima repetem:
 * "VL", "VL", "VL". Sem variacao de tom, a prateleira vira uma parede.
 *
 * Deterministico de proposito: o mesmo produto tem sempre a mesma capa,
 * senao ela mudaria a cada render e o cliente veria a loja piscando.
 *
 * O app usa o valor como alpha (0.07 a 0.19) sobre o ladrilho; aqui ele
 * vira a intensidade do gradiente ja existente. Hash igual dos dois lados
 * = o mesmo produto no mesmo degrau nas duas lojas.
 */
const DEGRAUS = [0.07, 0.1, 0.13, 0.16, 0.19];

function degrauDaCapa(nome) {
  const s = String(nome == null ? '' : nome);
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return DEGRAUS[hash % DEGRAUS.length];
}

/**
 * O gradiente da capa deste produto: intensidade + angulo.
 *
 * ESCADA MAIS LONGA QUE A DO APP, DE PROPOSITO. A vitrine Studio tem 5
 * degraus porque a prateleira dela e de dezenas de produtos; aqui a
 * Finesse renderiza 373 capas sem foto de uma vez, e com 5 tons um em
 * cada cinco cartoes sai identico ao vizinho. O que os dois lados
 * compartilham e a REGRA — degrau deterministico derivado do nome — nao o
 * comprimento da escada, que e detalhe de cada prateleira.
 *
 * O angulo sai de um segundo giro do hash, senao intensidade e angulo
 * andariam juntos e a variacao seria so aparente.
 */
const FORCAS = [52, 59, 66, 73, 80, 87, 94, 100];
const ANGULOS = [135, 160, 200, 315];

function gradienteDaCapa(nome) {
  const s = String(nome == null ? '' : nome);
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  // Math.imul, nao `*`: hash chega a 2^32 e o produto passa de 2^53, onde
  // o double perde os bits BAIXOS — que sao justamente os que o `%` le.
  // Com `*` todo produto caia no mesmo angulo.
  const giro = Math.imul(hash, 2654435761) >>> 0;
  return {
    forca: FORCAS[hash % FORCAS.length],
    // Bits ALTOS do giro. Os baixos nao servem: o multiplicador e impar,
    // entao `giro % 4 === hash % 4` e o angulo sairia colado na
    // intensidade — 8 combinacoes em vez de 32.
    angulo: ANGULOS[(giro >>> 13) % ANGULOS.length],
  };
}

/** O CSS pronto — o template so injeta. */
function fundoDaCapa(nome) {
  const g = gradienteDaCapa(nome);
  return 'linear-gradient(' + g.angulo + 'deg,' +
    'color-mix(in oklab,var(--sf-ph-from) ' + g.forca + '%,var(--sf-bg-card)),' +
    'color-mix(in oklab,var(--sf-ph-to) ' + g.forca + '%,var(--sf-bg-card)))';
}

/**
 * A MESMA funcao, serializada para o <script> da pagina.
 *
 * A vitrine roda no servidor (Node) e na loja comum roda no navegador. Em
 * vez de escrever a regra duas vezes — que e como `modern` divergiu entre
 * app e template — a funcao e uma so e vai serializada para o cliente.
 */
function fonteClienteIniciais() {
  return [
    'var VAZIAS_INICIAIS=new Set(' + JSON.stringify(Array.from(VAZIAS_INICIAIS)) + ');',
    iniciais.toString(),
    'var FORCAS=' + JSON.stringify(FORCAS) + ';',
    'var ANGULOS=' + JSON.stringify(ANGULOS) + ';',
    gradienteDaCapa.toString(),
    fundoDaCapa.toString(),
    'function INICIAIS(n){return iniciais(n);}',
    'function FUNDO_CAPA(n){return fundoDaCapa(n);}',
    '',
  ].join(String.fromCharCode(10));
}

module.exports = { iniciais, degrauDaCapa, gradienteDaCapa, fundoDaCapa, fonteClienteIniciais };
