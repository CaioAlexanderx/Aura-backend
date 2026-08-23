// ============================================================
// AURA — parcelamento mostrado na loja
//
// FONTE DE VERDADE deste calculo. O app espelha em
// `components/studio/storefront/parcelamento.ts` (repositorios separados).
//
// A loja mostrava so o preco a vista. "3x de R$ 53,30" e uma frase
// diferente de "R$ 159,90" para quem esta decidindo, e e a frase que todo
// e-commerce grande mostra.
//
// O teto vem da lojista (digital_channel_config.card_max_installments),
// nao do gateway: companies_payment_gateways guarda credencial e nada
// mais, e o Mercado Pago so decide parcelas no checkout. Melhor a lojista
// declarar a politica dela do que a loja inventar um numero.
//
// ── POR QUE A REGRA E UMA STRING ────────────────────────────
//
// A mesma conta roda no servidor (para testar) e no navegador (dentro do
// <script> da loja). A tentacao e escrever as funcoes normalmente e
// serializar com Function.prototype.toString() — foi o que eu fiz, e
// quebrou no CI:
//
//   ReferenceError: cov_177evhcc8t is not defined
//
// `src/services/**` esta no escopo de cobertura, e o istanbul reescreve
// cada funcao com contadores que so existem no escopo do MODULO. O
// toString() serializa o codigo instrumentado, o contador nao viaja
// junto, e o codigo enviado ao navegador quebra — em silencio, porque em
// producao nao ha instrumentacao e o bug so aparece sob cobertura.
//
// Aqui a fonte E a string, e o Node deriva as funcoes dela. Uma regra so,
// impossivel de divergir, e imune a qualquer instrumentacao.
// ============================================================
'use strict';

/**
 * Piso por parcela.
 *
 * Sem piso, uma caneca de R$ 30 anunciaria "12x de R$ 2,50" — que nenhuma
 * operadora aceita e que faz a loja parecer desonesta. R$ 5 e o piso que
 * o mercado pratica.
 */
const PARCELA_MINIMA = 5;

/** O codigo que roda nos DOIS lados. */
const FONTE = `
var PARCELA_MINIMA = ${PARCELA_MINIMA};

/** Em quantas vezes ESTE preco cabe, respeitando o teto e o piso. */
function parcelasDoPreco(preco, teto) {
  var p = Number(preco);
  var t = Number(teto);
  if (!isFinite(p) || p <= 0) return null;
  if (!isFinite(t) || t < 2) return null;

  var cabe = Math.floor(p / PARCELA_MINIMA);
  var n = Math.min(Math.floor(t), cabe, 12);
  // 1x nao e parcelamento: e o preco a vista com outro nome.
  if (n < 2) return null;

  return { vezes: n, valor: p / n };
}

/**
 * A frase pronta, ja formatada em pt-BR.
 *
 * "sem juros" so aparece porque o campo e um TETO SEM JUROS declarado
 * pela lojista; se um dia houver parcelamento com juros, ele precisa de
 * outro campo e de outra frase.
 */
function textoDeParcelamento(preco, teto) {
  var r = parcelasDoPreco(preco, teto);
  if (!r) return null;
  var valor = r.valor.toFixed(2).replace('.', ',');
  return 'ou ' + r.vezes + 'x de R$ ' + valor + ' sem juros';
}
`;

// A string e um literal deste arquivo — nao ha entrada externa nenhuma
// aqui. O eval acontece uma vez, no carregamento do modulo.
const { parcelasDoPreco, textoDeParcelamento } = new Function(
  FONTE + 'return { parcelasDoPreco: parcelasDoPreco, textoDeParcelamento: textoDeParcelamento };',
)();

/**
 * A regra para o <script> da loja comum.
 *
 * `PARCELAS_TXT` le o teto de SETTINGS, entao o markup do cartao chama
 * so com o preco.
 */
function fonteClienteParcelamento() {
  return (
    FONTE +
    '\nfunction PARCELAS_TXT(preco){' +
    'return textoDeParcelamento(preco,(typeof SETTINGS!=="undefined"?SETTINGS.card_max_installments:null));' +
    '}\n'
  );
}

module.exports = {
  PARCELA_MINIMA,
  parcelasDoPreco,
  textoDeParcelamento,
  fonteClienteParcelamento,
};
