// ============================================================
// AURA — as faixas do filtro de preco (fase 4 do redesign, 02/09/2026)
//
// O design trazia "Até R$ 200 / R$ 200 a R$ 300 / Acima de R$ 300" fixos.
// Numa loja de bijuteria as tres cairiam na primeira; numa de moveis, na
// ultima. As faixas nascem do MENOR e do MAIOR preco visivel da loja
// (facetas.preco, fase 1), cortados em numeros redondos.
//
// A mesma conta roda no servidor (testes) e no navegador (dentro do
// <script> da loja) — por isso a fonte E uma string, como parcelamento.js:
// serializar com Function.prototype.toString quebra sob cobertura.
// ============================================================
'use strict';

const FONTE = `
/** Arredonda pra um numero "de vitrine": 10, 50, 100, 500 conforme o tamanho. */
function precoRedondo(v) {
  var n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  var passo = n < 100 ? 10 : n < 500 ? 50 : n < 2000 ? 100 : 500;
  return Math.round(n / passo) * passo;
}

/**
 * Ate tres faixas entre o menor e o maior preco. Cada uma diz o que
 * manda pra rota (min/max em reais; null = sem limite) e o rotulo.
 * Loja com um preco so, ou faixa estreita demais pra cortar, devolve [].
 */
function faixasDePreco(min, max) {
  var a = Number(min), b = Number(max);
  if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= a) return [];
  var c1 = precoRedondo(a + (b - a) / 3);
  var c2 = precoRedondo(a + 2 * (b - a) / 3);
  if (c1 <= a) c1 = 0;
  if (c2 >= b || c2 <= c1) c2 = 0;
  var cortes = [c1, c2].filter(function (c) { return c > 0; });
  if (!cortes.length) return [];
  var faixas = [];
  var reais = function (v) { return 'R$ ' + String(v); };
  faixas.push({ min: null, max: cortes[0], rotulo: 'Até ' + reais(cortes[0]) });
  for (var i = 1; i < cortes.length; i++) {
    faixas.push({ min: cortes[i - 1], max: cortes[i], rotulo: reais(cortes[i - 1]) + ' a ' + reais(cortes[i]) });
  }
  faixas.push({ min: cortes[cortes.length - 1], max: null, rotulo: 'Acima de ' + reais(cortes[cortes.length - 1]) });
  return faixas;
}
`;

// O Node deriva as funcoes da MESMA string que vai pro navegador.
// eslint-disable-next-line no-new-func
const { precoRedondo, faixasDePreco } = new Function(FONTE + '\nreturn { precoRedondo: precoRedondo, faixasDePreco: faixasDePreco };')();

module.exports = { FONTE, precoRedondo, faixasDePreco };
