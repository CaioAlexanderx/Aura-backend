// ============================================================
// AURA KARATÊ — Fase F2 da reforma da anuidade (21/07/2026):
// testes PUROS (sem DB) de karateAnnuityService — anuidade
// PROPORCIONAL (dojô filiado durante o ano) + parcela de ADESÃO.
// Mesmo estilo de __tests__/karate.annuityInstallments.test.js (F1).
// ============================================================
'use strict';

const svc = require('../src/services/karateAnnuityService');

describe('remainingMonthsFromAffiliation', () => {
  it('janeiro (mês 1) -> 12 meses restantes (ano cheio)', () => {
    expect(svc.remainingMonthsFromAffiliation(1)).toBe(12);
  });
  it('julho (mês 7) -> 6 meses restantes', () => {
    expect(svc.remainingMonthsFromAffiliation(7)).toBe(6);
  });
  it('dezembro (mês 12) -> 1 mês restante', () => {
    expect(svc.remainingMonthsFromAffiliation(12)).toBe(1);
  });
  it('mês inválido lança erro (0, 13, não-inteiro)', () => {
    expect(() => svc.remainingMonthsFromAffiliation(0)).toThrow();
    expect(() => svc.remainingMonthsFromAffiliation(13)).toThrow();
    expect(() => svc.remainingMonthsFromAffiliation(7.5)).toThrow();
  });
});

describe('computeProportionalAnnuity', () => {
  it('jan -> valor cheio (mês de ingresso conta cheio, 12/12)', () => {
    expect(svc.computeProportionalAnnuity({ annualAmount: 600, affiliationMonth: 1, year: 2026 })).toBe(600);
  });
  it('jul -> 6/12 do anual', () => {
    expect(svc.computeProportionalAnnuity({ annualAmount: 600, affiliationMonth: 7, year: 2026 })).toBe(300);
  });
  it('dez -> 1/12 do anual', () => {
    expect(svc.computeProportionalAnnuity({ annualAmount: 600, affiliationMonth: 12, year: 2026 })).toBe(50);
  });
  it('arredondamento: divisão que não fecha em centavos exatos', () => {
    // 100 * 10/12 = 83.333... -> arredonda para 83.33 (centavos inteiros,
    // nunca acumula fração de centavo em float solto).
    expect(svc.computeProportionalAnnuity({ annualAmount: 100, affiliationMonth: 3, year: 2026 })).toBe(83.33);
  });
  it('não é sensível a `year` (regra depende só do mês de ingresso)', () => {
    const a = svc.computeProportionalAnnuity({ annualAmount: 600, affiliationMonth: 7, year: 2026 });
    const b = svc.computeProportionalAnnuity({ annualAmount: 600, affiliationMonth: 7, year: 2027 });
    expect(a).toBe(b);
  });
});

describe('distributeAmountAcrossInstallments', () => {
  it('divide igualmente quando fecha exato', () => {
    expect(svc.distributeAmountAcrossInstallments(300, 2)).toEqual([150, 150]);
  });
  it('resto de centavos vai inteiro pra ÚLTIMA parcela — soma nunca diverge do total', () => {
    const amounts = svc.distributeAmountAcrossInstallments(100, 3);
    // 100/3 = 33.33 base, resto absorvido pela última (33.34).
    expect(amounts).toEqual([33.33, 33.33, 33.34]);
    const sum = amounts.reduce((s, a) => s + a, 0);
    expect(Math.round(sum * 100) / 100).toBe(100);
  });
  it('count=1 devolve o total inteiro numa parcela só', () => {
    expect(svc.distributeAmountAcrossInstallments(83.33, 1)).toEqual([83.33]);
  });
  it('count inválido lança erro', () => {
    expect(() => svc.distributeAmountAcrossInstallments(100, 0)).toThrow();
    expect(() => svc.distributeAmountAcrossInstallments(100, -1)).toThrow();
  });
});

