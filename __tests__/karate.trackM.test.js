// ============================================================
// Track M — Tests for karateBracket.js (pure service, no DB)
// Run with: npx jest __tests__/karate.trackM.test.js
// ============================================================
'use strict';

const {
  seededRng,
  generateKumiteBracket,
  advanceWinner,
  generateKataOrder,
  getChampion,
  stateToMatchRows,
  rowsToState,
} = require('../src/services/karateBracket');

// ── Helpers ─────────────────────────────────────────────────────
function mkAthletes(n, dojoFn) {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i + 1}`,
    student_name: `Atleta ${i + 1}`,
    dojo_id: dojoFn ? dojoFn(i) : `dojo${i + 1}`,
    dojo: `Dojô ${dojoFn ? dojoFn(i) : i + 1}`,
  }));
}

function countByes(state) {
  return state.rounds[0].filter(m => m.isBye || m.akaId === 'bye' || m.shiroId === 'bye').length;
}

function advanceAll(state) {
  // Simulate advancing winner = aka for every match from round 0 up
  let s = state;
  for (let r = 0; r < s.rounds.length; r++) {
    for (let p = 0; p < s.rounds[r].length; p++) {
      const m = s.rounds[r][p];
      if (m.winnerId !== null) continue; // already decided
      if (!m.akaId || !m.shiroId) continue; // waiting for previous round
      if (m.akaId === 'bye' || m.shiroId === 'bye') continue; // auto-advanced
      const winner = m.akaId !== null ? m.akaId : m.shiroId;
      s = advanceWinner(s, m.id, winner);
    }
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────
// 1. Seeded RNG — determinism
// ─────────────────────────────────────────────────────────────────
describe('seededRng', () => {
  test('same seed produces same sequence', () => {
    const rng1 = seededRng('abc');
    const rng2 = seededRng('abc');
    for (let i = 0; i < 20; i++) {
      expect(rng1()).toBeCloseTo(rng2(), 15);
    }
  });

  test('different seeds produce different sequences', () => {
    const rng1 = seededRng('abc');
    const rng2 = seededRng('xyz');
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    expect(seq1).not.toEqual(seq2);
  });

  test('values in [0, 1)', () => {
    const rng = seededRng(42);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. Bye counts
// ─────────────────────────────────────────────────────────────────
describe('generateKumiteBracket — bye counts', () => {
  test('2 athletes → 0 byes (exact power of 2)', () => {
    const athletes = mkAthletes(2);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    expect(state.byeCount).toBe(0);
    expect(state.rounds[0]).toHaveLength(1);
  });

  test('3 athletes → 1 bye (rounds up to 4 slots)', () => {
    const athletes = mkAthletes(3);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    expect(state.byeCount).toBe(1);
    expect(state.rounds[0]).toHaveLength(2);
  });

  test('4 athletes → 0 byes', () => {
    const athletes = mkAthletes(4);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    expect(state.byeCount).toBe(0);
    expect(state.rounds[0]).toHaveLength(2);
  });

  test('7 athletes → 1 bye (rounds up to 8 slots)', () => {
    const athletes = mkAthletes(7);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    expect(state.byeCount).toBe(1);
    expect(state.rounds[0]).toHaveLength(4);
  });

  test('8 athletes → 0 byes', () => {
    const athletes = mkAthletes(8);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    expect(state.byeCount).toBe(0);
    expect(state.rounds[0]).toHaveLength(4);
  });

  test('16 athletes → 0 byes', () => {
    const athletes = mkAthletes(16);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    expect(state.byeCount).toBe(0);
    expect(state.rounds[0]).toHaveLength(8);
  });

  test('5 athletes → 3 byes (rounds up to 8)', () => {
    const athletes = mkAthletes(5);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    expect(state.byeCount).toBe(3);
  });

  test('6 athletes → 2 byes', () => {
    const athletes = mkAthletes(6);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    expect(state.byeCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. Bracket structure
// ─────────────────────────────────────────────────────────────────
describe('generateKumiteBracket — structure', () => {
  test('8 athletes → 3 rounds (R1→QF→SF→Final is 4, but 8-slot = 3 rounds after R1)', () => {
    const athletes = mkAthletes(8);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    // 8 slots → round 0 has 4 matches, round 1 has 2, round 2 has 1 (final)
    expect(state.rounds).toHaveLength(3);
    expect(state.rounds[0]).toHaveLength(4);
    expect(state.rounds[1]).toHaveLength(2);
    expect(state.rounds[2]).toHaveLength(1);
  });

  test('16 athletes → 4 rounds', () => {
    const athletes = mkAthletes(16);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    expect(state.rounds).toHaveLength(4);
    expect(state.rounds[0]).toHaveLength(8);
  });

  test('all slots in round 0 contain valid athlete ids or bye', () => {
    const athletes = mkAthletes(7);
    const validIds = new Set(athletes.map(a => a.id));
    validIds.add('bye');
    const state = generateKumiteBracket(athletes, { seed: 'test' });
    for (const m of state.rounds[0]) {
      if (m.akaId) expect(validIds.has(m.akaId)).toBe(true);
      if (m.shiroId) expect(validIds.has(m.shiroId)).toBe(true);
    }
  });

  test('each athlete appears exactly once in round 0', () => {
    const athletes = mkAthletes(8);
    const seen = new Set();
    const state = generateKumiteBracket(athletes, { seed: '1' });
    for (const m of state.rounds[0]) {
      if (m.akaId && m.akaId !== 'bye') {
        expect(seen.has(m.akaId)).toBe(false);
        seen.add(m.akaId);
      }
      if (m.shiroId && m.shiroId !== 'bye') {
        expect(seen.has(m.shiroId)).toBe(false);
        seen.add(m.shiroId);
      }
    }
    expect(seen.size).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. Separate same dojo
// ─────────────────────────────────────────────────────────────────
describe('generateKumiteBracket — separateSameDojo', () => {
  test('with 8 athletes all in different dojos → no clashes anyway', () => {
    const athletes = mkAthletes(8, i => `dojo${i}`);
    const state = generateKumiteBracket(athletes, { separateSameDojo: true, seed: 'sep1' });
    const clashes = state.rounds[0].filter(m =>
      m.akaId && m.shiroId && m.akaId !== 'bye' && m.shiroId !== 'bye' &&
      athletes.find(a => a.id === m.akaId)?.dojo_id ===
      athletes.find(a => a.id === m.shiroId)?.dojo_id
    );
    expect(clashes).toHaveLength(0);
  });

  test('with 8 athletes in 2 dojos (4 each) → ideally 0 clashes in round 1', () => {
    // 4 from dojoA, 4 from dojoB → always separable
    const athletes = mkAthletes(8, i => i < 4 ? 'dojoA' : 'dojoB');
    const state = generateKumiteBracket(athletes, { separateSameDojo: true, seed: 'sep2' });
    const clashes = state.rounds[0].filter(m =>
      m.akaId && m.shiroId && m.akaId !== 'bye' && m.shiroId !== 'bye' &&
      athletes.find(a => a.id === m.akaId)?.dojo_id ===
      athletes.find(a => a.id === m.shiroId)?.dojo_id
    );
    expect(clashes).toHaveLength(0);
  });

  test('without separateSameDojo=true the flag is honored as false', () => {
    const athletes = mkAthletes(4, () => 'sameDojoForAll');
    // All same dojo → 2 matches both clash; not separated
    const state = generateKumiteBracket(athletes, { separateSameDojo: false, seed: '1' });
    // This should not throw and return a valid state
    expect(state.rounds[0]).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. Third place
// ─────────────────────────────────────────────────────────────────
describe('generateKumiteBracket — thirdPlace', () => {
  test('thirdPlace=true → thirdPlaceMatch is not null', () => {
    const athletes = mkAthletes(4);
    const state = generateKumiteBracket(athletes, { thirdPlace: true, seed: '1' });
    expect(state.thirdPlaceMatch).not.toBeNull();
    expect(state.thirdPlaceMatch.id).toBe('third');
  });

  test('thirdPlace=false → thirdPlaceMatch is null', () => {
    const athletes = mkAthletes(4);
    const state = generateKumiteBracket(athletes, { thirdPlace: false, seed: '1' });
    expect(state.thirdPlaceMatch).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. advanceWinner — propagation
// ─────────────────────────────────────────────────────────────────
describe('advanceWinner', () => {
  test('advancing winner propagates to next round as akaId or shiroId', () => {
    const athletes = mkAthletes(4);
    let state = generateKumiteBracket(athletes, { seed: '42' });
    const r0m0 = state.rounds[0][0];
    const winnerId = r0m0.akaId || r0m0.shiroId;
    state = advanceWinner(state, r0m0.id, winnerId);
    // Winner should appear in round 1
    const r1 = state.rounds[1][0];
    expect(r1.akaId === winnerId || r1.shiroId === winnerId).toBe(true);
  });

  test('throws if winner not in match', () => {
    const athletes = mkAthletes(4);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    const m = state.rounds[0][0];
    expect(() => advanceWinner(state, m.id, 'a99')).toThrow();
  });

  test('throws for invalid matchId', () => {
    const athletes = mkAthletes(4);
    const state = generateKumiteBracket(athletes, { seed: '1' });
    expect(() => advanceWinner(state, 'r99-0', athletes[0].id)).toThrow();
  });

  test('full advancement 4 athletes produces a champion', () => {
    const athletes = mkAthletes(4);
    let state = generateKumiteBracket(athletes, { seed: 'full4' });
    state = advanceAll(state);
    const champ = getChampion(state);
    expect(champ).not.toBeNull();
    expect(athletes.map(a => a.id)).toContain(champ);
  });

  test('full advancement 8 athletes produces a champion', () => {
    const athletes = mkAthletes(8);
    let state = generateKumiteBracket(athletes, { seed: 'full8' });
    state = advanceAll(state);
    const champ = getChampion(state);
    expect(champ).not.toBeNull();
  });

  test('full advancement 16 athletes produces a champion', () => {
    const athletes = mkAthletes(16);
    let state = generateKumiteBracket(athletes, { seed: 'full16' });
    state = advanceAll(state);
    const champ = getChampion(state);
    expect(champ).not.toBeNull();
  });

  test('3rd place match fed by semi-final losers', () => {
    const athletes = mkAthletes(4);
    let state = generateKumiteBracket(athletes, { thirdPlace: true, seed: 'third1' });
    // Advance through semi-finals (round 0 for 4 athletes = semi-finals)
    const sf0 = state.rounds[0][0];
    const sf1 = state.rounds[0][1];
    const w0 = sf0.akaId;
    const w1 = sf1.akaId;
    state = advanceWinner(state, sf0.id, w0);
    state = advanceWinner(state, sf1.id, w1);
    // Third place match should have the losers
    expect(state.thirdPlaceMatch.akaId).toBe(sf0.shiroId);
    expect(state.thirdPlaceMatch.shiroId).toBe(sf1.shiroId);
  });

  test('advancing 3rd place match', () => {
    const athletes = mkAthletes(4);
    let state = generateKumiteBracket(athletes, { thirdPlace: true, seed: 'third2' });
    const sf0 = state.rounds[0][0];
    const sf1 = state.rounds[0][1];
    state = advanceWinner(state, sf0.id, sf0.akaId);
    state = advanceWinner(state, sf1.id, sf1.akaId);
    state = advanceWinner(state, 'third', sf0.shiroId);
    expect(state.thirdPlaceMatch.winnerId).toBe(sf0.shiroId);
  });
});

// ─────────────────────────────────────────────────────────────────
// 7. Determinism — re-draw with same seed produces same bracket
// ─────────────────────────────────────────────────────────────────
describe('determinism (re-draw)', () => {
  test('same seed → identical bracket', () => {
    const athletes = mkAthletes(8);
    const s1 = generateKumiteBracket(athletes, { seed: 'reproSeed42' });
    const s2 = generateKumiteBracket(athletes, { seed: 'reproSeed42' });
    // Compare round 0 matchups
    for (let i = 0; i < s1.rounds[0].length; i++) {
      expect(s1.rounds[0][i].akaId).toBe(s2.rounds[0][i].akaId);
      expect(s1.rounds[0][i].shiroId).toBe(s2.rounds[0][i].shiroId);
    }
  });

  test('different seeds → (very likely) different bracket', () => {
    const athletes = mkAthletes(8);
    const s1 = generateKumiteBracket(athletes, { method: 'random', seed: 'seed-aaa' });
    const s2 = generateKumiteBracket(athletes, { method: 'random', seed: 'seed-zzz' });
    const match = s1.rounds[0].every((m, i) =>
      m.akaId === s2.rounds[0][i].akaId && m.shiroId === s2.rounds[0][i].shiroId
    );
    // This SHOULD be different — if not the RNG is broken
    expect(match).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 8. stateToMatchRows / rowsToState round-trip
// ─────────────────────────────────────────────────────────────────
describe('serialization round-trip', () => {
  test('state → rows → state preserves rounds', () => {
    const athletes = mkAthletes(8);
    const state = generateKumiteBracket(athletes, { seed: 'rt1' });
    const bracketId = 'bracket-uuid-1';
    const rows = stateToMatchRows(bracketId, state);
    const fakeRow = { id: bracketId, draw_seed: 'rt1', options: { method: 'ranking', thirdPlace: false } };
    const restored = rowsToState(rows, fakeRow, athletes);
    expect(restored.rounds).toHaveLength(state.rounds.length);
    for (let r = 0; r < state.rounds.length; r++) {
      expect(restored.rounds[r]).toHaveLength(state.rounds[r].length);
    }
  });

  test('winner is preserved through round-trip', () => {
    const athletes = mkAthletes(4);
    let state = generateKumiteBracket(athletes, { seed: 'rt2' });
    const m = state.rounds[0][0];
    state = advanceWinner(state, m.id, m.akaId);
    const bracketId = 'bracket-uuid-2';
    const rows = stateToMatchRows(bracketId, state);
    const fakeRow = { id: bracketId, draw_seed: 'rt2', options: { method: 'ranking', thirdPlace: false } };
    const restored = rowsToState(rows, fakeRow, athletes);
    expect(restored.rounds[0][0].winnerId).toBe(m.akaId);
  });
});

// ─────────────────────────────────────────────────────────────────
// 9. generateKataOrder
// ─────────────────────────────────────────────────────────────────
describe('generateKataOrder', () => {
  test('returns same length as input', () => {
    const athletes = mkAthletes(10);
    const ordered = generateKataOrder(athletes, 'kata1');
    expect(ordered).toHaveLength(10);
  });

  test('contains all athletes', () => {
    const athletes = mkAthletes(10);
    const ordered = generateKataOrder(athletes, 'kata2');
    const ids = ordered.map(a => a.id).sort();
    const orig = athletes.map(a => a.id).sort();
    expect(ids).toEqual(orig);
  });

  test('same seed → same order', () => {
    const athletes = mkAthletes(10);
    const o1 = generateKataOrder(athletes, 'kataX');
    const o2 = generateKataOrder(athletes, 'kataX');
    expect(o1.map(a => a.id)).toEqual(o2.map(a => a.id));
  });

  test('different seed → (very likely) different order for 10 athletes', () => {
    const athletes = mkAthletes(10);
    const o1 = generateKataOrder(athletes, 'seedA');
    const o2 = generateKataOrder(athletes, 'seedZ');
    const same = o1.every((a, i) => a.id === o2[i].id);
    expect(same).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 10. Edge cases
// ─────────────────────────────────────────────────────────────────
describe('edge cases', () => {
  test('throws with fewer than 2 athletes', () => {
    expect(() => generateKumiteBracket([mkAthletes(1)[0]], {})).toThrow();
    expect(() => generateKumiteBracket([], {})).toThrow();
  });

  test('2 athletes = immediate final', () => {
    const athletes = mkAthletes(2);
    const state = generateKumiteBracket(athletes, { seed: 'imm' });
    expect(state.rounds).toHaveLength(1); // just the final
    expect(state.rounds[0]).toHaveLength(1);
  });

  test('bye-auto-advanced athletes appear in next round', () => {
    const athletes = mkAthletes(3);
    const state = generateKumiteBracket(athletes, { seed: 'bye3' });
    // One match has a bye; that player should auto-advance
    const byeMatch = state.rounds[0].find(m => m.isBye);
    expect(byeMatch).toBeDefined();
    expect(byeMatch.winnerId).not.toBeNull();
  });
});
