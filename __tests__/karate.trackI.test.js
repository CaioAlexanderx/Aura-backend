// ============================================================
// AURA KARATÊ — Track I (régua de anuidade)
// Testa o motor PURO computeReminder (sem DB): decide o lembrete do dia a
// partir do vencimento + offsets + já-enviados.
// ============================================================
'use strict';

const { computeReminder, ruleCode, daysDiff } = require('../src/services/karateReminderEngine');

describe('ruleCode / daysDiff', () => {
  it('mapeia offset para código', () => {
    expect(ruleCode(-7)).toBe('due_minus_7');
    expect(ruleCode(-1)).toBe('due_minus_1');
    expect(ruleCode(3)).toBe('overdue_3');
    expect(ruleCode(0)).toBe('due_day');
  });
  it('conta dias inteiros estável a timezone', () => {
    expect(daysDiff(new Date('2026-06-01'), new Date('2026-06-09'))).toBe(8);
    expect(daysDiff(new Date('2026-06-09'), new Date('2026-06-01'))).toBe(-8);
  });
});

describe('computeReminder — antes do vencimento', () => {
  it('null quando nenhum gatilho chegou (vence em 10d, 1º offset -7)', () => {
    expect(computeReminder({ dueDate: '2026-06-19', today: '2026-06-09' })).toBeNull();
  });
  it('due_minus_7 exatamente a 7 dias', () => {
    expect(computeReminder({ dueDate: '2026-06-16', today: '2026-06-09' })).toEqual({ code: 'due_minus_7', offset: -7 });
  });
  it('mantém due_minus_7 entre -7 e -1', () => {
    expect(computeReminder({ dueDate: '2026-06-14', today: '2026-06-09' })).toEqual({ code: 'due_minus_7', offset: -7 });
  });
  it('due_minus_1 véspera', () => {
    expect(computeReminder({ dueDate: '2026-06-10', today: '2026-06-09' })).toEqual({ code: 'due_minus_1', offset: -1 });
  });
});

describe('computeReminder — vencido', () => {
  it('overdue_3 após 3 dias', () => {
    expect(computeReminder({ dueDate: '2026-06-06', today: '2026-06-09' })).toEqual({ code: 'overdue_3', offset: 3 });
  });
  it('catch-up pega o estágio atual, não backfill (20d → overdue_15)', () => {
    expect(computeReminder({ dueDate: '2026-05-20', today: '2026-06-09', sentCodes: [] })).toEqual({ code: 'overdue_15', offset: 15 });
  });
  it('overdue_30 quando 40d e nada enviado', () => {
    expect(computeReminder({ dueDate: '2026-04-30', today: '2026-06-09', sentCodes: [] })).toEqual({ code: 'overdue_30', offset: 30 });
  });
});

describe('computeReminder — não reenvia / pago / inválido', () => {
  it('null se o estágio atual já foi enviado', () => {
    expect(computeReminder({ dueDate: '2026-06-06', today: '2026-06-09', sentCodes: ['overdue_3'] })).toBeNull();
  });
  it('null no fim da régua com tudo enviado (40d, overdue_30 enviado)', () => {
    expect(computeReminder({ dueDate: '2026-04-30', today: '2026-06-09', sentCodes: ['overdue_30'] })).toBeNull();
  });
  it('null quando pago (status)', () => {
    expect(computeReminder({ dueDate: '2026-06-06', today: '2026-06-09', status: 'paid' })).toBeNull();
  });
  it('null quando pago (paidAt)', () => {
    expect(computeReminder({ dueDate: '2026-06-06', today: '2026-06-09', paidAt: '2026-06-07' })).toBeNull();
  });
  it('null sem due_date', () => {
    expect(computeReminder({ dueDate: null, today: '2026-06-09' })).toBeNull();
  });
  it('respeita offsets custom', () => {
    expect(computeReminder({ dueDate: '2026-06-12', today: '2026-06-09', offsets: [-3] })).toEqual({ code: 'due_minus_3', offset: -3 });
  });
});