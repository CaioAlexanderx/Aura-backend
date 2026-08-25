// ============================================================
// AURA KARATÊ — quantos ÁRBITROS dão nota (migration 308)
//
// A mesa desenhava 5 campos de nota sempre; categorias de base rodam com
// 3 e finais grandes com 7. O motor já apurava 3..7 — faltava dizer
// quantos são.
//
// Cobertura:
//  (1) hierarquia: categoria > competição > 5.
//  (2) a chave de kata devolve judge_count para a mesa desenhar N campos.
//  (3) PATCH valida a faixa (3..7), aceita null (volta a herdar) e sabe
//      em qual nível está mexendo (competição x categoria).
//  (4) 308 pendente: a chave assume 5 e o PATCH responde SCHEMA_PENDING —
//      config nunca derruba a competição em andamento.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

const FED = 'fed-uuid-arb';
const COMP = 'comp-uuid-arb';
const CAT = 'cat-uuid-arb';
const BRACKET = 'bracket-uuid-arb';
const E1 = 'entry-1-arb';

const token = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

function app(routerPath) {
  const a = express();
  a.use(express.json());
  a.use('/federation/:id', require(routerPath));
  return a;
}

// ── chave de kata ───────────────────────────────────────────
function mockBracket({ judgeCount = 5, erro = null } = {}) {
  db.connect.mockImplementation(() => Promise.resolve({
    query: (sql) => {
      const s = String(sql);
      if (/FROM karate_competitions WHERE id/.test(s)) return Promise.resolve({ rows: [{ id: COMP, status: 'open' }] });
      if (/COALESCE\(cat\.judge_count/.test(s)) {
        if (erro) { const e = new Error('coluna ausente'); e.code = erro; return Promise.reject(e); }
        return Promise.resolve({ rows: [{ judge_count: judgeCount }] });
      }
      if (/checked_in_at, no_show_at/.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM karate_competition_entries e/.test(s)) {
        return Promise.resolve({ rows: [{ id: E1, student_id: 's1', team_id: null, dojo_id: 'd1', student_name: 'Marina Kobayashi', dojo_name: 'Kondei' }] });
      }
      if (/FROM karate_brackets WHERE category_id/.test(s)) {
        return Promise.resolve({ rows: [{ id: BRACKET, status: 'locked', modality: 'kata', kata_mode: 'score_rounds', draw_seed: 1, options: {}, phase_plan: {} }] });
      }
      if (/FROM karate_bracket_matches/.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM karate_kata_scores ks/.test(s)) {
        return Promise.resolve({ rows: [{ entry_id: E1, student_name: 'Marina Kobayashi', dojo_name: 'Kondei', phase: 1, nota: null, presentation_order: 1, advances: null }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => {},
  }));
  db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
}

function getBracket() {
  return request(app('../src/routes/karateBrackets'))
    .get(`/federation/${FED}/competitions/${COMP}/categories/${CAT}/bracket`)
    .set('Authorization', 'Bearer ' + token);
}

// ── PATCH ───────────────────────────────────────────────────
function patch(body) {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/FROM karate_competitions/i.test(s) && /WHERE/i.test(s) && !/UPDATE/i.test(s)) {
      return Promise.resolve({ rows: [{ id: COMP, federation_id: FED, status: 'open' }] });
    }
    if (/UPDATE karate_competition_categories/i.test(s)) {
      return Promise.resolve({ rows: [{ id: CAT, judge_count: params[0] }] });
    }
    if (/UPDATE karate_competitions/i.test(s)) {
      return Promise.resolve({ rows: [{ id: COMP, judge_count: params[0] }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return request(app('../src/routes/karateCompetitionSetup'))
    .patch(`/federation/${FED}/competitions/${COMP}/judge-count`)
    .set('Authorization', 'Bearer ' + token)
    .send(body);
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

it('(1)(2) a chave de kata devolve o judge_count efetivo da categoria', async () => {
  mockBracket({ judgeCount: 7 });
  const res = await getBracket();
  expect(res.status).toBe(200);
  expect(res.body.judge_count).toBe(7);
  expect(res.body.kata_scores).toHaveLength(1);
});

it('(3) PATCH: competição x categoria, e null volta a herdar', async () => {
  const naComp = await patch({ judge_count: 3 });
  expect(naComp.status).toBe(200);
  expect(naComp.body).toMatchObject({ scope: 'competition', judge_count: 3 });

  const naCat = await patch({ judge_count: 7, category_id: CAT });
  expect(naCat.status).toBe(200);
  expect(naCat.body).toMatchObject({ scope: 'category', category_id: CAT, judge_count: 7 });

  const herda = await patch({ judge_count: null, category_id: CAT });
  expect(herda.status).toBe(200);
  expect(herda.body.judge_count).toBeNull();
});

it('(3b) PATCH recusa fora da faixa 3..7 e exige o campo', async () => {
  for (const v of [2, 8, 'cinco']) {
    const r = await patch({ judge_count: v });
    expect(r.status).toBe(422);
  }
  const vazio = await patch({});
  expect(vazio.status).toBe(400);
});

// ATENÇÃO: desliga o cache module-level HAS_JUDGE_COUNT — último do arquivo.
it('(4) 308 pendente (42703): a chave assume 5 em vez de quebrar', async () => {
  mockBracket({ erro: '42703' });
  const res = await getBracket();
  expect(res.status).toBe(200);
  expect(res.body.judge_count).toBe(5);
});
