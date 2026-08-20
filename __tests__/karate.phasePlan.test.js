// ============================================================
// AURA KARATÊ — P1 Hub: PLANO DE FASES + DECISÃO + KATA EM CHAVE
//
// Cobertura:
//  Serviço puro (karatePhasePlanService):
//   (1) validatePhasePlan — plano JKA completo ok; formatos/decisões
//       inválidos, duas finais, votos fora de 0..5 → erro.
//   (2) resolvePhaseForRound — a progressão REAL da Copa JKA Infantil
//       (Sanbon → Kihon 16 → Jyu 8 → Shobu 4/final) resolvida rodada a
//       rodada numa chave de 32; 3º lugar herda a fase final.
//   (3) validateDecision/normalizeDecision — hantei 3×2 ok; nota cortada.
//  Rotas (karateBrackets):
//   (4) PATCH phase-plan — 422 em plano inválido; upsert plan-first
//       (cria a linha do bracket antes do sorteio).
//   (5) advance com decision inválida → 422 SEM tocar o banco.
//   (6) advance com decision válida → INSERT do match decidido carrega
//       decision (jsonb) + match_format (snapshot do plano).
//   (7) generate kata_mode='hantei_tree' → kata vira ÁRVORE (matches
//       inseridos, kata_mode gravado, sem kata_scores).
//   (8) GET bracket de kata hantei_tree → devolve a árvore com
//       phases_by_round/match_format (não bateria de notas).
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const svc = require('../src/services/karatePhasePlanService');

const FED_ID = 'fed-uuid-p1';
const COMP_ID = 'comp-uuid-p1';
const CAT_ID = 'cat-uuid-p1';
const BRACKET_ID = 'bracket-uuid-p1';
const ENTRY_A = 'entry-a-uuid';
const ENTRY_B = 'entry-b-uuid';

const adminToken = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

// A progressão REAL da Copa Paulista JKA — categoria Infantil (12-13):
// eliminatórias Sanbon → 16 classificados Kihon-Ippon → 8 semifinalistas
// Jyu-Ippon → 4 finalistas Shobu-Ippon (Regulamento 2026, Dossiê Shiai §4).
const JKA_INFANTIL_PLAN = {
  phases: [
    { from_participants: null, format: 'sanbon_kumite', decision: 'hantei' },
    { from_participants: 16, format: 'kihon_ippon', decision: 'hantei' },
    { from_participants: 8, format: 'jyu_ippon', decision: 'hantei' },
    { from_participants: 4, format: 'shobu_ippon', duration_sec: 90, time_mode: 'corrido' },
    { final: true, format: 'shobu_ippon', duration_sec: 90, time_mode: 'efetivo' },
  ],
  tiebreak: ['hantei', 'kettei_sen', 'central'],
  prize_places: 4,
  third_place_dispute: false,
};

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ── (1) validatePhasePlan ───────────────────────────────────
describe('validatePhasePlan', () => {
  it('plano JKA completo é válido; {} (legado) é válido', () => {
    expect(svc.validatePhasePlan(JKA_INFANTIL_PLAN).ok).toBe(true);
    expect(svc.validatePhasePlan({}).ok).toBe(true);
    expect(svc.validatePhasePlan(null).ok).toBe(true);
  });

  it('recusa formato desconhecido, duas finais e tiebreak inválido', () => {
    expect(svc.validatePhasePlan({ phases: [{ format: 'mma' }] }).ok).toBe(false);
    expect(svc.validatePhasePlan({
      phases: [{ final: true, format: 'shobu_ippon' }, { final: true, format: 'shobu_sanbon' }],
    }).ok).toBe(false);
    expect(svc.validatePhasePlan({ tiebreak: ['moeda'] }).ok).toBe(false);
    expect(svc.validatePhasePlan({ phases: [{ from_participants: 1, format: 'kihon_ippon' }] }).ok).toBe(false);
  });
});

