// ============================================================
// AURA KARATÊ — Fase F1 (parcelas): testes PUROS do
// karateAnnuityService (sem DB) — datas de vencimento, montagem do plano de
// parcelas (corte de "meio do ano"), status derivado por parcela e agregado.
// ============================================================
'use strict';

const svc = require('../src/services/karateAnnuityService');

describe('lastDayOfMonthStr', () => {
  it('último dia de maio (31) em ano comum', () => {
    expect(svc.lastDayOfMonthStr(2026, 5)).toBe('2026-05-31');
  });
  it('último dia de fevereiro em ano bissexto (29)', () => {
    expect(svc.lastDayOfMonthStr(2028, 2)).toBe('2028-02-29');
  });
  it('último dia de fevereiro em ano não-bissexto (28)', () => {
    expect(svc.lastDayOfMonthStr(2026, 2)).toBe('2026-02-28');
  });
  it('último dia de novembro (30)', () => {
    expect(svc.lastDayOfMonthStr(2026, 11)).toBe('2026-11-30');
  });
});

describe('buildInstallmentPlan', () => {
  it('anual: 1 parcela em Mai', () => {
    const specs = svc.buildInstallmentPlan({ plan: 'anual', amount: 500, dueMonths: [5], seasonYear: 2026 });
    expect(specs).toEqual([{ seq: 1, amount: 500, due_date: '2026-05-31' }]);
  });

  it('semestral: 2 parcelas (Mai, Nov) com o valor por parcela vindo da fee', () => {
    const specs = svc.buildInstallmentPlan({ plan: 'semestral', amount: 280, dueMonths: [5, 11], seasonYear: 2026 });
    expect(specs).toEqual([
      { seq: 1, amount: 280, due_date: '2026-05-31' },
      { seq: 2, amount: 280, due_date: '2026-11-30' },
    ]);
  });

  it('trimestral: 4 parcelas (Fev, Mai, Ago, Nov)', () => {
    const specs = svc.buildInstallmentPlan({ plan: 'trimestral', amount: 150, dueMonths: [2, 5, 8, 11], seasonYear: 2026 });
    expect(specs.map((s) => s.due_date)).toEqual(['2026-02-28', '2026-05-31', '2026-08-31', '2026-11-30']);
    expect(specs.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
  });

  it('novo filiado no meio do ano: gera só as parcelas restantes, preservando o seq original', () => {
    // "Hoje" = 01/jun/2026 — Fev e Mai do trimestral já venceram.
    const fromDate = new Date('2026-06-01T00:00:00-03:00');
    const specs = svc.buildInstallmentPlan({
      plan: 'trimestral', amount: 150, dueMonths: [2, 5, 8, 11], seasonYear: 2026, fromDate,
    });
    expect(specs).toEqual([
      { seq: 3, amount: 150, due_date: '2026-08-31' },
      { seq: 4, amount: 150, due_date: '2026-11-30' },
    ]);
  });

  it('fallback DEFAULT_DUE_MONTHS quando a fee não tem due_months configurado', () => {
    const specs = svc.buildInstallmentPlan({ plan: 'semestral', amount: 280, dueMonths: null, seasonYear: 2026 });
    expect(specs.map((s) => s.due_date)).toEqual(['2026-05-31', '2026-11-30']);
  });
});

describe('deriveInstallmentStatus (por parcela, leitura)', () => {
  it('paga → paid, independente do due_date', () => {
    expect(svc.deriveInstallmentStatus({ status: 'paid', due_date: '2000-01-01' })).toBe('paid');
  });
  it('não paga, vence no futuro → due', () => {
    const future = new Date(); future.setDate(future.getDate() + 30);
    expect(svc.deriveInstallmentStatus({ status: 'pending', due_date: future.toISOString().slice(0, 10) })).toBe('due');
  });
  it('não paga, vencida há 45 dias → overdue', () => {
    const past = new Date(); past.setDate(past.getDate() - 45);
    expect(svc.deriveInstallmentStatus({ status: 'pending', due_date: past.toISOString().slice(0, 10) })).toBe('overdue');
  });
  it('não paga, vencida há 120 dias → defaulting', () => {
    const past = new Date(); past.setDate(past.getDate() - 120);
    expect(svc.deriveInstallmentStatus({ status: 'pending', due_date: past.toISOString().slice(0, 10) })).toBe('defaulting');
  });
  it('não paga, vencida há 200 dias → suspended (rótulo, não persiste is_active)', () => {
    const past = new Date(); past.setDate(past.getDate() - 200);
    expect(svc.deriveInstallmentStatus({ status: 'pending', due_date: past.toISOString().slice(0, 10) })).toBe('suspended');
  });
});

describe('computeAggregateFinanceiro (agregado da anuidade, views/KPIs)', () => {
  it('sem parcelas → sem_cobranca (neutro)', () => {
    expect(svc.computeAggregateFinanceiro([])).toBe('sem_cobranca');
    expect(svc.computeAggregateFinanceiro(null)).toBe('sem_cobranca');
  });
  it('todas pagas → paid', () => {
    expect(svc.computeAggregateFinanceiro([
      { status: 'paid', due_date: '2020-01-01' },
      { status: 'paid', due_date: '2020-06-01' },
    ])).toBe('paid');
  });
  it('parcela futura em aberto NÃO torna ninguém atrasado → em_dia', () => {
    const future = new Date(); future.setDate(future.getDate() + 60);
    expect(svc.computeAggregateFinanceiro([
      { status: 'pending', due_date: future.toISOString().slice(0, 10) },
    ])).toBe('em_dia');
  });
  it('>=1 parcela vencida não paga → atrasado', () => {
    const past = new Date(); past.setDate(past.getDate() - 10);
    const future = new Date(); future.setDate(future.getDate() + 60);
    expect(svc.computeAggregateFinanceiro([
      { status: 'paid', due_date: past.toISOString().slice(0, 10) },
      { status: 'pending', due_date: past.toISOString().slice(0, 10) },
      { status: 'pending', due_date: future.toISOString().slice(0, 10) },
    ])).toBe('atrasado');
  });
});

describe('computeAnnuityListStatus (vocabulário legado das listagens /dojos, /cpf)', () => {
  it('sem parcelas → no_charge', () => {
    expect(svc.computeAnnuityListStatus([])).toBe('no_charge');
  });
  it('todas pagas → paid', () => {
    expect(svc.computeAnnuityListStatus([{ status: 'paid', due_date: '2020-01-01' }])).toBe('paid');
  });
  it('pega o pior estágio entre as parcelas em aberto', () => {
    const d90 = new Date(); d90.setDate(d90.getDate() - 200); // suspended
    const d10 = new Date(); d10.setDate(d10.getDate() - 10); // overdue
    expect(svc.computeAnnuityListStatus([
      { status: 'pending', due_date: d90.toISOString().slice(0, 10) },
      { status: 'pending', due_date: d10.toISOString().slice(0, 10) },
    ])).toBe('suspended');
  });
});

describe('computeTotals', () => {
  it('soma total e paid_total corretamente', () => {
    const totals = svc.computeTotals([
      { amount: '150.00', status: 'paid' },
      { amount: '150.00', status: 'pending' },
      { amount: '150.00', status: 'pending' },
    ]);
    expect(totals.total).toBe(450);
    expect(totals.paid_total).toBe(150);
  });
});

describe('transactionIdempotencyKey / categoryForKind', () => {
  it('gera a chave annuity-{id}-p{seq}', () => {
    expect(svc.transactionIdempotencyKey('abc-123', 2)).toBe('annuity-abc-123-p2');
  });
  it('mapeia kind para category', () => {
    expect(svc.categoryForKind('dojo')).toBe('annuity_dojo');
    expect(svc.categoryForKind('cpf')).toBe('annuity_cpf');
  });
});
