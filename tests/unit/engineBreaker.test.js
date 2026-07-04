// ============================================================
// S4.3 — Circuit breaker da emissão própria (engineBreaker).
// Threshold, janela de 15min, isolamento POR COMPANY, sucesso reseta.
// ============================================================
const breaker = require('../../src/services/sefazSp/engineBreaker');

const A = 'company-A';
const B = 'company-B';

beforeEach(() => breaker.reset());

describe('threshold', () => {
  test('1 falha não abre; 2 falhas consecutivas abrem', () => {
    breaker.recordFailure(A);
    expect(breaker.isOpen(A)).toBe(false);
    breaker.recordFailure(A);
    expect(breaker.isOpen(A)).toBe(true);
  });

  test('FAILURE_THRESHOLD é 2 e OPEN_WINDOW_MS é 15min', () => {
    expect(breaker.FAILURE_THRESHOLD).toBe(2);
    expect(breaker.OPEN_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

describe('janela de tempo', () => {
  test('aberto durante a janela, sonda depois dela', () => {
    const t0 = 1_000_000;
    breaker.recordFailure(A, t0);
    breaker.recordFailure(A, t0);
    expect(breaker.isOpen(A, t0 + 60_000)).toBe(true);              // dentro
    expect(breaker.isOpen(A, t0 + breaker.OPEN_WINDOW_MS - 1)).toBe(true);
    expect(breaker.isOpen(A, t0 + breaker.OPEN_WINDOW_MS + 1)).toBe(false); // expirou
  });
});

describe('isolamento por company', () => {
  test('abrir A não afeta B', () => {
    breaker.recordFailure(A);
    breaker.recordFailure(A);
    expect(breaker.isOpen(A)).toBe(true);
    expect(breaker.isOpen(B)).toBe(false);
  });
});

describe('sucesso reseta', () => {
  test('recordSuccess fecha o breaker e zera o contador', () => {
    breaker.recordFailure(A);
    breaker.recordFailure(A);
    expect(breaker.isOpen(A)).toBe(true);
    breaker.recordSuccess(A);
    expect(breaker.isOpen(A)).toBe(false);
    // após reset, precisa de 2 novas falhas pra reabrir
    breaker.recordFailure(A);
    expect(breaker.isOpen(A)).toBe(false);
    breaker.recordFailure(A);
    expect(breaker.isOpen(A)).toBe(true);
  });

  test('1 falha seguida de sucesso não deixa resíduo', () => {
    breaker.recordFailure(A);
    breaker.recordSuccess(A);
    breaker.recordFailure(A);
    expect(breaker.isOpen(A)).toBe(false); // só 1 falha desde o reset
  });
});

describe('snapshot / reset', () => {
  test('snapshot reflete estado', () => {
    breaker.recordFailure(A);
    breaker.recordFailure(A);
    const s = breaker.snapshot(A);
    expect(s.open).toBe(true);
    expect(s.consecutiveFailures).toBe(2);
    expect(s.openUntil).toBeGreaterThan(0);
  });

  test('reset limpa tudo', () => {
    breaker.recordFailure(A);
    breaker.recordFailure(A);
    breaker.reset();
    expect(breaker.isOpen(A)).toBe(false);
    expect(breaker.snapshot(A).consecutiveFailures).toBe(0);
  });
});
