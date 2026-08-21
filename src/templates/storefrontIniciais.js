// ============================================================
// AURA — iniciais do produto para a capa sem foto (espelho)
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
    'function INICIAIS(n){return iniciais(n);}',
    '',
  ].join(String.fromCharCode(10));
}

module.exports = { iniciais, fonteClienteIniciais };
