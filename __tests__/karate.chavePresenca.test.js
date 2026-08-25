// ============================================================
// AURA KARATÊ — P2: PRESENÇA do atleta viaja na chave
//
// A chamada do koto precisa saber quem não veio SEM sair da tela da
// chave. A migration 305 já grava checked_in_at/no_show_at na inscrição;
// faltava a chave carregar isso.
//
// Cobertura:
//  (1) kumite: cada lado (aka/shiro) carrega checked_in e no_show.
//  (2) kata: cada linha da bateria carrega os mesmos campos.
//  (3) SEM INFORMAÇÃO ≠ AUSENTE: inscrição com as duas colunas NULL sai
//      com no_show=false (o badge de ausente não pode aparecer sozinho).
//  (4) 305 pendente (42703): degrada para a chave de sempre — 200, sem
//      os campos de presença, nunca 500.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

const FED = 'fed-uuid-presenca';
const COMP = 'comp-uuid-presenca';
const CAT = 'cat-uuid-presenca';
const BRACKET = 'bracket-uuid-presenca';
const E1 = 'entry-1-presenca'; // credenciado
const E2 = 'entry-2-presenca'; // ausência confirmada
const E3 = 'entry-3-presenca'; // sem informação

const token = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateBrackets'));
  return app;
}

const ENTRIES = [
  { id: E1, student_id: 's1', team_id: null, dojo_id: 'd1', student_name: 'Marina Kobayashi', dojo_name: 'Kondei' },
  { id: E2, student_id: 's2', team_id: null, dojo_id: 'd1', student_name: 'Rafael Tanaka', dojo_name: 'Kondei' },
  { id: E3, student_id: 's3', team_id: null, dojo_id: 'd2', student_name: 'Beatriz Souza', dojo_name: 'Finesse' },
];

const PRESENCA = [
  { id: E1, checked_in_at: '2026-08-22T12:00:00Z', no_show_at: null },
  { id: E2, checked_in_at: null, no_show_at: '2026-08-22T13:30:00Z' },
  { id: E3, checked_in_at: null, no_show_at: null },
];

// modality: 'kumite' | 'kata'. presencaErro: código PG para simular a 305 pendente.
function mockClient({ modality = 'kumite', presencaErro = null } = {}) {
  db.connect.mockImplementation(() => Promise.resolve({
    query: (sql) => {
      const s = String(sql);
      if (/FROM karate_competitions WHERE id/.test(s)) return Promise.resolve({ rows: [{ id: COMP, status: 'open' }] });
      if (/checked_in_at, no_show_at/.test(s)) {
        if (presencaErro) { const e = new Error('coluna ausente'); e.code = presencaErro; return Promise.reject(e); }
        return Promise.resolve({ rows: PRESENCA });
      }
      if (/FROM karate_competition_entries e/.test(s)) return Promise.resolve({ rows: ENTRIES });
      if (/FROM karate_brackets WHERE category_id/.test(s)) {
        return Promise.resolve({ rows: [{
          id: BRACKET, status: 'locked', modality, kata_mode: modality === 'kata' ? 'score_rounds' : null,
          draw_seed: 1, options: {}, phase_plan: {},
        }] });
      }
      if (/FROM karate_bracket_matches/.test(s)) {
        return Promise.resolve({ rows: modality === 'kumite' ? [{
          id: 'm1', bracket_id: BRACKET, round: 0, slot: 0, bracket_kind: 'main',
          aka_entry_id: E1, shiro_entry_id: E2, winner_entry_id: null, is_bye: false,
          aka_score: null, shiro_score: null,
        }] : [] });
      }
      if (/FROM karate_kata_scores ks/.test(s)) {
        return Promise.resolve({ rows: [
          { entry_id: E1, student_name: 'Marina Kobayashi', dojo_name: 'Kondei', phase: 1, nota: null, presentation_order: 1, advances: null },
          { entry_id: E2, student_name: 'Rafael Tanaka', dojo_name: 'Kondei', phase: 1, nota: null, presentation_order: 2, advances: null },
          { entry_id: E3, student_name: 'Beatriz Souza', dojo_name: 'Finesse', phase: 1, nota: null, presentation_order: 3, advances: null },
        ] });
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => {},
  }));
  db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
}

function get() {
  return request(buildApp())
    .get(`/federation/${FED}/competitions/${COMP}/categories/${CAT}/bracket`)
    .set('Authorization', 'Bearer ' + token);
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

it('(1)(3) kumite: aka credenciado, shiro ausente; sem informação não vira ausente', async () => {
  mockClient({ modality: 'kumite' });
  const res = await get();
  expect(res.status).toBe(200);
  const m = res.body.rounds[0][0];
  expect(m.aka).toMatchObject({ entry_id: E1, checked_in: true, no_show: false });
  expect(m.shiro).toMatchObject({ entry_id: E2, checked_in: false, no_show: true });
});

it('(2)(3) kata: a bateria carrega presença, e o sem-informação sai com no_show=false', async () => {
  mockClient({ modality: 'kata' });
  const res = await get();
  expect(res.status).toBe(200);
  const byId = Object.fromEntries(res.body.kata_scores.map((k) => [k.entry_id, k]));
  expect(byId[E1]).toMatchObject({ checked_in: true, no_show: false });
  expect(byId[E2]).toMatchObject({ checked_in: false, no_show: true });
  // Sem informação: nem credenciado nem ausente — o badge não aparece.
  expect(byId[E3]).toMatchObject({ checked_in: false, no_show: false });
});

// ATENÇÃO: este caso desliga o cache module-level HAS_CHECKIN para o
// resto do arquivo — por isso é o ÚLTIMO teste.
it('(4) migration 305 pendente (42703) → chave normal, sem 500', async () => {
  mockClient({ modality: 'kumite', presencaErro: '42703' });
  const res = await get();
  expect(res.status).toBe(200);
  const m = res.body.rounds[0][0];
  expect(m.aka.entry_id).toBe(E1);
  expect(m.aka.student_name).toBe('Marina Kobayashi');
  expect(m.aka.no_show).toBe(false); // nunca marca ausente sem saber
});
