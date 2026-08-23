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

/**
 * Em quantas vezes ESTE preco cabe, respeitando o teto e o piso.
 *
 * Devolve null quando nao ha parcelamento a mostrar — a loja entao mostra
 * so o preco, que e o comportamento de hoje.
 */
function parcelasDoPreco(preco, teto) {
  const p = Number(preco);
  const t = Number(teto);
  if (!Number.isFinite(p) || p <= 0) return null;
  if (!Number.isFinite(t) || t < 2) return null;

  const cabe = Math.floor(p / PARCELA_MINIMA);
  const n = Math.min(Math.floor(t), cabe, 12);
  // 1x nao e parcelamento: e o preco a vista com outro nome.
  if (n < 2) return null;

  return { vezes: n, valor: p / n };
}

/**
 * A frase pronta, ja formatada em pt-BR.
 *
 * "sem juros" so aparece porque o campo e um TETO SEM JUROS declarado pela
 * lojista; se um dia houver parcelamento com juros, ele precisa de outro
 * campo e de outra frase.
 */
function textoDeParcelamento(preco, teto) {
  const r = parcelasDoPreco(preco, teto);
  if (!r) return null;
  const valor = r.valor.toFixed(2).replace('.', ',');
  return `ou ${r.vezes}x de R$ ${valor} sem juros`;
}

/**
 * As mesmas funcoes, serializadas para o <script> da loja comum.
 *
 * Mesmo motivo do storefrontCapa: a regra e uma so e vai para o cliente,
 * em vez de reescrita a mao. `PARCELAS_TXT` le o teto de SETTINGS, entao
 * o markup do cartao chama sem passar configuracao.
 */
function fonteClienteParcelamento() {
  return [
    'var PARCELA_MINIMA=' + PARCELA_MINIMA + ';',
    parcelasDoPreco.toString(),
    textoDeParcelamento.toString(),
    'function PARCELAS_TXT(preco){return textoDeParcelamento(preco,(typeof SETTINGS!=="undefined"?SETTINGS.card_max_installments:null));}',
    '',
  ].join(String.fromCharCode(10));
}

module.exports = {
  PARCELA_MINIMA,
  parcelasDoPreco,
  textoDeParcelamento,
  fonteClienteParcelamento,
};
