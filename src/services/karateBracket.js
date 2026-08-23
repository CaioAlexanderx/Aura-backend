// ============================================================
// AURA KARATÊ — Track M: Bracket / Chave
//
// Pure, unit-testable bracket generation and advancement logic.
// NO database calls — just data transformation.
//
// Exports:
//   generateKumiteBracket(athletes, options)  → BracketState
//   advanceWinner(state, matchId, winnerId)   → BracketState (new)
//   generateKataOrder(athletes, seed)         → ordered array
//   seededRng(seed)                           → () => number
// ============================================================
'use strict';

// ── Seeded deterministic PRNG (mulberry32) ──────────────────────
// Reproducible: same seed → same bracket every time ("regenerar" is safe).
function seededRng(seed) {
  // Convert seed (string or number) to a 32-bit integer
  let s = 0;
  const str = String(seed === undefined || seed === null ? 'default' : seed);
  for (let i = 0; i < str.length; i++) {
    s = (Math.imul(31, s) + str.charCodeAt(i)) | 0;
  }
  // Ensure positive
  s = (s >>> 0) || 1;

  // mulberry32
  return function () {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Helpers ─────────────────────────────────────────────────────
function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

// Next power of 2 >= n
function nextPow2(n) {
  if (n <= 1) return 1;
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Standard single-elimination seed positions for N slots.
// Seeds are placed so #1 vs #2 can only meet in the final,
// #1 vs #3/#4 in semifinals, etc. (WKF/IJF pattern).
// Returns an array of length N where positions hold seed numbers 1..n
// and 'bye' fills the rest.
function standardSeedOrder(totalSlots, athleteCount) {
  // Classic seeding for bracket of size totalSlots:
  // Build recursively: [1, totalSlots, totalSlots/2+1, totalSlots/2, ...]
  function buildOrder(size) {
    if (size === 1) return [1];
    const half = size / 2;
    const prev = buildOrder(half);
    const result = [];
    for (const p of prev) {
      result.push(p, size + 1 - p);
    }
    return result;
  }
  const order = buildOrder(totalSlots); // length = totalSlots
  // Replace any seed > athleteCount with 'bye'
  return order.map(s => (s <= athleteCount ? s : 'bye'));
}

// Place byes at the top seeds to ensure top seeded athletes get byes
// when the bracket isn't full. Standard approach: the last seeds get
// byes (which in the seed order places byes so higher seeds advance).
function buildSlots(athletes, method, rng) {
  const n = athletes.length;
  const size = nextPow2(n);
  let slots; // array of (athleteId | 'bye'), length = size

  if (method === 'random') {
    // Shuffle athletes into random positions; fill rest with 'bye'
    const shuffled = shuffle(athletes.map(a => a.id), rng);
    slots = Array(size).fill('bye');
    for (let i = 0; i < shuffled.length; i++) {
      slots[i] = shuffled[i];
    }
    // Spread byes throughout: interleave to avoid clustering byes
    // Simple approach: keep first n slots as athletes, rest as byes
    // then sort so byes are evenly distributed via seed-order mapping
    const seedOrder = standardSeedOrder(size, n);
    // Map seed positions to athlete positions
    const byRandIdx = {};
    shuffled.forEach((id, i) => { byRandIdx[i + 1] = id; });
    slots = seedOrder.map(s => (s === 'bye' ? 'bye' : (byRandIdx[s] || 'bye')));
  } else {
    // 'ranking' method: seed by athlete order (index = seed)
    const seedOrder = standardSeedOrder(size, n);
    const byIdx = {};
    athletes.forEach((a, i) => { byIdx[i + 1] = a.id; });
    slots = seedOrder.map(s => (s === 'bye' ? 'bye' : (byIdx[s] || 'bye')));
  }
  return slots;
}

// Try to separate athletes from same dojo in round 1 via swaps.
// Strategy: for each pair in round 1 that shares dojo, try swapping
// one athlete with someone in another pair that doesn't create a clash.
// NOTE: named separateSameDojoSlots to avoid shadowing the boolean option
// of the same name destructured inside generateKumiteBracket.
function separateSameDojoSlots(slots, athletes) {
  const dojoMap = {};
  for (const a of athletes) dojoMap[a.id] = a.dojo_id || a.dojo || null;
  const n = slots.length; // always even (power of 2)
  const pairs = n / 2;

  function dojo(id) {
    return id === 'bye' ? null : dojoMap[id];
  }

  let changed = true;
  let passes = 0;
  while (changed && passes < 10) {
    changed = false;
    passes++;
    for (let p = 0; p < pairs; p++) {
      const a = slots[2 * p], b = slots[2 * p + 1];
      if (a === 'bye' || b === 'bye') continue;
      if (!dojo(a) || !dojo(b) || dojo(a) !== dojo(b)) continue;
      // Clash at pair p — look for a swap partner
      let swapped = false;
      for (let q = 0; q < pairs && !swapped; q++) {
        if (q === p) continue;
        const c = slots[2 * q], d = slots[2 * q + 1];
        // Try swap b with c (a stays, d stays)
        if (c !== 'bye' && dojo(a) !== dojo(c) && dojo(d) !== dojo(c) && dojo(b) !== dojo(d)) {
          // Actually check: after swap: pair p = (a, c), pair q = (b, d)
          if (dojo(a) !== dojo(c) && dojo(b) !== dojo(d)) {
            slots[2 * p + 1] = c;
            slots[2 * q] = b;
            changed = true;
            swapped = true;
          }
        }
        if (swapped) break;
        // Try swap b with d
        if (d !== 'bye' && dojo(a) !== dojo(d) && dojo(b) !== dojo(c)) {
          if (dojo(a) !== dojo(d) && dojo(b) !== dojo(c)) {
            slots[2 * p + 1] = d;
            slots[2 * q + 1] = b;
            changed = true;
            swapped = true;
          }
        }
      }
    }
  }
  return slots;
}

// Build rounds from first-round slots.
// Returns: { rounds: [ [{ id, akaId, shiroId, isBye },...], ...], size }
// rounds[0] = first round (R16 / R8 / R4 ...)
// rounds[r][p] feeds into rounds[r+1][floor(p/2)]
function buildRounds(slots) {
  const size = slots.length; // first round match count
  const numRounds = Math.log2(size); // e.g. 8 slots → 3 rounds (R8→R4→R2→Final)
  const rounds = [];
  // Round 0 (first round)
  const r0 = [];
  for (let p = 0; p < size / 2; p++) {
    const akaId = slots[2 * p];
    const shiroId = slots[2 * p + 1];
    const isBye = akaId === 'bye' || shiroId === 'bye';
    r0.push({ id: `r0-${p}`, round: 0, slot: p, akaId, shiroId, winnerId: null, isBye });
  }
  rounds.push(r0);
  // Subsequent rounds (placeholder slots — winners fill in)
  let prevSize = size / 2;
  for (let r = 1; r < numRounds; r++) {
    prevSize = prevSize / 2;
    const rr = [];
    for (let p = 0; p < prevSize; p++) {
      rr.push({ id: `r${r}-${p}`, round: r, slot: p, akaId: null, shiroId: null, winnerId: null, isBye: false });
    }
    rounds.push(rr);
  }
  return rounds;
}

// ── Main export: generateKumiteBracket ─────────────────────────
/**
 * Generate a single-elimination bracket for kumite.
 *
 * @param {Array} athletes  Array of { id, dojo_id?, dojo?, seed? }
 * @param {object} opts
 *   @param {string} [opts.method='ranking']  'ranking' | 'random'
 *   @param {boolean} [opts.separateSameDojo=false]
 *   @param {boolean} [opts.thirdPlace=false]
 *   @param {string|number} [opts.seed]  RNG seed for reproducibility
 * @returns {BracketState}
 */
function generateKumiteBracket(athletes, opts = {}) {
  const {
    method = 'ranking',
    separateSameDojo = false,
    thirdPlace = false,
    seed,
  } = opts;

  if (!athletes || athletes.length < 2) {
    throw new Error('Mínimo de 2 atletas para gerar chave');
  }

  const rng = seededRng(seed);
  let slots = buildSlots(athletes, method, rng);

  if (separateSameDojo) {
    slots = separateSameDojoSlots(slots, athletes);
  }

  const rounds = buildRounds(slots);

  // Auto-advance byes in round 0
  for (const match of rounds[0]) {
    if (match.akaId === 'bye' && match.shiroId !== 'bye') {
      match.winnerId = match.shiroId;
    } else if (match.shiroId === 'bye' && match.akaId !== 'bye') {
      match.winnerId = match.akaId;
    } else if (match.akaId === 'bye' && match.shiroId === 'bye') {
      match.winnerId = null; // double bye (shouldn't happen with sane input)
    }
  }

  // Propagate bye winners to next rounds
  propagateWinners(rounds);

  const byeCount = slots.filter(s => s === 'bye').length;

  return {
    method,
    seed: seed !== undefined ? seed : null,
    options: { separateSameDojo, thirdPlace },
    athletes,
    slots,
    rounds,
    byeCount,
    thirdPlaceMatch: thirdPlace ? { id: 'third', akaId: null, shiroId: null, winnerId: null } : null,
  };
}

// Propagate known winners up the tree
function propagateWinners(rounds) {
  for (let r = 1; r < rounds.length; r++) {
    const prev = rounds[r - 1];
    const cur = rounds[r];
    for (let p = 0; p < cur.length; p++) {
      const feedA = prev[2 * p];
      const feedB = prev[2 * p + 1];
      if (feedA && feedA.winnerId !== null) {
        cur[p].akaId = feedA.winnerId;
      }
      if (feedB && feedB.winnerId !== null) {
        cur[p].shiroId = feedB.winnerId;
      }
      // Auto-advance if one side is null (bye propagation)
      if (cur[p].akaId === null && cur[p].shiroId !== null) {
        cur[p].winnerId = cur[p].shiroId;
      } else if (cur[p].shiroId === null && cur[p].akaId !== null) {
        cur[p].winnerId = cur[p].akaId;
      }
    }
  }
}

// ── advanceWinner ───────────────────────────────────────────────
/**
 * Record a winner for a match and propagate up the bracket.
 *
 * @param {BracketState} state
 * @param {string} matchId   e.g. 'r0-0', 'r1-2', 'third'
 * @param {string} winnerId  athlete id (must be aka or shiro of the match)
 * @returns {BracketState} new state (immutable update)
 */
function advanceWinner(state, matchId, winnerId) {
  // Deep-ish clone of rounds
  const rounds = state.rounds.map(r => r.map(m => ({ ...m })));
  let thirdPlaceMatch = state.thirdPlaceMatch ? { ...state.thirdPlaceMatch } : null;

  if (matchId === 'third') {
    if (!thirdPlaceMatch) throw new Error('Disputa de 3º lugar não habilitada');
    if (winnerId !== thirdPlaceMatch.akaId && winnerId !== thirdPlaceMatch.shiroId) {
      throw new Error('Vencedor não participa dessa partida');
    }
    thirdPlaceMatch.winnerId = winnerId;
    return { ...state, rounds, thirdPlaceMatch };
  }

  // Parse matchId: 'r{round}-{slot}'
  const m = matchId.match(/^r(\d+)-(\d+)$/);
  if (!m) throw new Error(`matchId inválido: ${matchId}`);
  const round = parseInt(m[1], 10);
  const slot = parseInt(m[2], 10);

  const match = rounds[round]?.[slot];
  if (!match) throw new Error(`Partida não encontrada: ${matchId}`);
  if (winnerId !== match.akaId && winnerId !== match.shiroId) {
    throw new Error('Vencedor não participa dessa partida');
  }

  match.winnerId = winnerId;

  // Propagate: put winner into next round
  const nextRound = round + 1;
  if (nextRound < rounds.length) {
    const nextSlot = Math.floor(slot / 2);
    const isAkaFeed = slot % 2 === 0;
    const next = rounds[nextRound][nextSlot];
    if (isAkaFeed) {
      next.akaId = winnerId;
    } else {
      next.shiroId = winnerId;
    }
    // Clear winner if we're re-deciding (overwrite)
    if (next.winnerId !== null) {
      // Loser of this match might have been propagated — reset downstream
      next.winnerId = null;
      resetDownstream(rounds, nextRound, nextSlot);
    }
    propagateWinners(rounds);
  }

  // Handle 3rd place: losers of semi-finals (last round before final)
  if (thirdPlaceMatch && nextRound === rounds.length - 1) {
    // The loser of a semi-final feeds the 3rd place match
    const loserId = winnerId === match.akaId ? match.shiroId : match.akaId;
    if (slot === 0) {
      thirdPlaceMatch.akaId = loserId;
    } else if (slot === 1) {
      thirdPlaceMatch.shiroId = loserId;
    }
    // Clear 3rd place result if re-doing semi
    if (thirdPlaceMatch.winnerId !== null) {
      thirdPlaceMatch.winnerId = null;
    }
  }

  return { ...state, rounds, thirdPlaceMatch };
}

function resetDownstream(rounds, startRound, startSlot) {
  for (let r = startRound; r < rounds.length; r++) {
    const s = r === startRound ? startSlot : 0;
    // This is approximate; for full reset we'd need to track all dependents
    // But for typical usage (re-clicking a match) this is sufficient
    for (let p = s; p < rounds[r].length; p++) {
      rounds[r][p].winnerId = null;
    }
    break; // Only reset immediate next round for now
  }
}

// ── getChampion ─────────────────────────────────────────────────
/**
 * Returns the champion athlete id from a bracket state, or null.
 */
function getChampion(state) {
  const lastRound = state.rounds[state.rounds.length - 1];
  if (!lastRound || !lastRound[0]) return null;
  return lastRound[0].winnerId;
}

// ── generateKataOrder ───────────────────────────────────────────
/**
 * Generates a randomized presentation order for kata competitors.
 * @param {Array} athletes  Array of { id, ... }
 * @param {string|number} [seed]
 * @returns {Array}  athletes in presentation order
 */
function generateKataOrder(athletes, seed) {
  const rng = seededRng(seed);
  return shuffle([...athletes], rng);
}

// ── Serialization helpers ────────────────────────────────────────
/**
 * Convert bracket state to DB rows for karate_bracket_matches.
 * @param {string} bracketId
 * @param {BracketState} state
 * @returns {Array} rows
 */
function stateToMatchRows(bracketId, state) {
  const rows = [];
  for (const round of state.rounds) {
    for (const m of round) {
      rows.push({
        bracket_id: bracketId,
        round: m.round,
        slot: m.slot,
        bracket_kind: 'main',
        aka_entry_id: m.akaId === 'bye' || !m.akaId ? null : m.akaId,
        shiro_entry_id: m.shiroId === 'bye' || !m.shiroId ? null : m.shiroId,
        winner_entry_id: m.winnerId,
        is_bye: m.isBye || (m.akaId === 'bye' || m.shiroId === 'bye'),
      });
    }
  }
  if (state.thirdPlaceMatch) {
    const t = state.thirdPlaceMatch;
    rows.push({
      bracket_id: bracketId,
      round: state.rounds.length,
      slot: 0,
      bracket_kind: 'third',
      aka_entry_id: t.akaId || null,
      shiro_entry_id: t.shiroId || null,
      winner_entry_id: t.winnerId || null,
      is_bye: false,
    });
  }
  return rows;
}

/**
 * Reconstruct bracket state from DB rows (for reading back from DB).
 * @param {Array} matchRows — rows from karate_bracket_matches
 * @param {object} bracketRow — row from karate_brackets
 * @param {Array} athletes
 * @returns {BracketState}
 */
function rowsToState(matchRows, bracketRow, athletes) {
  const mainMatches = matchRows.filter(r => r.bracket_kind === 'main');
  const thirdRow = matchRows.find(r => r.bracket_kind === 'third') || null;

  // Find max round
  const maxRound = mainMatches.reduce((max, r) => Math.max(max, r.round), 0);
  const rounds = [];
  for (let r = 0; r <= maxRound; r++) {
    const roundMatches = mainMatches.filter(m => m.round === r).sort((a, b) => a.slot - b.slot);
    rounds.push(roundMatches.map(m => ({
      id: `r${m.round}-${m.slot}`,
      round: m.round,
      slot: m.slot,
      akaId: m.aka_entry_id || (m.is_bye ? 'bye' : null),
      shiroId: m.shiro_entry_id || (m.is_bye ? 'bye' : null),
      winnerId: m.winner_entry_id || null,
      isBye: m.is_bye,
    })));
  }

  const opts = bracketRow.options || {};
  return {
    method: opts.method || 'ranking',
    seed: bracketRow.draw_seed || null,
    options: opts,
    athletes,
    slots: [],
    rounds,
    byeCount: mainMatches.filter(m => m.is_bye).length,
    thirdPlaceMatch: thirdRow ? {
      id: 'third',
      akaId: thirdRow.aka_entry_id || null,
      shiroId: thirdRow.shiro_entry_id || null,
      winnerId: thirdRow.winner_entry_id || null,
    } : (opts.thirdPlace ? { id: 'third', akaId: null, shiroId: null, winnerId: null } : null),
  };
}

// ── computePlacements ───────────────────────────────────────────
/**
 * P2 (modo mesário): deriva o PÓDIO da chave decidida — mata o "correio de
 * papel" (planilha → mesa central → premiação) do dia de evento.
 *
 * Regra real (Campeonato Paulista/FPKT 2026):
 *  - COM disputa de 3º lugar: 1º, 2º, 3º (vencedor da disputa), 4º (perdedor).
 *  - SEM disputa de 3º: os DOIS perdedores das semifinais são 3º ("não tem
 *    disputa de 3º lugar de forma que haverá dois 3º lugares" — chave real).
 *  - Byes ('bye'/null) nunca entram no pódio.
 *
 * @param {BracketState} state
 * @returns {{complete: boolean, reason: string|null,
 *            placements: Array<{entryId: string, placement: number}>}}
 */
function computePlacements(state) {
  const real = (id) => (id && id !== 'bye' ? id : null);
  const rounds = (state && state.rounds) || [];
  const lastRound = rounds.length ? rounds[rounds.length - 1] : null;
  if (!lastRound || !lastRound[0]) {
    return { complete: false, reason: 'CHAVE_VAZIA', placements: [] };
  }

  const final = lastRound[0];
  const champion = real(final.winnerId);
  if (!champion) {
    return { complete: false, reason: 'FINAL_PENDENTE', placements: [] };
  }
  const runnerUp = real(champion === final.akaId ? final.shiroId : final.akaId);

  const placements = [{ entryId: champion, placement: 1 }];
  if (runnerUp) placements.push({ entryId: runnerUp, placement: 2 });

  const third = state.thirdPlaceMatch;
  const thirdHasPlayers = third && (real(third.akaId) || real(third.shiroId));
  if (thirdHasPlayers) {
    const w = real(third.winnerId);
    if (!w) return { complete: false, reason: 'TERCEIRO_PENDENTE', placements: [] };
    placements.push({ entryId: w, placement: 3 });
    const fourth = real(w === third.akaId ? third.shiroId : third.akaId);
    if (fourth) placements.push({ entryId: fourth, placement: 4 });
  } else if (rounds.length >= 2) {
    const semis = rounds[rounds.length - 2];
    for (const m of semis) {
      const w = real(m.winnerId);
      if (!w) continue; // semi de bye puro não gera perdedor real
      const loser = real(w === m.akaId ? m.shiroId : m.akaId);
      if (loser) placements.push({ entryId: loser, placement: 3 });
    }
  }

  return { complete: true, reason: null, placements };
}

module.exports = {
  seededRng,
  generateKumiteBracket,
  advanceWinner,
  generateKataOrder,
  getChampion,
  computePlacements,
  stateToMatchRows,
  rowsToState,
};