// ── (2) resolvePhaseForRound — chave de 32 (5 rodadas) ──────
describe('resolvePhaseForRound — progressão Copa JKA Infantil em chave de 32', () => {
  const R = 5; // 32 → 16 → 8 → 4 → final
  const fmt = (round, isThird = false) =>
    svc.resolvePhaseForRound(JKA_INFANTIL_PLAN, round, R, isThird).format;

  it('rodada a rodada: Sanbon → Kihon → Jyu → Shobu → Final Shobu', () => {
    expect(fmt(0)).toBe('sanbon_kumite'); // 32 participantes
    expect(fmt(1)).toBe('kihon_ippon');   // 16
    expect(fmt(2)).toBe('jyu_ippon');     // 8
    expect(fmt(3)).toBe('shobu_ippon');   // 4 (semifinal)
    expect(fmt(4)).toBe('shobu_ippon');   // final (fase final:true)
  });

  it('a final usa a fase final:true (tempo EFETIVO ≠ corrido das semis)', () => {
    const semi = svc.resolvePhaseForRound(JKA_INFANTIL_PLAN, 3, R);
    const final = svc.resolvePhaseForRound(JKA_INFANTIL_PLAN, 4, R);
    expect(semi.time_mode).toBe('corrido');
    expect(final.time_mode).toBe('efetivo');
  });

  it('3º lugar herda a fase final', () => {
    expect(fmt(2, true)).toBe('shobu_ippon');
    expect(svc.resolvePhaseForRound(JKA_INFANTIL_PLAN, 2, R, true).time_mode).toBe('efetivo');
  });

  it('sem plano → null (comportamento legado)', () => {
    expect(svc.resolvePhaseForRound({}, 0, 3)).toBeNull();
    expect(svc.resolvePhaseForRound(null, 0, 3)).toBeNull();
  });

  it('phaseByRound devolve o mapa completo com rótulos', () => {
    const map = svc.phaseByRound(JKA_INFANTIL_PLAN, R);
    expect(map).toHaveLength(5);
    expect(map[1].format_label).toBe('Kihon-Ippon-Kumite');
    expect(map[4].time_mode).toBe('efetivo');
  });
});

