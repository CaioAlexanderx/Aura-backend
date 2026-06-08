// ============================================================
// AURA KARATÊ — Testes unitários Track E (competições + ranking)
//
// Cobertura:
//   1. Criar competição → 201 / 422 sem name
//   2. Criar categoria → 201 / 422 modality inválida
//   3. Inscrever atleta inelegivel → 201 + category_fit (aviso, FPKT #1)
//   4. Lançar resultado → 200
//   5. Concluir competição → 200 / 409 quando já concluída
//   6. Ranking de temporada (view) → 200
//
// Mocks Jest (mesmo padrão do Track C):
//   - Ordem dos mocks = ordem real das queries.
//   - afterEach: db.query.mockReset() + db.connect.mockReset().
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/karateCompetitionService');

const db = require('../src/config/database');
const { checkCategoryFit } = require('../src/services/karateCompetitionService');

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

const makeToken = (overrides) => jwt.sign(
  Object.assign({ id: 'user-test-uuid', role: 'admin', plan: 'expansao' }, overrides || {}),
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);
const adminToken = makeToken();

const FED_ID  = 'fed-uuid-001';
const COMP_ID = 'comp-uuid-001';
const CAT_ID  = 'cat-uuid-001';
const STU_ID  = 'student-uuid-001';
const ENTRY_ID = 'entry-uuid-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateCompetitions'));
  return app;
}

// ── Suite 1: Criar competição ──
describe('POST /federation/:id/competitions', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: COMP_ID, federation_id: FED_ID, name: 'Copa Interior 2026',
        season: 2026, event_date: '2026-10-10', location: 'Jacareí/SP',
        circuit_round: 1, fee_amount: 60, status: 'draft',
        created_at: new Date().toISOString(),
      }],
    });
  });

  it('cria competição e retorna 201 status=draft', (done) => {
    request(app)
      .post('/federation/' + FED_ID + '/competitions')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Copa Interior 2026', season: 2026, event_date: '2026-10-10', location: 'Jacareí/SP', circuit_round: 1, fee_amount: 60 })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.id).toBe(COMP_ID);
        expect(res.body.status).toBe('draft');
        expect(res.body.season).toBe(2026);
        expect(res.body.category_count).toBe(0);
        done();
      });
  });

  it('retorna 422 sem name', (done) => {
    jest.clearAllMocks();
    request(app)
      .post('/federation/' + FED_ID + '/competitions')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ season: 2026 })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/name/);
        done();
      });
  });
});

// ── Suite 2: Criar categoria ──
describe('POST /competitions/:cid/categories', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    jest.clearAllMocks();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: COMP_ID, federation_id: FED_ID, status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{
        id: CAT_ID, competition_id: COMP_ID, name: 'Kata Adulto Faixa Preta Masc',
        modality: 'kata', min_age: 18, max_age: 34, belt_min: '1dan', belt_max: '8dan',
        sex: 'M', weight_class: null, max_entries: 32, fee_amount: null,
        created_at: new Date().toISOString(),
      }] });
  });

  it('cria categoria e retorna 201', (done) => {
    request(app)
      .post('/federation/' + FED_ID + '/competitions/' + COMP_ID + '/categories')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'Kata Adulto Faixa Preta Masc', modality: 'kata', min_age: 18, max_age: 34, belt_min: '1dan', belt_max: '8dan', sex: 'M', max_entries: 32 })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.id).toBe(CAT_ID);
        expect(res.body.modality).toBe('kata');
        expect(res.body.entry_count).toBe(0);
        done();
      });
  });

  it('retorna 422 com modality inválida', (done) => {
    jest.clearAllMocks();
    request(app)
      .post('/federation/' + FED_ID + '/competitions/' + COMP_ID + '/categories')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ name: 'X', modality: 'boxe' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/modality/);
        done();
      });
  });
});

