// ============================================================
// AURA KARATÊ — Teste unitário: computeTotals (Fase F3)
// F3 corrigiu computeTotals.paid_total, que era binário (só somava
// parcelas status='paid' pelo valor cheio) — com baixa parcial (F1,
// applyAnnuityPayment/amount_paid), isso subestimava o valor recebido.
// Ver também a correção irmã em karateAnnuitySummary.js (SUMMARY_SQL).
// ============================================================
'use strict';

const { computeTotals } = require('../../src/services/karateAnnuityService');

describe('computeTotals — F3: paid_total soma amount_paid, não só status=paid', () => {
  test('parcela PARCIAL contribui pelo amount_paid real, não 0 nem o valor cheio', () => {
    const installments = [
      { amount: 500, amount_paid: 300, status: 'partial' },
      { amount: 200, amount_paid: 0, status: 'pending' },
    ];
    const { total, paid_total } = computeTotals(installments);
    expect(total).toBe(700);
    expect(paid_total).toBe(300); // não 0 (binário antigo) nem 500 (valor cheio)
  });

  test('mistura paga + parcial + pendente soma corretamente', () => {
    const installments = [
      { amount: 100, amount_paid: 100, status: 'paid' },
      { amount: 100, amount_paid: 40, status: 'partial' },
      { amount: 100, amount_paid: 0, status: 'pending' },
    ];
    const { total, paid_total } = computeTotals(installments);
    expect(total).toBe(300);
    expect(paid_total).toBe(140);
  });

  test('sem amount_paid na linha (SELECT antigo/migration 247 ausente): cai pro binário como fallback seguro', () => {
    const installments = [
      { amount: 100, status: 'paid' }, // amount_paid ausente (undefined)
      { amount: 100, status: 'pending' },
    ];
    const { total, paid_total } = computeTotals(installments);
    expect(total).toBe(200);
    expect(paid_total).toBe(100); // fallback: só a 'paid' conta, pelo valor cheio
  });

  test('lista vazia -> zeros, nunca lança', () => {
    expect(computeTotals([])).toEqual({ total: 0, paid_total: 0 });
    expect(computeTotals(null)).toEqual({ total: 0, paid_total: 0 });
  });
});
