// ============================================================
// AURA KARATÊ — P1 Hub: KOTOS (áreas) + BOARD DO DIA + SÚMULA
//
// Cobertura:
//  Serviço puro (karateScheduleService):
//   (1) estimativas por modalidade (kata notas vs chave, kumite N-1
//       lutas, equipes) e o sanity com o número REAL da planilha:
//       um koto misto de ~58 atletas fecha em ~3-4h.
//   (2) summarizeArea/formatMinutes ("~3,5h", formato da planilha).
//  Rotas:
//   (3) areas CRUD: criar, nome duplicado 409, 42P01 → 503/[].
//   (4) PATCH categories/:catId/area — aloca no koto (valida a área da
//       competição) e desaloca (area_id null).
//   (5) schedule-board: agrupa por área com est_label + não alocadas +
//       totais.
//   (6) scoresheet: árvore com formato por rodada (phase_plan), rodapé
//       de regras (desempate/premiação/"não tem 3º lugar"), koto no
//       cabeçalho e campos manuscritos.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const sched = require('../src/services/karateScheduleService');

const FED_ID = 'fed-uuid-p12';
const COMP_ID = 'comp-uuid-p12';
const AREA_A = 'area-a-uuid';
const AREA_B = 'area-b-uuid';
const CAT_1 = 'cat-1-uuid';
const CAT_2 = 'cat-2-uuid';
const CAT_3 = 'cat-3-uuid';
const ENTRY_A = 'entry-a-uuid';
const ENTRY_B = 'entry-b-uuid';

const adminToken = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ── (1)(2) serviço puro ─────────────────────────────────────
describe('karateScheduleService — estimativas', () => {
  it('kata por notas é por atleta; kata em chave e kumite são por luta (N-1)', () => {
    expect(sched.estimateCategoryMinutes({ modality: 'kata', entry_count: 10 })).toBe(35);
    expect(sched.estimateCategoryMinutes({ modality: 'kata', entry_count: 10, kata_mode: 'hantei_tree' })).toBe(36); // 9 lutas × 4
    expect(sched.estimateCategoryMinutes({ modality: 'kumite', entry_count: 10 })).toBe(32); // 9 × 3,5
    expect(sched.estimateCategoryMinutes({ modality: 'kihon_ippon', entry_count: 9 })).toBe(20); // 8 × 2,5
    expect(sched.estimateCategoryMinutes({ modality: 'team_kumite', entry_count: 4 })).toBe(30); // 3 × 10
    expect(sched.estimateCategoryMinutes({ modality: 'kumite', entry_count: 1 })).toBe(0); // sem luta
  });

  it('sanity da planilha real: koto misto de ~58 atletas fecha em ~3-4h', () => {
    // Mix plausível de um koto do Paulista: kata individual + kumite + equipe.
    const koto = [
      { modality: 'kata', entry_count: 26 },
      { modality: 'kumite', entry_count: 25 },
      { modality: 'team_kumite', entry_count: 4 },
      { modality: 'kata', entry_count: 3 },
    ];
    const sum = sched.summarizeArea(koto);
    expect(sum.entry_count).toBe(58);
    expect(sum.est_minutes).toBeGreaterThanOrEqual(180); // ≥3h
    expect(sum.est_minutes).toBeLessThanOrEqual(250);    // ≤~4h
    expect(sum.est_label).toMatch(/^~\d+(,\d)?h$/);
  });

  it('formatMinutes segue o formato da planilha ("~3,5h") e "—" para vazio', () => {
    expect(sched.formatMinutes(210)).toBe('~3,5h');
    expect(sched.formatMinutes(45)).toBe('~45min');
    expect(sched.formatMinutes(0)).toBe('—');
  });
});

// ── Rotas ───────────────────────────────────────────────────
function buildSetupApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateCompetitionSetup'));
  return app;
}

const compRow = { id: COMP_ID, status: 'open' };