// ── Suite 3: Inscrever atleta — category_fit é só AVISO (FPKT #1) ──
describe('POST /competitions/:cid/entries — categoria incompatível é só aviso', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    jest.clearAllMocks();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);
    // Ordem: BEGIN → comp → category → student → lock → dup(vazio) → INSERT → COMMIT
    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ id: COMP_ID, status: 'open', event_date: '2026-10-10' }] })
      .mockResolvedValueOnce({ rows: [{ id: CAT_ID, name: 'Kata', modality: 'kata', min_age: 18, max_age: 34, belt_min: '1dan', belt_max: '8dan', sex: 'M', max_entries: null }] })
      .mockResolvedValueOnce({ rows: [{ id: STU_ID, name: 'Bruno Tanaka', birth_date: '2015-01-01', gender: 'M', dojo_id: 'dojo-1', current_belt: '7kyu' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: ENTRY_ID, competition_id: COMP_ID, category_id: CAT_ID, student_id: STU_ID, dojo_id: 'dojo-1', status: 'registered', created_at: new Date().toISOString() }] })
      .mockResolvedValueOnce({});

    checkCategoryFit.mockReturnValue({
      fits: false,
      is_hard_block: false,
      checks: [
        { criterion: 'age', ok: false, required: { min: 18, max: 34 }, actual: 11, unit: 'anos' },
        { criterion: 'belt', ok: false, required: { min: '1dan', max: '8dan' }, actual: '7kyu', unit: null },
      ],
      warnings: ['Categoria pode não corresponder ao critério de faixa etária do atleta.'],
    });
  });

  it('SEMPRE 201 mesmo incompatível — category_fit é só aviso (FPKT #1)', (done) => {
    request(app)
      .post('/federation/' + FED_ID + '/competitions/' + COMP_ID + '/entries')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ student_id: STU_ID, category_id: CAT_ID })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.id).toBe(ENTRY_ID);
        expect(res.body.status).toBe('registered');
        expect(res.body.category_fit).toBeDefined();
        expect(res.body.category_fit.fits).toBe(false);
        expect(res.body.category_fit.is_hard_block).toBe(false);
        expect(Array.isArray(res.body.category_fit.checks)).toBe(true);
        done();
      });
  });

  it('retorna 422 sem student_id', (done) => {
    jest.clearAllMocks();
    request(app)
      .post('/federation/' + FED_ID + '/competitions/' + COMP_ID + '/entries')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ category_id: CAT_ID })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/student_id/);
        done();
      });
  });
});

// ── Suite 4: Lançar resultado ──
describe('PATCH /competitions/:cid/entries/:eid (lançar resultado)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    jest.clearAllMocks();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: COMP_ID, federation_id: FED_ID, status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{
        id: ENTRY_ID, competition_id: COMP_ID, category_id: CAT_ID, student_id: STU_ID,
        status: 'done', placement: 1, points_awarded: 100, result_notes: 'Ouro',
        updated_at: new Date().toISOString(),
      }] });
  });

  it('lança colocação/pontos e retorna 200', (done) => {
    request(app)
      .patch('/federation/' + FED_ID + '/competitions/' + COMP_ID + '/entries/' + ENTRY_ID)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ placement: 1, points_awarded: 100, status: 'done', result_notes: 'Ouro' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.placement).toBe(1);
        expect(res.body.points_awarded).toBe(100);
        expect(res.body.status).toBe('done');
        done();
      });
  });

  it('retorna 422 com status inválido', (done) => {
    jest.clearAllMocks();
    request(app)
      .patch('/federation/' + FED_ID + '/competitions/' + COMP_ID + '/entries/' + ENTRY_ID)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ status: 'invalido' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ── Suite 5: Concluir competição ──
describe('POST /competitions/:cid/close', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('conclui e retorna 200 status=done', (done) => {
    jest.clearAllMocks();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: COMP_ID, federation_id: FED_ID, status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ id: COMP_ID, status: 'done', updated_at: new Date().toISOString() }] });
    request(app)
      .post('/federation/' + FED_ID + '/competitions/' + COMP_ID + '/close')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('done');
        done();
      });
  });

  it('retorna 409 quando já concluída', (done) => {
    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({ rows: [{ id: COMP_ID, federation_id: FED_ID, status: 'done' }] });
    request(app)
      .post('/federation/' + FED_ID + '/competitions/' + COMP_ID + '/close')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CONFLICT');
        done();
      });
  });
});

// ── Suite 6: Ranking de temporada (view) ──
describe('GET /federation/:id/rankings', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({
      rows: [
        { category: 'Kata Adulto', student_id: STU_ID, student_name: 'Bruno Tanaka', karate_registration_number: 'FPKT-A-00001', dojo_id: 'dojo-1', dojo_name: 'Dojô Central', total_points: 250, gold: 2, silver: 1, bronze: 0, events_participated: 3 },
      ],
    });
  });

  it('retorna ranking ordenado da temporada', (done) => {
    request(app)
      .get('/federation/' + FED_ID + '/rankings?season=2026&category=Kata%20Adulto')
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.season).toBe(2026);
        expect(Array.isArray(res.body.ranking)).toBe(true);
        expect(res.body.ranking[0].total_points).toBe(250);
        expect(res.body.ranking[0].gold).toBe(2);
        done();
      });
  });
});
