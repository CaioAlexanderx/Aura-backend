// ============================================================
// AURA KARATÊ — Testes do motor de sync LIGHT (Track F)
// Foco nas funções PURAS (sem DB): isStale + applyEvent (ack).
// ============================================================
'use strict';

jest.mock('../src/config/database'); // engine importa db; aqui só testamos puro
const engine = require('../src/services/karateSyncEngine');

describe('isStale — dojô quieto vira "caiu"', () => {
  const now = '2026-06-09T12:00:00Z';

  it('false quando nunca sincronizou (recém-ligada, não é queda)', () => {
    expect(engine.isStale(null, 24, now)).toBe(false);
  });
  it('false quando dentro da janela (há 3h, limite 24h)', () => {
    expect(engine.isStale('2026-06-09T09:00:00Z', 24, now)).toBe(false);
  });
  it('true quando passou da janela (há ~2 dias, limite 24h)', () => {
    expect(engine.isStale('2026-06-07T10:00:00Z', 24, now)).toBe(true);
  });
  it('respeita o limite configurável (há 5h, limite 4h → true)', () => {
    expect(engine.isStale('2026-06-09T07:00:00Z', 4, now)).toBe(true);
  });
  it('false para data inválida', () => {
    expect(engine.isStale('nope', 24, now)).toBe(false);
  });
});

describe('applyEvent — LIGHT reconhece (ack) e drena', () => {
  it('reconhece qualquer tipo conhecido sem tocar o banco', async () => {
    const out = await engine.applyEvent(null, { event_type: 'attendance' });
    expect(out.ok).toBe(true);
    expect(out.ack).toBe(true);
  });
  it('reconhece practitioner_added (aplicação real é plug futuro)', async () => {
    const out = await engine.applyEvent(null, { event_type: 'practitioner_added' });
    expect(out.ok).toBe(true);
  });
});

describe('constantes do motor', () => {
  it('tem janela de staleness e teto de tentativas', () => {
    expect(typeof engine.STALE_HOURS).toBe('number');
    expect(engine.MAX_ATTEMPTS).toBeGreaterThan(1);
  });
});
