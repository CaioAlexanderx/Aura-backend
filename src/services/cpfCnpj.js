// ============================================================
// AURA. — CPF/CNPJ do cliente da loja online
//
// A validacao de digito vivia COPIADA em routes/storefront.js e em
// routes/studioStorefront.js (identicas, conferido por diff em
// 25/09/2026). A Fase 2 da vitrine Studio passa a pedir CPF/CNPJ no
// checkout ("Quero CPF/CNPJ na nota") e o contrato e a MESMA validacao da
// loja comum — entao as duas lojas passam a importar daqui, e uma
// correcao nao vale numa loja e na outra nao.
// ============================================================
'use strict';

/**
 * @returns {string|null|false} os digitos quando valido; null quando
 *   vazio (o cliente nao informou); false quando informado e invalido.
 */
function validateCpfCnpj(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 11) return validateCpf(d) ? d : false;
  if (d.length === 14) return validateCnpj(d) ? d : false;
  return false;
}

function validateCpf(d) {
  if (/^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(d[i]) * (10 - i);
  let r = (s * 10) % 11; if (r === 10) r = 0;
  if (r !== parseInt(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(d[i]) * (11 - i);
  r = (s * 10) % 11; if (r === 10) r = 0;
  return r === parseInt(d[10]);
}

function validateCnpj(d) {
  if (/^(\d)\1{13}$/.test(d)) return false;
  const w1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  const w2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
  let s = 0;
  for (let i = 0; i < 12; i++) s += parseInt(d[i]) * w1[i];
  let r = s % 11; r = r < 2 ? 0 : 11 - r;
  if (r !== parseInt(d[12])) return false;
  s = 0;
  for (let i = 0; i < 13; i++) s += parseInt(d[i]) * w2[i];
  r = s % 11; r = r < 2 ? 0 : 11 - r;
  return r === parseInt(d[13]);
}

module.exports = { validateCpfCnpj, validateCpf, validateCnpj };