describe('áreas (kotos) — CRUD', () => {
  it('(3) cria área; nome duplicado → 409; migração pendente → 503 e GET []', async () => {
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/FROM karate_competitions/i.test(s)) return Promise.resolve({ rows: [compRow] });
      if (/INSERT INTO karate_competition_areas/i.test(s)) {
        if (params[1] === 'Koto A') {
          return Promise.resolve({ rows: [{ id: AREA_A, name: 'Koto A', sort_order: 0, notes: null, created_at: 'x' }] });
        }
        const e = new Error('dup'); e.code = '23505'; return Promise.reject(e);
      }
      return Promise.resolve({ rows: [] });
    });

    const ok = await request(buildSetupApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/areas`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Koto A' });
    expect(ok.status).toBe(201);
    expect(ok.body.name).toBe('Koto A');

    const dup = await request(buildSetupApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/areas`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Koto B' });
    expect(dup.status).toBe(409);

    // 42P01 → POST 503 / GET []
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM karate_competitions/i.test(s)) return Promise.resolve({ rows: [compRow] });
      const e = new Error('no table'); e.code = '42P01'; return Promise.reject(e);
    });
    const pend = await request(buildSetupApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/areas`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Koto C' });
    expect(pend.status).toBe(503);
    expect(pend.body.code).toBe('SCHEMA_PENDING');
    const list = await request(buildSetupApp())
      .get(`/federation/${FED_ID}/competitions/${COMP_ID}/areas`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });
});

describe('alocação de categoria no koto', () => {
  it('(4) aloca com validação da área; area_id null desaloca', async () => {
    const calls = [];
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      calls.push({ s, params });
      if (/FROM karate_competitions/i.test(s)) return Promise.resolve({ rows: [compRow] });
      if (/SELECT id FROM karate_competition_areas/i.test(s)) {
        return Promise.resolve({ rows: params[0] === AREA_A ? [{ id: AREA_A }] : [] });
      }
      if (/UPDATE karate_competition_categories/i.test(s)) {
        return Promise.resolve({ rows: [{ id: CAT_1, area_id: params[0], area_order: params[1] }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const ok = await request(buildSetupApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_1}/area`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ area_id: AREA_A, area_order: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body.area_id).toBe(AREA_A);

    const badArea = await request(buildSetupApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_1}/area`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ area_id: 'area-de-outra-comp' });
    expect(badArea.status).toBe(404);

    const unassign = await request(buildSetupApp())
      .patch(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_1}/area`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ area_id: null, area_order: null });
    expect(unassign.status).toBe(200);
    // Desalocar NÃO consulta a tabela de áreas (não há o que validar).
    const areaChecks = calls.filter((c) => /SELECT id FROM karate_competition_areas/i.test(c.s));
    expect(areaChecks).toHaveLength(2);
  });
});

describe('schedule-board', () => {
  it('(5) agrupa por área com estimativa, não alocadas e totais', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM karate_competitions/i.test(s)) return Promise.resolve({ rows: [compRow] });
      if (/FROM karate_competition_areas/i.test(s)) {
        return Promise.resolve({ rows: [
          { id: AREA_A, name: 'Koto A', sort_order: 0, notes: null },
          { id: AREA_B, name: 'Koto B', sort_order: 1, notes: null },
        ] });
      }
      if (/FROM karate_competition_categories cat/i.test(s)) {
        return Promise.resolve({ rows: [
          { id: CAT_1, name: 'Kata Mirim', modality: 'kata', group_label: 'Grupo 1', division_id: 'd1', division_name: 'Principal', area_id: AREA_A, area_order: 0, kata_mode: null, entry_count: 20 },
          { id: CAT_2, name: 'Kumite Adulto', modality: 'kumite', group_label: null, division_id: 'd1', division_name: 'Principal', area_id: AREA_A, area_order: 1, kata_mode: null, entry_count: 15 },
          { id: CAT_3, name: 'Kata Equipe', modality: 'team_kata', group_label: null, division_id: null, division_name: null, area_id: null, area_order: null, kata_mode: null, entry_count: 6 },
        ] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(buildSetupApp())
      .get(`/federation/${FED_ID}/competitions/${COMP_ID}/schedule-board`)
      .set('Authorization', 'Bearer ' + adminToken);

    expect(res.status).toBe(200);
    expect(res.body.areas).toHaveLength(2);
    const kotoA = res.body.areas[0];
    expect(kotoA.entry_count).toBe(35);
    expect(kotoA.est_minutes).toBe(70 + 49); // kata 20×3,5 + kumite 14×3,5
    expect(kotoA.est_label).toMatch(/^~/);
    expect(kotoA.categories.map((c) => c.id)).toEqual([CAT_1, CAT_2]);
    expect(res.body.areas[1].categories).toHaveLength(0);
    expect(res.body.unassigned).toHaveLength(1);
    expect(res.body.unassigned[0].id).toBe(CAT_3);
    expect(res.body.totals).toEqual({ categories: 3, assigned: 2, entry_count: 41 });
  });
});

// ── (6) súmula ──────────────────────────────────────────────
function buildBracketsApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateBrackets'));
  return app;
}