describe('parseDateParts', () => {
  it('string YYYY-MM-DD', () => {
    expect(svc.parseDateParts('2026-07-15')).toEqual({ year: 2026, month: 7, day: 15, iso: '2026-07-15' });
  });
  it('objeto Date (como o pg devolve pra coluna `date`) — usa componentes UTC, não reinterpreta fuso', () => {
    const d = new Date('2026-07-01T00:00:00.000Z');
    expect(svc.parseDateParts(d)).toEqual({ year: 2026, month: 7, day: 1, iso: '2026-07-01' });
  });
  it('null/undefined/vazio -> null', () => {
    expect(svc.parseDateParts(null)).toBeNull();
    expect(svc.parseDateParts(undefined)).toBeNull();
    expect(svc.parseDateParts('')).toBeNull();
  });
});

describe('buildProportionalPlanSpecs', () => {
  it('trimestral, filiação em janeiro -> valor cheio, 4 parcelas iguais (sem corte)', () => {
    const r = svc.buildProportionalPlanSpecs({
      plan: 'trimestral', feeAmount: 150, dueMonths: [2, 5, 8, 11], seasonYear: 2026, affiliationMonth: 1,
    });
    expect(r.fullTotal).toBe(600);
    expect(r.proportionalTotal).toBe(600);
    expect(r.remainingMonths).toBe(12);
    expect(r.dueDateAdjusted).toBe(false);
    expect(r.specs).toEqual([
      { seq: 1, amount: 150, due_date: '2026-02-28' },
      { seq: 2, amount: 150, due_date: '2026-05-31' },
      { seq: 3, amount: 150, due_date: '2026-08-31' },
      { seq: 4, amount: 150, due_date: '2026-11-30' },
    ]);
  });

  it('trimestral, filiação em julho -> parcelas de Fev/Mai PULADAS; total proporcional (300) dividido só entre Ago/Nov', () => {
    const r = svc.buildProportionalPlanSpecs({
      plan: 'trimestral', feeAmount: 150, dueMonths: [2, 5, 8, 11], seasonYear: 2026, affiliationMonth: 7,
    });
    expect(r.fullTotal).toBe(600);
    expect(r.remainingMonths).toBe(6);
    expect(r.proportionalTotal).toBe(300);
    expect(r.specs).toEqual([
      { seq: 3, amount: 150, due_date: '2026-08-31' },
      { seq: 4, amount: 150, due_date: '2026-11-30' },
    ]);
    // Nada se perde: soma das parcelas geradas === total proporcional.
    const sum = r.specs.reduce((s, x) => s + x.amount, 0);
    expect(sum).toBe(r.proportionalTotal);
  });

  it('semestral, filiação em setembro -> só Nov sobrevive; recebe o proporcional inteiro (Mai já tinha passado)', () => {
    const r = svc.buildProportionalPlanSpecs({
      plan: 'semestral', feeAmount: 280, dueMonths: [5, 11], seasonYear: 2026, affiliationMonth: 9,
    });
    expect(r.fullTotal).toBe(560);
    expect(r.remainingMonths).toBe(4); // 13 - 9
    expect(r.proportionalTotal).toBe(186.67); // 560 * 4/12 = 186.666... -> 186.67
    expect(r.specs).toEqual([{ seq: 2, amount: 186.67, due_date: '2026-11-30' }]);
    expect(r.dueDateAdjusted).toBe(false);
  });

  it('trimestral, filiação em dezembro -> TODAS as parcelas do plano já passaram: default seguro (1 parcela, due=fim de dez, valor = 1/12 do anual)', () => {
    const r = svc.buildProportionalPlanSpecs({
      plan: 'trimestral', feeAmount: 150, dueMonths: [2, 5, 8, 11], seasonYear: 2026, affiliationMonth: 12,
    });
    expect(r.remainingMonths).toBe(1);
    expect(r.proportionalTotal).toBe(50); // 600/12
    expect(r.dueDateAdjusted).toBe(true);
    expect(r.specs).toEqual([{ seq: 4, amount: 50, due_date: '2026-12-31' }]);
  });

  it('dueDateOverride substitui o vencimento da PRIMEIRA parcela gerada, mesma semântica de buildPlanSpecs', () => {
    const r = svc.buildProportionalPlanSpecs({
      plan: 'trimestral', feeAmount: 150, dueMonths: [2, 5, 8, 11], seasonYear: 2026, affiliationMonth: 7,
      dueDateOverride: '2026-09-15',
    });
    expect(r.specs[0]).toEqual({ seq: 3, amount: 150, due_date: '2026-09-15' });
    expect(r.specs[1].due_date).toBe('2026-11-30'); // demais mantêm o mês do plano
    expect(r.dueDateAdjusted).toBe(true);
  });
});