// ── (3) decisão ─────────────────────────────────────────────
describe('validateDecision / normalizeDecision', () => {
  it('hantei 3×2 é válido e normaliza limpo', () => {
    const d = { method: 'hantei', votes_aka: 3, votes_shiro: 2, note: '  empate na 1ª  ' };
    expect(svc.validateDecision(d).ok).toBe(true);
    expect(svc.normalizeDecision(d)).toEqual({ method: 'hantei', votes_aka: 3, votes_shiro: 2, note: 'empate na 1ª' });
  });
  it('método inválido e votos fora de 0..5 são recusados', () => {
    expect(svc.validateDecision({ method: 'cara_ou_coroa' }).ok).toBe(false);
    expect(svc.validateDecision({ method: 'hantei', votes_aka: 6 }).ok).toBe(false);
  });
  it('null é aceito (decisão é opcional)', () => {
    expect(svc.validateDecision(null).ok).toBe(true);
    expect(svc.normalizeDecision(null)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// Rotas
// ════════════════════════════════════════════════════════════
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateBrackets'));
  return app;
}

function makeClient({ dispatch }) {
  const query = jest.fn((sql, params) => {
    const st = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(st)) return Promise.resolve({});
    return dispatch(st, params);
  });
  return { query, release: jest.fn() };
}

const compRow = { id: COMP_ID, status: 'open' };

describe('PATCH bracket/phase-plan', () => {
  it('(4) plano inválido → 422 sem gravar; válido → upsert plan-first', async () => {
    const bad = await request(buildApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket/phase-plan`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ phase_plan: { phases: [{ format: 'mma' }] } });
    expect(bad.status).toBe(422);
    expect(db.connect).not.toHaveBeenCalled();

    const client = makeClient({
      dispatch: (st, params) => {
        if (/FROM karate_competitions/i.test(st)) return Promise.resolve({ rows: [compRow] });
        if (/FROM karate_competition_categories/i.test(st)) return Promise.resolve({ rows: [{ id: CAT_ID, modality: 'kumite' }] });
        if (/INSERT INTO karate_brackets/i.test(st)) {
          expect(st).toMatch(/phase_plan/);
          expect(JSON.parse(params[3])).toEqual(JKA_INFANTIL_PLAN);
          return Promise.resolve({ rows: [{ id: BRACKET_ID, status: 'draft', phase_plan: JKA_INFANTIL_PLAN }] });
        }
        return Promise.resolve({ rows: [] });
      },
    });
    db.connect.mockResolvedValue(client);

    const ok = await request(buildApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket/phase-plan`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ phase_plan: JKA_INFANTIL_PLAN });
    expect(ok.status).toBe(200);
    expect(ok.body.bracket_id).toBe(BRACKET_ID);
    expect(ok.body.phase_plan.phases).toHaveLength(5);
  });
});

// Estado de uma chave de 2 atletas (1 rodada) travada, com plano.
function lockedBracketDispatch({ captureInserts }) {
  return (st, params) => {
    if (/FROM karate_competitions/i.test(st)) return Promise.resolve({ rows: [compRow] });
    if (/FROM karate_competition_entries e/i.test(st)) {
      return Promise.resolve({ rows: [
        { id: ENTRY_A, student_id: 's1', team_id: null, dojo_id: null, student_name: 'Aka', dojo_name: null },
        { id: ENTRY_B, student_id: 's2', team_id: null, dojo_id: null, student_name: 'Shiro', dojo_name: null },
      ] });
    }
    if (/COALESCE\(cat\.fee_amount/i.test(st)) return Promise.resolve({ rows: [{ effective_fee: 0 }] });
    if (/FROM karate_brackets WHERE category_id/i.test(st)) {
      return Promise.resolve({ rows: [{
        id: BRACKET_ID, competition_id: COMP_ID, category_id: CAT_ID,
        modality: 'kumite', status: 'locked', draw_seed: 's', options: {},
        phase_plan: JKA_INFANTIL_PLAN, kata_mode: null,
      }] });
    }
    if (/FROM karate_bracket_matches/i.test(st)) {
      return Promise.resolve({ rows: [{
        bracket_id: BRACKET_ID, round: 0, slot: 0, bracket_kind: 'main',
        aka_entry_id: ENTRY_A, shiro_entry_id: ENTRY_B, winner_entry_id: null,
        is_bye: false, aka_score: null, shiro_score: null, match_format: null, decision: null,
      }] });
    }
    if (/DELETE FROM karate_bracket_matches/i.test(st)) return Promise.resolve({});
    if (/INSERT INTO karate_bracket_matches/i.test(st)) {
      if (captureInserts) captureInserts.push({ sql: st, params });
      return Promise.resolve({});
    }
    return Promise.resolve({ rows: [] });
  };
}

describe('POST bracket/advance com decision (P1)', () => {
  it('(5) decision inválida → 422 antes de abrir transação', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket/advance`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ match_id: 'r0-0', winner_entry_id: ENTRY_A, decision: { method: 'dado' } });
    expect(res.status).toBe(422);
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('(6) decisão por hantei gravada + match_format = snapshot do plano', async () => {
    const inserts = [];
    const client = makeClient({ dispatch: lockedBracketDispatch({ captureInserts: inserts }) });
    db.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket/advance`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        match_id: 'r0-0', winner_entry_id: ENTRY_A,
        decision: { method: 'hantei', votes_aka: 4, votes_shiro: 1 },
      });

    expect(res.status).toBe(200);
    expect(res.body.champion_entry_id).toBe(ENTRY_A); // chave de 2 → final direto
    // O INSERT do match decidido carrega decision + match_format.
    const decided = inserts.find((c) => c.params && c.params.length >= 12 && c.params[6] === ENTRY_A);
    expect(decided).toBeTruthy();
    expect(decided.params[10]).toBe('shobu_ippon'); // final da chave de 2 = fase final:true
    expect(JSON.parse(decided.params[11])).toEqual({ method: 'hantei', votes_aka: 4, votes_shiro: 1 });
  });
});

