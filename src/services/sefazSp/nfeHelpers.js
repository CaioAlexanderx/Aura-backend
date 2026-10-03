// ============================================================
// AURA. — sefazSp/nfeHelpers: funções PURAS (sem I/O) do leiaute NF-e/NFC-e
// usadas pela engine própria: código da UF, data/hora no fuso de Brasília,
// cNF, chave de acesso de 44 dígitos (com DV) e validação de tPag.
//
// 03/10/2026 — extraídas de services/nuvemfiscal.js sem mudar comportamento:
// a engine própria não pode depender do módulo do gateway (que está de
// saída). services/nuvemfiscal.js reexporta daqui enquanto existir.
// ============================================================
'use strict';

const UF_CUF = {
  RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17,
  MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29,
  MG: 31, ES: 32, RJ: 33, SP: 35,
  PR: 41, SC: 42, RS: 43,
  MS: 50, MT: 51, GO: 52, DF: 53,
};
function ufToCodigo(uf) { return UF_CUF[(uf || '').toUpperCase().trim()] || 35; }

function isoBR(d = new Date()) {
  const local = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return local.toISOString().replace(/\.\d{3}Z$/, '-03:00');
}

function generateCNF() {
  return String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
}

function calcDvChaveAcesso(chave43) {
  const w = [2, 3, 4, 5, 6, 7, 8, 9];
  let sum = 0;
  for (let i = chave43.length - 1, k = 0; i >= 0; i--, k = (k + 1) % w.length) {
    sum += parseInt(chave43[i], 10) * w[k];
  }
  const mod = sum % 11;
  return String(mod < 2 ? 0 : 11 - mod);
}

function buildAccessKey44({ cUF, ano2, mes2, cnpj, mod, serie, nNF, tpEmis, cNF }) {
  const k43 =
    String(cUF).padStart(2, '0') +
    String(ano2).padStart(2, '0') +
    String(mes2).padStart(2, '0') +
    String(cnpj).replace(/\D/g, '').padStart(14, '0') +
    String(mod).padStart(2, '0') +
    String(serie).padStart(3, '0') +
    String(nNF).padStart(9, '0') +
    String(tpEmis).padStart(1, '0') +
    String(cNF).padStart(8, '0');
  return k43 + calcDvChaveAcesso(k43);
}

const VALID_TPAG = new Set(['01','02','03','04','05','10','11','12','13','15','16','17','18','19','90','99']);
function validateTpag(method) {
  const t = String(method || '01').padStart(2, '0').slice(0, 2);
  return VALID_TPAG.has(t) ? t : '99';
}

module.exports = {
  ufToCodigo, isoBR, generateCNF, calcDvChaveAcesso, buildAccessKey44, validateTpag,
};
