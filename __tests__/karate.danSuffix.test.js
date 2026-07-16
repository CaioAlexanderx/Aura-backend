// ============================================================
// AURA KARATÊ — Sufixo Dan da matrícula (função pura)
// Testa computeDanRegistrationChange: Shodan avisa, 2º–6º troca sufixo,
// 7º+/formato inesperado revisa, kyu não age.
// ============================================================
'use strict';

const { computeDanRegistrationChange } = require('../src/services/karateExamService');

describe('computeDanRegistrationChange', () => {
  test('graduação de kyu (não-preta) → none', () => {
    expect(computeDanRegistrationChange('12345-D', 'Marrom', 'marrom').action).toBe('none');
  });

  test('Shodan (Preta 1°) → notify_create, sem alterar', () => {
    const r = computeDanRegistrationChange('12345-D', 'Preta 1°', 'preta');
    expect(r.action).toBe('notify_create');
    expect(r.dan).toBe(1);
    expect(r.newNumber).toBeUndefined();
  });

  test('Preta 2° a partir de 010-Y-SHO → update 010-Y-NI', () => {
    const r = computeDanRegistrationChange('010-Y-SHO', 'Preta 2°', 'preta');
    expect(r.action).toBe('update');
    expect(r.from).toBe('010-Y-SHO');
    expect(r.newNumber).toBe('010-Y-NI');
    expect(r.dan).toBe(2);
  });

  test('Preta 3° preserva o prefixo (041-Y-NI → 041-Y-SAN)', () => {
    expect(computeDanRegistrationChange('041-Y-NI', 'Preta 3°', 'preta').newNumber).toBe('041-Y-SAN');
  });

  test('Preta 6° → ROKU', () => {
    expect(computeDanRegistrationChange('132-Y-GO', 'Preta 6°', 'preta').newNumber).toBe('132-Y-ROKU');
  });

  test('preserva o prefixo verbatim; só normaliza o sufixo p/ canônico', () => {
    // prefixo mantido como está (identidade); sufixo vira token canônico maiúsculo
    expect(computeDanRegistrationChange('010-y-sho', 'Preta 2°', 'preta').newNumber).toBe('010-y-NI');
  });

  test('Preta 5° mas matrícula em formato kyu → review (não altera)', () => {
    const r = computeDanRegistrationChange('12345-D', 'Preta 5°', 'preta');
    expect(r.action).toBe('review');
    expect(r.newNumber).toBeUndefined();
  });

  test('Preta 7° → review (token ambíguo)', () => {
    expect(computeDanRegistrationChange('001-Y-ROKU', 'Preta 7°', 'preta').action).toBe('review');
  });

  test('idempotente: já está no sufixo alvo → none', () => {
    expect(computeDanRegistrationChange('010-Y-NI', 'Preta 2°', 'preta').action).toBe('none');
  });

  test('matrícula ausente + Dan 2º → review', () => {
    expect(computeDanRegistrationChange(null, 'Preta 2°', 'preta').action).toBe('review');
  });
});