describe('generate kata_mode=hantei_tree (P1)', () => {
  it('(7) kata vira árvore: matches inseridos, kata_mode gravado, sem kata_scores', async () => {
    const inserts = [];
    const client = makeClient({
      dispatch: (st, params) => {
        if (/FROM karate_competitions/i.test(st)) return Promise.resolve({ rows: [compRow] });
        if (/FROM karate_competition_categories/i.test(st)) return Promise.resolve({ rows: [{ id: CAT_ID, modality: 'kata' }] });
        if (/FROM karate_competition_entries e/i.test(st)) {
          return Promise.resolve({ rows: [
            { id: ENTRY_A, student_id: 's1', team_id: null, dojo_id: null, student_name: 'A', dojo_name: null },
            { id: ENTRY_B, student_id: 's2', team_id: null, dojo_id: null, student_name: 'B', dojo_name: null },
          ] });
        }
        if (/COALESCE\(cat\.fee_amount/i.test(st)) return Promise.resolve({ rows: [{ effective_fee: 0 }] });
        if (/INSERT INTO karate_brackets/i.test(st)) {
          expect(st).toMatch(/kata_mode/);
          expect(params).toContain('hantei_tree');
          return Promise.resolve({ rows: [{ id: BRACKET_ID }] });
        }
        if (/DELETE FROM karate_bracket_matches/i.test(st)) return Promise.resolve({});
        if (/INSERT INTO karate_bracket_matches/i.test(st)) { inserts.push(params); return Promise.resolve({}); }
        if (/karate_kata_scores/i.test(st)) { throw new Error('não deveria tocar kata_scores em hantei_tree'); }
        return Promise.resolve({ rows: [] });
      },
    });
    db.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket/generate`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ method: 'random', seed: 42, kata_mode: 'hantei_tree' });

    expect(res.status).toBe(200);
    expect(res.body.kata_mode).toBe('hantei_tree');
    expect(res.body.rounds_count).toBe(1); // 2 atletas → 1 rodada
    expect(inserts.length).toBeGreaterThan(0); // árvore persistida
  });
});

describe('GET bracket de kata hantei_tree (P1)', () => {
  it('(8) devolve a ÁRVORE com phases_by_round e match_format (não notas)', async () => {
    const client = makeClient({
      dispatch: (st) => {
        if (/FROM karate_competitions/i.test(st)) return Promise.resolve({ rows: [compRow] });
        if (/FROM karate_competition_entries e/i.test(st)) {
          return Promise.resolve({ rows: [
            { id: ENTRY_A, student_id: 's1', team_id: null, dojo_id: null, student_name: 'A', dojo_name: null },
            { id: ENTRY_B, student_id: 's2', team_id: null, dojo_id: null, student_name: 'B', dojo_name: null },
          ] });
        }
        if (/COALESCE\(cat\.fee_amount/i.test(st)) return Promise.resolve({ rows: [{ effective_fee: 0 }] });
        if (/FROM karate_brackets WHERE category_id/i.test(st)) {
          return Promise.resolve({ rows: [{
            id: BRACKET_ID, modality: 'kata', status: 'locked', draw_seed: 's', options: {},
            kata_mode: 'hantei_tree',
            phase_plan: { phases: [{ from_participants: null, format: 'kata_hantei', decision: 'hantei' }] },
          }] });
        }
        if (/FROM karate_bracket_matches/i.test(st)) {
          return Promise.resolve({ rows: [{
            bracket_id: BRACKET_ID, round: 0, slot: 0, bracket_kind: 'main',
            aka_entry_id: ENTRY_A, shiro_entry_id: ENTRY_B, winner_entry_id: null,
            is_bye: false, aka_score: null, shiro_score: null, match_format: null, decision: null,
          }] });
        }
        return Promise.resolve({ rows: [] });
      },
    });
    db.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket`)
      .set('Authorization', 'Bearer ' + adminToken);

    expect(res.status).toBe(200);
    expect(res.body.kata_scores).toBeUndefined(); // NÃO é bateria de notas
    expect(res.body.kata_mode).toBe('hantei_tree');
    expect(res.body.rounds).toHaveLength(1);
    expect(res.body.rounds[0][0].match_format).toBe('kata_hantei'); // resolvido do plano
    expect(res.body.phases_by_round[0].format_label).toBe('Kata (bandeiras)');
  });
});
