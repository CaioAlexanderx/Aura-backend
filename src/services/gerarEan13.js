// ============================================================
// AURA. — Gerador de EAN-13 interno (p-74, 30/10/2026)
//
// Faixa de circulação restrita da GS1: EAN-13 começando com 2 não precisa
// de registro e nunca colide com código de fabricante. Dentro dela a Aura
// usa a SÉRIE "210":
//
//   210 + contador de 9 dígitos + dígito verificador = 13 dígitos
//
// Por que 210 e não 200: o gerador antigo do app (generateEAN13 em
// buildLabelHtml.ts) espalha códigos "200" + hash por toda a faixa 200;
// em 30/10/2026 eram 5.048 códigos 200… gravados e nenhum 210…. Na série
// própria o contador é simplesmente "maior da série no grupo + 1".
//
// O contador é por GRUPO (empresas com o mesmo group_root), não por
// empresa: o bipe procura no grupo inteiro, então dois CNPJs do mesmo
// grupo não podem receber o mesmo número.
// ============================================================
'use strict';

const SERIE = '210';
const CONTADOR_DIGITOS = 9;
const CONTADOR_MAX = 10 ** CONTADOR_DIGITOS - 1;
// Casa qualquer código da série, com dígito verificador certo ou não:
// um 210… digitado à mão com DV errado ainda ocupa o número.
const SERIE_REGEX_SQL = `^${SERIE}[0-9]{10}$`;

/** Dígito verificador do EAN-13 para os 12 primeiros dígitos. */
function digitoVerificadorEan13(doze) {
  if (!/^\d{12}$/.test(doze)) throw new Error('EAN-13: esperava 12 dígitos');
  let soma = 0;
  for (let i = 0; i < 12; i++) soma += Number(doze[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (soma % 10)) % 10;
}

/** Código completo da série para o número n do contador (1..999.999.999). */
function codigoDaSerie(n) {
  if (!Number.isInteger(n) || n < 1 || n > CONTADOR_MAX) {
    throw new Error('EAN-13: contador fora da faixa');
  }
  const doze = SERIE + String(n).padStart(CONTADOR_DIGITOS, '0');
  return doze + digitoVerificadorEan13(doze);
}

module.exports = {
  SERIE,
  SERIE_REGEX_SQL,
  CONTADOR_MAX,
  digitoVerificadorEan13,
  codigoDaSerie,
};
