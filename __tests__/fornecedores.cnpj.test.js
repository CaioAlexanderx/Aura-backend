// ============================================================
// AURA. — Fase 1 fornecedores: validação de CNPJ (src/utils/cnpj.js)
//
// O tipo 'cnpj' de src/utils/validate.js só confere 14 dígitos -- não
// calcula os dígitos verificadores. Suppliers precisa da conta de
// verdade (módulo 11) pra não deixar passar CNPJ com dígito errado.
// ============================================================
'use strict';

const { onlyDigits, isValidCnpj } = require('../src/utils/cnpj');

describe('onlyDigits', () => {
  test('remove mascara e mantem so numeros', () => {
    expect(onlyDigits('11.222.333/0001-81')).toBe('11222333000181');
  });

  test('null/undefined viram string vazia', () => {
    expect(onlyDigits(null)).toBe('');
    expect(onlyDigits(undefined)).toBe('');
  });
});

describe('isValidCnpj', () => {
  test('aceita CNPJ valido com mascara', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
  });

  test('aceita CNPJ valido sem mascara', () => {
    expect(isValidCnpj('11444777000161')).toBe(true);
  });

  test('recusa digito verificador errado', () => {
    expect(isValidCnpj('11.222.333/0001-80')).toBe(false);
  });

  test('recusa sequencia repetida (passa no modulo 11 mas nao e CNPJ real)', () => {
    expect(isValidCnpj('00.000.000/0000-00')).toBe(false);
    expect(isValidCnpj('11.111.111/1111-11')).toBe(false);
  });

  test('recusa tamanho errado', () => {
    expect(isValidCnpj('123')).toBe(false);
    expect(isValidCnpj('112223330001811')).toBe(false); // 15 digitos
  });

  test('recusa vazio/null/undefined', () => {
    expect(isValidCnpj('')).toBe(false);
    expect(isValidCnpj(null)).toBe(false);
    expect(isValidCnpj(undefined)).toBe(false);
  });
});
