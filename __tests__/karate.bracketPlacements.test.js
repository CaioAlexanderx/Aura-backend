// ============================================================
// AURA KARATÊ — P2 (modo mesário): computePlacements
// O pódio derivado da chave (mata o correio de papel do dia de evento).
// Regra real (Paulista/FPKT 2026): com disputa de 3º → 1º/2º/3º/4º;
// sem disputa → DOIS 3ºs (perdedores das semifinais). Byes nunca pódio.
// ============================================================
'use strict';

const { computePlacements } = require('../src/services/karateBracket');

// Helper: monta um match {akaId, shiroId, winnerId}.
const m = (aka, shiro, winner = null) => ({ akaId: aka, shiroId: shiro, winnerId: winner });

describe('computePlacements — pódio derivado da chave', () => {
  test('SEM disputa de 3º: campeão, vice e DOIS terceiros (perdedores das semis)', () => {
    const state = {
      rounds: [
        [m('a', 'b', 'a'), m('c', 'd', 'd'), m('e', 'f', 'e'), m('g', 'h', 'h')], // quartas
        [m('a', 'd', 'a'), m('e', 'h', 'h')],                                     // semis
        [m('a', 'h', 'h')],                                                       // final
      ],
      thirdPlaceMatch: null,
    };
    const r = computePlacements(state);
    expect(r.complete).toBe(true);
    expect(r.placements).toEqual([
      { entryId: 'h', placement: 1 },
      { entryId: 'a', placement: 2 },
      { entryId: 'd', placement: 3 }, // perdeu a semi 1
      { entryId: 'e', placement: 3 }, // perdeu a semi 2
    ]);
  });

  test('COM disputa de 3º decidida: 1º/2º/3º/4º', () => {
    const state = {
      rounds: [
        [m('a', 'd', 'a'), m('e', 'h', 'h')],
        [m('a', 'h', 'h')],
      ],
      thirdPlaceMatch: m('d', 'e', 'e'),
    };
    const r = computePlacements(state);
    expect(r.complete).toBe(true);
    expect(r.placements).toEqual([
      { entryId: 'h', placement: 1 },
      { entryId: 'a', placement: 2 },
      { entryId: 'e', placement: 3 },
      { entryId: 'd', placement: 4 },
    ]);
  });

  test('final pendente → incomplete FINAL_PENDENTE', () => {
    const state = { rounds: [[m('a', 'b', 'a'), m('c', 'd', 'd')], [m('a', 'd', null)]], thirdPlaceMatch: null };
    const r = computePlacements(state);
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('FINAL_PENDENTE');
  });

  test('disputa de 3º habilitada e com atletas mas SEM vencedor → TERCEIRO_PENDENTE', () => {
    const state = {
      rounds: [[m('a', 'd', 'a'), m('e', 'h', 'h')], [m('a', 'h', 'h')]],
      thirdPlaceMatch: m('d', 'e', null),
    };
    const r = computePlacements(state);
    expect(r.complete).toBe(false);
    expect(r.reason).toBe('TERCEIRO_PENDENTE');
  });

  test('bye nunca sobe ao pódio (final contra bye; semi com bye não gera 3º)', () => {
    const state = {
      rounds: [
        [m('a', 'bye', 'a'), m('c', 'd', 'd')], // semi: a passou por bye
        [m('a', 'd', 'a')],
      ],
      thirdPlaceMatch: null,
    };
    const r = computePlacements(state);
    expect(r.complete).toBe(true);
    // 1º a, 2º d, e só UM 3º (c) — o bye da outra semi não vira medalha.
    expect(r.placements).toEqual([
      { entryId: 'a', placement: 1 },
      { entryId: 'd', placement: 2 },
      { entryId: 'c', placement: 3 },
    ]);
  });

  test('chave de 2 atletas (só a final): 1º e 2º, sem terceiros', () => {
    const state = { rounds: [[m('a', 'b', 'b')]], thirdPlaceMatch: null };
    const r = computePlacements(state);
    expect(r.complete).toBe(true);
    expect(r.placements).toEqual([
      { entryId: 'b', placement: 1 },
      { entryId: 'a', placement: 2 },
    ]);
  });

  test('chave vazia → CHAVE_VAZIA', () => {
    expect(computePlacements({ rounds: [], thirdPlaceMatch: null }).reason).toBe('CHAVE_VAZIA');
  });
});
