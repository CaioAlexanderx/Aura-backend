// ============================================================
// AURA. -- Testes unitarios: src/services/credit/unify.js
// Item 3 (13/06/2026): motor puro de unificacao de carne.
// ============================================================

const { computeUnifyPlan } = require('../../src/services/credit/unify');

const sumSchedule = (s) => Math.round(s.reduce((a, b) => a + b.amount_due, 0) * 100) / 100;

describe('computeUnifyPlan', () => {
  test('sem juros: soma saldo aberto + nova compra e redivide em N', () => {
    const p = computeUnifyPlan({
      openInstallments: [
        { id: 'a', amount_due: 50, covered_amount: 0 },
        { id: 'b', amount_due: 50, covered_amount: 0 },
      ],
      newAmount: 100,
      installments: 4,
      firstDueDate: '2026-07-01',
    });

    expect(p.open_remaining).toBeCloseTo(100, 2);
    expect(p.new_amount).toBeCloseTo(100, 2);
    expect(p.interest_added).toBe(0);
    expect(p.total).toBeCloseTo(200, 2);
    expect(p.schedule).toHaveLength(4);
    expect(p.schedule.map((s) => s.amount_due)).toEqual([50, 50, 50, 50]);
    expect(sumSchedule(p.schedule)).toBeCloseTo(p.total, 2);
    expect(p.replaced_installment_ids).toEqual(['a', 'b']);
  });

  test('parcela paga em parte: carrega so o restante (amount_due - covered_amount)', () => {
    const p = computeUnifyPlan({
      openInstallments: [{ id: 'a', amount_due: 100, covered_amount: 30 }],
      newAmount: 30,
      installments: 2,
      firstDueDate: '2026-07-10',
    });

    expect(p.open_remaining).toBeCloseTo(70, 2); // 100 - 30
    expect(p.total).toBeCloseTo(100, 2);         // 70 + 30
    expect(p.schedule.map((s) => s.amount_due)).toEqual([50, 50]);
    expect(sumSchedule(p.schedule)).toBeCloseTo(100, 2);
  });

  test('com juros: juros simples SO sobre a nova compra (newAmount * rate * N)', () => {
    const p = computeUnifyPlan({
      openInstallments: [],
      newAmount: 100,
      installments: 3,
      interestRate: 0.02, // 2% a.m.
      firstDueDate: '2026-07-01',
    });

    expect(p.interest_added).toBeCloseTo(6, 2); // 100 * 0.02 * 3
    expect(p.total).toBeCloseTo(106, 2);
    // floor(106/3)=35.33, resto na ultima
    expect(p.schedule.map((s) => s.amount_due)).toEqual([35.33, 35.33, 35.34]);
    expect(sumSchedule(p.schedule)).toBeCloseTo(106, 2);
  });

  test('juros NAO incide sobre o saldo ja parcelado (so sobre a nova compra)', () => {
    const p = computeUnifyPlan({
      openInstallments: [{ id: 'a', amount_due: 200, covered_amount: 0 }],
      newAmount: 100,
      installments: 2,
      interestRate: 0.05,
      firstDueDate: '2026-08-01',
    });
    // saldo 200 entra a face; juros so sobre 100: 100*0.05*2 = 10
    expect(p.interest_added).toBeCloseTo(10, 2);
    expect(p.total).toBeCloseTo(310, 2); // 200 + 100 + 10
    expect(sumSchedule(p.schedule)).toBeCloseTo(310, 2);
  });

  test('reparcelar sem nova compra (newAmount 0) e valido', () => {
    const p = computeUnifyPlan({
      openInstallments: [{ id: 'a', amount_due: 33.33, covered_amount: 0 }],
      newAmount: 0,
      installments: 1,
      firstDueDate: '2026-07-01',
    });
    expect(p.total).toBeCloseTo(33.33, 2);
    expect(p.schedule.map((s) => s.amount_due)).toEqual([33.33]);
  });

  test('N clampado em 1..36', () => {
    expect(computeUnifyPlan({ newAmount: 10, installments: 0 }).installments_count).toBe(1);
    expect(computeUnifyPlan({ newAmount: 10, installments: 999 }).installments_count).toBe(36);
  });

  test('determinismo: soma das parcelas == total em valores quebrados', () => {
    const p = computeUnifyPlan({
      openInstallments: [{ id: 'a', amount_due: 77.77, covered_amount: 11.11 }],
      newAmount: 123.45,
      installments: 7,
      interestRate: 0.013,
      firstDueDate: '2026-09-15',
    });
    expect(sumSchedule(p.schedule)).toBeCloseTo(p.total, 2);
    expect(p.schedule).toHaveLength(7);
  });

  test('datas seguem a periodicidade (semanal)', () => {
    const p = computeUnifyPlan({
      openInstallments: [],
      newAmount: 90,
      installments: 3,
      firstDueDate: '2026-07-01',
      periodUnit: 'week',
      periodCount: 1,
    });
    expect(p.schedule[0].due_date).toBe('2026-07-01');
    expect(p.schedule[1].due_date).toBe('2026-07-08');
    expect(p.schedule[2].due_date).toBe('2026-07-15');
  });
});