describe('buildAdhesionSpec (F2 — taxa de adesão, ADESAO_FEE_BRL=195)', () => {
  it('chargesAdhesion=false -> não semeia (null)', () => {
    expect(svc.buildAdhesionSpec({
      chargesAdhesion: false, alreadyHasAdhesionInstallment: false, affiliationSince: '2026-07-01',
    })).toBeNull();
  });

  it('chargesAdhesion=true mas já existe parcela de adesão -> não duplica (null) — guarda de unicidade (reativação)', () => {
    expect(svc.buildAdhesionSpec({
      chargesAdhesion: true, alreadyHasAdhesionInstallment: true, affiliationSince: '2026-07-01',
    })).toBeNull();
  });

  it('chargesAdhesion=true, sem parcela existente -> semeia seq:0, kind:filiacao, R$195, due_date = data de filiação', () => {
    expect(svc.buildAdhesionSpec({
      chargesAdhesion: true, alreadyHasAdhesionInstallment: false, affiliationSince: '2026-07-01',
    })).toEqual({ seq: 0, amount: 195, due_date: '2026-07-01', kind: 'filiacao' });
  });

  it('sem affiliationSince -> usa fallbackDueDate (data do lançamento)', () => {
    expect(svc.buildAdhesionSpec({
      chargesAdhesion: true, alreadyHasAdhesionInstallment: false, affiliationSince: null, fallbackDueDate: '2026-08-20',
    })).toEqual({ seq: 0, amount: 195, due_date: '2026-08-20', kind: 'filiacao' });
  });

  it('ADESAO_FEE_BRL é a constante nomeada (195) — não número solto', () => {
    expect(svc.ADESAO_FEE_BRL).toBe(195);
  });
});

describe('createInstallmentsForAnnuity — grava `kind` por parcela (mock de client, sem DB)', () => {
  function makeMockClient() {
    const inserted = [];
    const query = jest.fn((sql, params) => {
      inserted.push({ sql: String(sql), params });
      return Promise.resolve({
        rows: [{ id: `inst-${inserted.length}`, seq: params[2], amount: params[3], due_date: params[4], kind: params[5] }],
      });
    });
    return { client: { query }, inserted };
  }

  it('spec sem `kind` grava default \'anuidade\'', async () => {
    const { client, inserted } = makeMockClient();
    await svc.createInstallmentsForAnnuity(client, {
      annuityId: 'ann-1', federationId: 'fed-1',
      specs: [{ seq: 1, amount: 150, due_date: '2026-02-28' }],
    });
    expect(inserted[0].params[5]).toBe('anuidade');
    expect(inserted[0].sql).toMatch(/kind/);
  });

  it('spec de adesão (kind:\'filiacao\') grava \'filiacao\', não o default', async () => {
    const { client, inserted } = makeMockClient();
    const adhesionSpec = svc.buildAdhesionSpec({
      chargesAdhesion: true, alreadyHasAdhesionInstallment: false, affiliationSince: '2026-07-01',
    });
    await svc.createInstallmentsForAnnuity(client, {
      annuityId: 'ann-1', federationId: 'fed-1', specs: [adhesionSpec],
    });
    expect(inserted[0].params[5]).toBe('filiacao');
    expect(inserted[0].params[3]).toBe(195);
  });
});
