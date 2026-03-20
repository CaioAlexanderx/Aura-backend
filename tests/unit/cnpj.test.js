// ============================================================
// AURA. — QA-01: Testes Unitários — CNPJ
// ============================================================

const {
  validateCNPJ,
  formatCNPJ,
  sanitizeCNPJ,
} = require('../../src/services/cnpj');

describe('CNPJ — validateCNPJ', () => {
  test('CNPJ válido sem formatação', () => {
    expect(validateCNPJ('11222333000181')).toBe(true);
  });

  test('CNPJ válido com formatação', () => {
    expect(validateCNPJ('11.222.333/0001-81')).toBe(true);
  });

  test('CNPJ com todos os dígitos iguais é inválido', () => {
    expect(validateCNPJ('00000000000000')).toBe(false);
    expect(validateCNPJ('11111111111111')).toBe(false);
    expect(validateCNPJ('99999999999999')).toBe(false);
  });

  test('CNPJ com menos de 14 dígitos é inválido', () => {
    expect(validateCNPJ('1122233300018')).toBe(false);
  });

  test('CNPJ com mais de 14 dígitos é inválido', () => {
    expect(validateCNPJ('112223330001810')).toBe(false);
  });

  test('CNPJ com dígito verificador errado é inválido', () => {
    expect(validateCNPJ('11222333000182')).toBe(false);
  });

  test('string vazia é inválida', () => {
    expect(validateCNPJ('')).toBe(false);
  });

  test('CNPJ nulo/undefined é inválido', () => {
    expect(validateCNPJ(null)).toBe(false);
    expect(validateCNPJ(undefined)).toBe(false);
  });

  test('CNPJ com letras é inválido', () => {
    expect(validateCNPJ('1122233300018A')).toBe(false);
  });
});

describe('CNPJ — formatCNPJ', () => {
  test('formata CNPJ sem pontuação', () => {
    expect(formatCNPJ('11222333000181')).toBe('11.222.333/0001-81');
  });

  test('CNPJ já formatado permanece igual', () => {
    expect(formatCNPJ('11.222.333/0001-81')).toBe('11.222.333/0001-81');
  });

  test('CNPJ inválido retorna o valor original', () => {
    expect(formatCNPJ('123')).toBe('123');
  });
});

describe('CNPJ — sanitizeCNPJ', () => {
  test('remove pontos, barras e hífens', () => {
    expect(sanitizeCNPJ('11.222.333/0001-81')).toBe('11222333000181');
  });

  test('mantém apenas dígitos', () => {
    expect(sanitizeCNPJ('11.222.333/0001-81 ')).toBe('11222333000181');
  });

  test('string já limpa permanece igual', () => {
    expect(sanitizeCNPJ('11222333000181')).toBe('11222333000181');
  });
});