describe('scoresheet (súmula)', () => {
  it('(6) árvore com formato por rodada, rodapé de regras e koto no cabeçalho', async () => {
    const PLAN = {
      phases: [
        { from_participants: null, format: 'kihon_ippon', decision: 'hantei' },
        { final: true, format: 'jyu_ippon' },
      ],
      tiebreak: ['hantei', 'central'],
      prize_places: 4,
      third_place_dispute: false,
      required_kata: 'Heians até a faixa do menos graduado',
    };
    const client = {
      query: jest.fn((sql, params) => {
        const s = String(sql);
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({});
        if (/FROM karate_competitions/i.test(s)) {
          return Promise.resolve({ rows: [{ id: COMP_ID, name: 'Paulista 2026', season: 2026, event_date: '2026-08-22', location: 'Barueri' }] });
        }
        if (/FROM karate_competition_categories cat/i.test(s)) {
          return Promise.resolve({ rows: [{ id: CAT_1, name: 'Kumite Mirim Masc', modality: 'kumite', group_label: 'Grupo 2', division_name: 'Aspirantes', area_name: 'Koto C' }] });
        }
        if (/FROM karate_competition_entries e/i.test(s)) {
          return Promise.resolve({ rows: [
            { id: ENTRY_A, student_id: 's1', team_id: null, dojo_id: null, student_name: 'Aka Atleta', dojo_name: 'Kondei' },
            { id: ENTRY_B, student_id: 's2', team_id: null, dojo_id: null, student_name: 'Shiro Atleta', dojo_name: 'Areikan' },
          ] });
        }
        if (/FROM karate_brackets WHERE category_id/i.test(s)) {
          return Promise.resolve({ rows: [{
            id: 'br-1', modality: 'kumite', status: 'locked', draw_seed: 's',
            options: { thirdPlace: false }, phase_plan: PLAN, kata_mode: null,
          }] });
        }
        if (/FROM karate_bracket_matches/i.test(s)) {
          return Promise.resolve({ rows: [{
            bracket_id: 'br-1', round: 0, slot: 0, bracket_kind: 'main',
            aka_entry_id: ENTRY_A, shiro_entry_id: ENTRY_B, winner_entry_id: ENTRY_A,
            is_bye: false, aka_score: 2, shiro_score: 0,
            match_format: 'jyu_ippon', decision: { method: 'hantei', votes_aka: 4, votes_shiro: 1 },
          }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    db.connect.mockResolvedValue(client);

    const res = await request(buildBracketsApp())
      .get(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_1}/scoresheet`)
      .set('Authorization', 'Bearer ' + adminToken);

    expect(res.status).toBe(200);
    // Cabeçalho: competição + categoria com divisão/grupo + KOTO.
    expect(res.body.competition.name).toBe('Paulista 2026');
    expect(res.body.category.division_name).toBe('Aspirantes');
    expect(res.body.area.name).toBe('Koto C');
    expect(res.body.fields.koto).toBe('Koto C');
    expect(res.body.fields.shuchin).toBeNull();
    // Rodada única = Final → fase final:true (jyu_ippon).
    expect(res.body.rounds).toHaveLength(1);
    expect(res.body.rounds[0].label).toBe('Final');
    expect(res.body.rounds[0].format).toBe('jyu_ippon');
    // Luta carrega decisão registrada + campeão resolvido.
    const match = res.body.rounds[0].matches[0];
    expect(match.decision).toEqual({ method: 'hantei', votes_aka: 4, votes_shiro: 1 });
    expect(res.body.champion.name).toBe('Aka Atleta');
    // Rodapé de regras: desempate com rótulos + aviso de 3º lugar.
    expect(res.body.rules_footer.tiebreak).toEqual(['Hantei (bandeiras)', 'Decisão do árbitro central']);
    expect(res.body.rules_footer.third_place_note).toMatch(/NÃO TEM DISPUTA/);
    expect(res.body.rules_footer.required_kata).toMatch(/menos graduado/);
  });
});
