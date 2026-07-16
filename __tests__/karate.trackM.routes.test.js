// ============================================================
// AURA KARATÊ — Track M (rotas HTTP): edição total de chave
//
// Cobertura (guards de negócio mais determinísticos, mesmo padrão de
// mock do Track C — ordem dos mocks = ordem real das queries):
//   1. PUT  .../bracket/matches  → 409 quando bracket status='locked'
//   2. POST .../bracket/reset    → 409 quando bracket status='locked'
//   3. POST .../bracket/unlock   → 200 status=draft quando estava locked
//   4. POST .../bracket/unlock   → 409 quando não há chave locked
//
// NOTA: os testes puros da lógica de bracket (geração, avanço, seed
// determinístico) ficam em karate.trackM.test.js. Este arquivo cobre só
// o roteamento HTTP + transação das rotas novas da Fase 1 (edição total).
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');

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

const FED_ID    = 'fed-uuid-001';
const COMP_ID   = 'comp-uuid-001';
const CAT_ID    = 'cat-uuid-001';
const BRACKET_ID = 'bracket-uuid-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateBrackets'));
  return app;
}

// ── Suite 1: PUT /bracket/matches — 409 quando locked ──
describe('PUT /competitions/:cid/categories/:catId/bracket/matches', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('retorna 409 e não aplica nada quando bracket está locked', (done) => {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    // req.user.role === 'admin' → requireCompanyAccess não consulta o banco.
    // Ordem real da rota: BEGIN → findComp → findCat → loadBracket (karate_brackets) → ROLLBACK
    mockClient.query
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: COMP_ID, status: 'open' }] })   // findComp
      .mockResolvedValueOnce({ rows: [{ id: CAT_ID, modality: 'kumite' }] }) // findCat
      .mockResolvedValueOnce({ rows: [{ id: BRACKET_ID, status: 'locked', modality: 'kumite', options: {}, draw_seed: '1' }] }) // loadBracket: SELECT karate_brackets
      .mockResolvedValueOnce({})                                  // ROLLBACK
      ;

    request(app)
      .put(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket/matches`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ matches: [{ id: 'r0-0', winner_entry_id: 'entry-1' }] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('Destrave a chave para editar.');
        done();
      });
  });

  it('retorna 422 quando matches não é enviado', (done) => {
    request(app)
      .put(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket/matches`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ── Suite 2: POST /bracket/reset — 409 quando locked ──
describe('POST /competitions/:cid/categories/:catId/bracket/reset', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('retorna 409 e não aplica nada quando bracket está locked', (done) => {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    // Ordem real da rota: BEGIN → findComp → loadBracket (karate_brackets) → ROLLBACK
    mockClient.query
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: COMP_ID, status: 'open' }] })   // findComp
      .mockResolvedValueOnce({ rows: [{ id: BRACKET_ID, status: 'locked', modality: 'kumite', options: {}, draw_seed: '1' }] }) // loadBracket
      .mockResolvedValueOnce({})                                  // ROLLBACK
      ;

    request(app)
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket/reset`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('Destrave a chave para editar.');
        done();
      });
  });
});

// ── Suite 3: POST /bracket/unlock ──
describe('POST /competitions/:cid/categories/:catId/bracket/unlock', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('destrava (locked→draft) e retorna 200 status=draft', (done) => {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    // Ordem real da rota: BEGIN → findComp → UPDATE karate_brackets (RETURNING) → COMMIT
    mockClient.query
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: COMP_ID, status: 'open' }] })   // findComp
      .mockResolvedValueOnce({ rows: [{ id: BRACKET_ID, status: 'draft' }] }) // UPDATE ... RETURNING
      .mockResolvedValueOnce({})                                  // COMMIT
      ;

    request(app)
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket/unlock`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('draft');
        done();
      });
  });

  it('retorna 409 quando não há chave locked para destravar', (done) => {
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: COMP_ID, status: 'open' }] })   // findComp
      .mockResolvedValueOnce({ rows: [] })                        // UPDATE ... RETURNING (nada afetado)
      .mockResolvedValueOnce({})                                  // ROLLBACK
      ;

    request(app)
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/categories/${CAT_ID}/bracket/unlock`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        done();
      });
  });
});
