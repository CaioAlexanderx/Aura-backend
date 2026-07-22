// ============================================================
// AURA KARATÊ — Testes: GET /belt-distribution (segmentação por is_active
// do PRATICANTE) + GET /search (is_active exposto sem filtrar).
//
// Auditoria ativo/inativo (21/07/2026, Caio: "não podemos cobrar e
// controlar os inativos [...] sempre ativos primeiro"):
//   1. GET /belt-distribution é o endpoint dedicado (consumidor irmão do
//      card "Praticantes por graduação" do dashboard) — precisa aceitar o
//      MESMO parâmetro `?status=active|inactive|all` com o MESMO default
//      'active', senão painel e endpoint dedicado divergem no mesmo número.
//   2. GET /search (busca rápida) NÃO filtra por is_active (baixo impacto,
//      comportamento preservado) mas passa a expor `is_active` em cada
//      resultado (dojô e praticante) pro FE marcar visualmente "inativo".
//
// jest.setup.js já mocka src/config/database (db.query = jest.fn()).
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const adminToken = jwt.sign(
  { id: 'user-test-uuid', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

const FED_ID = 'fed-uuid-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  const fedRouter = require('../src/routes/karateFederation');
  app.use('/federation/:id', fedRouter);
  return app;
}

describe('GET /federation/:id/belt-distribution — segmentação por is_active', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('default (sem ?status): filtra c.is_active = ANY([true])', (done) => {
    db.query.mockResolvedValueOnce({ rows: [] });
    request(app)
      .get(`/federation/${FED_ID}/belt-distribution`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        const call = db.query.mock.calls[0];
        expect(call[0]).toMatch(/c\.is_active = ANY\(\$2::boolean\[\]\)/);
        expect(call[1]).toEqual([FED_ID, [true]]);
        done();
      });
  });

  it('?status=inactive: filtra c.is_active = ANY([false])', (done) => {
    db.query.mockResolvedValueOnce({ rows: [] });
    request(app)
      .get(`/federation/${FED_ID}/belt-distribution?status=inactive`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        const call = db.query.mock.calls[0];
        expect(call[1]).toEqual([FED_ID, [false]]);
        done();
      });
  });

  it('?status=all: sem filtro (só $1)', (done) => {
    db.query.mockResolvedValueOnce({ rows: [] });
    request(app)
      .get(`/federation/${FED_ID}/belt-distribution?status=all`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        const call = db.query.mock.calls[0];
        expect(call[0]).not.toMatch(/is_active/);
        expect(call[1]).toEqual([FED_ID]);
        done();
      });
  });

  it('?status inválido -> 422 VALIDATION_ERROR, nenhuma query dispara', (done) => {
    request(app)
      .get(`/federation/${FED_ID}/belt-distribution?status=nope`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('VALIDATION_ERROR');
        expect(db.query).not.toHaveBeenCalled();
        done();
      });
  });

  it('mesmo default de GET /dashboard — array de counts preservado (contrato inalterado)', (done) => {
    db.query.mockResolvedValueOnce({
      rows: [{ belt_level: 'branca', belt_name: 'Branca', count: '5' }],
    });
    request(app)
      .get(`/federation/${FED_ID}/belt-distribution`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
          { belt_level: 'branca', belt_name: 'Branca', count: 5, rank: 10 },
        ]);
        done();
      });
  });
});

describe('GET /federation/:id/search — is_active exposto (sem filtrar)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('devolve is_active=true/false por dojô e por praticante, misturando ativos e inativos', (done) => {
    db.query
      // dojoRes
      .mockResolvedValueOnce({
        rows: [
          { id: 'dojo-1', name: 'Dojô Ativo', fpkt_affiliation_id: 'F1', region: 'SP', is_active: true, practitioner_count: 10 },
          { id: 'dojo-2', name: 'Dojô Inativo', fpkt_affiliation_id: 'F2', region: 'SP', is_active: false, practitioner_count: 3 },
        ],
      })
      // practRes
      .mockResolvedValueOnce({
        rows: [
          { id: 'p-1', full_name: 'Praticante Ativo', karate_registration_number: '001', dojo_name: 'Dojô Ativo', belt_name: 'Branca', is_active: true },
          { id: 'p-2', full_name: 'Praticante Inativo', karate_registration_number: '002', dojo_name: 'Dojô Ativo', belt_name: 'Amarela', is_active: false },
        ],
      });

    request(app)
      .get(`/federation/${FED_ID}/search?q=pra`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.dojos).toEqual([
          expect.objectContaining({ id: 'dojo-1', is_active: true }),
          expect.objectContaining({ id: 'dojo-2', is_active: false }),
        ]);
        expect(res.body.practitioners).toEqual([
          expect.objectContaining({ id: 'p-1', is_active: true }),
          expect.objectContaining({ id: 'p-2', is_active: false }),
        ]);
        // comportamento de busca preservado: SELECT não ganhou filtro de is_active
        const dojoCall = db.query.mock.calls[0];
        const practCall = db.query.mock.calls[1];
        expect(dojoCall[0]).not.toMatch(/WHERE[\s\S]*is_active/);
        expect(practCall[0]).not.toMatch(/WHERE[\s\S]*cu\.is_active\s*=/);
        done();
      });
  });

  it('is_active ausente/NULL no row é tratado como ativo (!== false)', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'dojo-3', name: 'Dojô X', fpkt_affiliation_id: null, region: null, is_active: null, practitioner_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    request(app)
      .get(`/federation/${FED_ID}/search?q=xx`)
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.dojos[0].is_active).toBe(true);
        done();
      });
  });
});
