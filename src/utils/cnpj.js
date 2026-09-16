// ============================================================
// AURA. — Validação de CNPJ (Fase 1 fornecedores, 16/09/2026)
//
// src/utils/validate.js já tem um tipo 'cnpj' no schema validator, mas
// ele só confere 14 dígitos — não calcula os dígitos verificadores. Pra
// fornecedor isso deixa passar CNPJ digitado errado (transposição de
// dígito, por exemplo) sem avisar a lojista. Este módulo faz a conta de
// verdade (módulo 11, padrão da Receita Federal) e fica em utils/ pra
// poder ser reusado fora de suppliers.js sem duplicar o algoritmo.
// ============================================================
'use strict';

function onlyDigits(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

function calcDV(base) {
  const weights = base.length === 12
    ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const sum = base
    .split('')
    .reduce((acc, digit, i) => acc + Number(digit) * weights[i], 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/**
 * Valida CNPJ (14 dígitos + 2 dígitos verificadores, módulo 11).
 * Aceita com ou sem máscara. Recusa sequências repetidas
 * (00.000.000/0000-00 etc — passam no módulo 11 mas não são CNPJ real).
 * @param {string} raw
 * @returns {boolean}
 */
function isValidCnpj(raw) {
  const digits = onlyDigits(raw);
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;

  const base = digits.slice(0, 12);
  const dv1 = calcDV(base);
  const dv2 = calcDV(base + String(dv1));
  return digits === base + String(dv1) + String(dv2);
}

module.exports = { onlyDigits, isValidCnpj };
