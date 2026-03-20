const {
  calculateINSS, calculateIRRF, calculateFGTS, calculatePayroll, INSS_MAX_2026,
} = require('../../src/services/payroll');

describe('Payroll — calculateINSS', () => {
  test('salário zero retorna INSS zero', () => {
    expect(calculateINSS(0)).toBe(0);
  });
  test('salário negativo retorna INSS zero', () => {
    expect(calculateINSS(-100)).toBe(0);
  });
  test('salário na 1ª faixa (R$ 1.518) — 7,5%', () => {
    expect(calculateINSS(1518)).toBe(113.85);
  });
  test('salário na 2ª faixa (R$ 2.000)', () => {
    expect(calculateINSS(2000)).toBe(157.23);
  });
  test('salário na 3ª faixa (R$ 3.500)', () => {
    expect(calculateINSS(3500)).toBe(313.41);
  });
  test('salário acima do teto retorna valor máximo (951.63)', () => {
    expect(calculateINSS(20000)).toBe(INSS_MAX_2026);
    expect(INSS_MAX_2026).toBe(951.63);
  });
  test('salário exatamente no teto (R$ 8.157,41)', () => {
    expect(calculateINSS(8157.41)).toBe(INSS_MAX_2026);
  });
});

describe('Payroll — calculateIRRF', () => {
  test('base abaixo da isenção retorna IRRF zero', () => {
    const inss = calculateINSS(2000);
    expect(calculateIRRF(2000, inss, 0)).toBe(0);
  });
  test('IRRF não pode ser negativo', () => {
    expect(calculateIRRF(1000, 100, 5)).toBeGreaterThanOrEqual(0);
  });
  test('dependente reduz a base de cálculo do IRRF', () => {
    const inss = calculateINSS(5000);
    const irrf0 = calculateIRRF(5000, inss, 0);
    const irrf1 = calculateIRRF(5000, inss, 1);
    expect(irrf1).toBeLessThan(irrf0);
  });
  test('salário alto (R$ 10.000) gera IRRF positivo', () => {
    const inss = calculateINSS(10000);
    const irrf = calculateIRRF(10000, inss, 0);
    expect(irrf).toBeGreaterThan(0);
  });
});

describe('Payroll — calculateFGTS', () => {
  test('FGTS é 8% do salário bruto', () => {
    expect(calculateFGTS(1000)).toBe(80);
    expect(calculateFGTS(3500)).toBe(280);
  });
  test('salário zero retorna FGTS zero', () => {
    expect(calculateFGTS(0)).toBe(0);
  });
  test('salário negativo retorna FGTS zero', () => {
    expect(calculateFGTS(-500)).toBe(0);
  });
});

describe('Payroll — calculatePayroll (holerite completo)', () => {
  test('holerite com salário mínimo 2026 (R$ 1.518)', () => {
    const result = calculatePayroll(1518);
    expect(result.gross_salary).toBe(1518);
    expect(result.inss_employee).toBe(113.85);
    expect(result.fgts).toBe(121.44);
    expect(result.net_salary).toBeGreaterThan(0);
    expect(result.net_salary).toBeLessThan(result.gross_salary);
  });
  test('salário líquido nunca é negativo', () => {
    const result = calculatePayroll(1518, 0, 99999);
    expect(result.net_salary).toBe(0);
  });
  test('adições aumentam o bruto', () => {
    const result = calculatePayroll(3000, 0, 0, 500);
    expect(result.gross_salary).toBe(3500);
  });
  test('holerite retorna todas as propriedades obrigatórias', () => {
    const result = calculatePayroll(3000);
    expect(result).toHaveProperty('gross_salary');
    expect(result).toHaveProperty('inss_employee');
    expect(result).toHaveProperty('irrf');
    expect(result).toHaveProperty('fgts');
    expect(result).toHaveProperty('net_salary');
    expect(result).toHaveProperty('other_deductions');
    expect(result).toHaveProperty('other_additions');
  });
});
