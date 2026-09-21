// ============================================================
// AURA. — Validação de CPF/CNPJ (dígito verificador)
//
// Usado no PATCH de clientes (Fase 1 · perfil do cliente). A normalização
// (só dígitos) segue src/utils/personIdentity.js: customers.cpf_cnpj passa a
// ser gravado sem máscara quando vem pela ficha.
//
// storefront.js e studioStorefront.js têm cópias inline de validateCpf; não
// foram trocadas aqui para não mexer no checkout da vitrine neste PR.
// ============================================================
'use strict';

const { onlyDigits } = require('./personIdentity');

function allSameDigit(d) {
  return /^(\d)\1+$/.test(d);
}

function isValidCpf(raw) {
  const d = onlyDigits(raw);
  if (d.length !== 11 || allSameDigit(d)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function isValidCnpj(raw) {
  const d = onlyDigits(raw);
  if (d.length !== 14 || allSameDigit(d)) return false;
  const calc = (len) => {
    const weights = len === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

/**
 * Entrada do campo cpf_cnpj da ficha.
 *   vazio/null            -> { ok: true, value: null }  (apaga o documento)
 *   CPF válido (11)       -> { ok: true, value: '<11 dígitos>' }
 *   CNPJ válido (14)      -> { ok: true, value: '<14 dígitos>' }
 *   qualquer outra coisa  -> { ok: false, error }
 */
function parseCpfCnpjInput(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const s = String(raw).trim();
  if (!s) return { ok: true, value: null };
  const d = onlyDigits(s);
  if (d.length === 11) {
    return isValidCpf(d) ? { ok: true, value: d } : { ok: false, error: 'CPF invalido' };
  }
  if (d.length === 14) {
    return isValidCnpj(d) ? { ok: true, value: d } : { ok: false, error: 'CNPJ invalido' };
  }
  return { ok: false, error: 'CPF/CNPJ deve ter 11 ou 14 digitos' };
}

module.exports = { isValidCpf, isValidCnpj, parseCpfCnpjInput };
