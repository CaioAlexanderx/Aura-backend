// ============================================================
// AURA KARATÊ — 5 notas de kata: total cortado + cascata de desempate
//
// Regra ditada pelo dono do produto (mesário no Paulista 2026):
// total = soma cortando a maior e a menor; desempate 1 = soma-se de
// volta a menor; desempate 2 = soma-se a maior; persistindo → NOVO KATA
// (o sistema sinaliza, nunca desempata sozinho). Funções puras — sem DB.
// ============================================================
'use strict';

const { normalizeNotas, computeKataTotals, compareKata } = require('../src/services/karateKataScoring');

describe('computeKataTotals — total cortado e desempates', () => {
  it('5 notas: corta a maior e a menor; tb1 devolve a menor; tb2 soma todas', () => {
    const t = computeKataTotals([7.0, 7.2, 7.4, 7.6, 6.8]);
    expect(t.total).toBeCloseTo(7.0 + 7.2 + 7.4, 2);   // corta 7.6 e 6.8
    expect(t.tb1).toBeCloseTo(t.total + 6.8, 2);
    expect(t.tb2).toBeCloseTo(7.0 + 7.2 + 7.4 + 7.6 + 6.8, 2);
  });

  it('extremos repetidos: corta UMA ocorrência de cada (7,7,7,7,7 → 21)', () => {
    const t = computeKataTotals([7, 7, 7, 7, 7]);
    expect(t.total).toBe(21);
    expect(t.tb1).toBe(28);
    expect(t.tb2).toBe(35);
  });

  it('centésimos não sofrem ruído de float (0.1+0.2 etc.)', () => {
    const t = computeKataTotals([7.1, 7.2, 7.3, 7.4, 7.5]);
    expect(t.total).toBe(21.9); // 7.2+7.3+7.4 exato
  });
});

describe('compareKata — cascata real', () => {
  const A = { nota: 21.6, notas: [7.0, 7.2, 7.4, 7.6, 6.8] }; // total 21.6, tb1 28.4, tb2 36.0
  it('total maior vence', () => {
    const B = { nota: 21.0, notas: [7.0, 7.0, 7.0, 7.5, 6.5] }; // total 21.0
    expect(compareKata(A, B)).toBeLessThan(0); // A antes (desc)
  });

  it('total igual → decide a nota mais baixa somada de volta (tb1)', () => {
    // Ambos total 21.6; B tem menor mais baixa (6.6) → tb1 menor → perde.
    const B = { nota: 21.6, notas: [7.2, 7.2, 7.2, 7.7, 6.6] };
    const tA = computeKataTotals(A.notas); const tB = computeKataTotals(B.notas);
    expect(tA.total).toBeCloseTo(tB.total, 2);
    expect(compareKata(A, B)).toBeLessThan(0);
  });

  it('total e tb1 iguais → decide a maior somada (tb2)', () => {
    // Mesmo total (21.6) e mesma menor (6.8) → tb1 igual; maior diferente.
    const B = { nota: 21.6, notas: [7.0, 7.2, 7.4, 7.9, 6.8] };
    const tA = computeKataTotals(A.notas); const tB = computeKataTotals(B.notas);
    expect(tA.tb1).toBeCloseTo(tB.tb1, 2);
    expect(compareKata(A, B)).toBeGreaterThan(0); // B tem tb2 maior → vem antes
  });

  it('notas idênticas → 0 (empate persistente = novo kata)', () => {
    const B = { nota: 21.6, notas: [...A.notas] };
    expect(compareKata(A, B)).toBe(0);
  });

  it('legado sem notas[]: compara só pela nota única', () => {
    expect(compareKata({ nota: 20.0, notas: null }, { nota: 19.5, notas: null })).toBeLessThan(0);
    expect(compareKata({ nota: 19.5, notas: null }, { nota: 19.5, notas: null })).toBe(0);
  });
});

describe('normalizeNotas', () => {
  it('aceita 3 a 7 números 0..10; rejeita fora disso', () => {
    expect(normalizeNotas([7, 7.5, 8, 6.9, 7.1])).toEqual([7, 7.5, 8, 6.9, 7.1]);
    expect(normalizeNotas(['7.0', '7.5', '8'])).toEqual([7, 7.5, 8]);
    expect(normalizeNotas([7, 8])).toBeNull();          // menos de 3
    expect(normalizeNotas([7, 8, 11])).toBeNull();      // fora da escala
    expect(normalizeNotas([7, 8, 'x'])).toBeNull();     // não numérico
    expect(normalizeNotas('7,8,9')).toBeNull();         // não é array
  });
});
