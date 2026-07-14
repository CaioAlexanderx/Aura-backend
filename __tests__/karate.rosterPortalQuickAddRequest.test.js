// ============================================================
// AURA KARATÊ — H2: quick-add do portal do sensei vira SOLICITAÇÃO
//
// Regra fechada com o Caio: o número de matrícula FPKT é emitido SOMENTE
// pela federação, fora do sistema (H1, migration 231). O quick-add do
// portal do sensei (POST /public/roster-update/:token/practitioner) era
// o único caminho que ainda inventava um número via
// nextPractitionerRegistrationNumber (removida de karateService.js).
//
// Esta cobertura prova que:
//   (a) o quick-add NUNCA mais insere direto em `customers` — cria uma
//       linha em karate_practitioner_requests (status pendente, sem
//       número), a MESMA tabela do fluxo novo do sensei (H1)
//   (b) é idempotente (mesma dedup_key = dojô + nome) — reenvio não
//       duplica solicitação pendente
//   (c) token expirado continua bloqueando (410), sem tocar em nenhuma
//       tabela de praticante
//
// Estilo: supertest + mock sequencial de db.connect (mesmo padrão de
// __tests__/karate.rosterPortalScale.test.js).
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

const TOKEN = 'sensei-token-abc123';
const DOJO_ID = 'dojo-uuid-001';
const FED_ID = 'fed-uuid-001';
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 1000).toISOString();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/public/roster-update', require('../src/routes/karateRosterPortalPublic'));
  return app;
}

describe('POST /public/roster-update/:token/practitioner — H2: vira solicitação, não inventa número', () => {
  it('(a) 201 cria solicitação pendente em karate_practitioner_requests — NUNCA insere em customers/belt_history', (done) => {
    const app = buildApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: FUTURE }] }) // tokRes FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 'req-001', status: 'pendente', created_at: '2026-07-14T12:00:00Z' }] }) // INSERT karate_practitioner_requests
      .mockResolvedValueOnce({}) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [] }) // INSERT karate_dojo_roster_events
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    request(app)
      .post(`/public/roster-update/${TOKEN}/practitioner`)
      .send({ name: 'Novo Aluno', phone: '11999998888', belt_level: '5', belt_name: 'Faixa Amarela' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.id).toBe('req-001');
        expect(res.body.status).toBe('pendente');
        expect(res.body.already_pending).toBe(false);

        const allSql = mockClient.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : '')).join('\n');
        expect(allSql).toMatch(/INSERT INTO karate_practitioner_requests/);
        expect(allSql).not.toMatch(/INSERT INTO customers/i);
        expect(allSql).not.toMatch(/INSERT INTO karate_belt_history/i);

        // dojo_id/federation_id do INSERT vieram do TOKEN (tokRes), nunca do body
        const insertCall = mockClient.query.mock.calls.find(
          (c) => typeof c[0] === 'string' && /INSERT INTO karate_practitioner_requests/.test(c[0])
        );
        expect(insertCall[1][0]).toBe(FED_ID);
        expect(insertCall[1][1]).toBe(DOJO_ID);
        done();
      });
  });

  it('(b) idempotente: solicitação pendente igual já existe → 200 already_pending, não duplica', (done) => {
    const app = buildApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: FUTURE }] }) // tokRes
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT DO NOTHING → colidiu
      .mockResolvedValueOnce({ rows: [{ id: 'req-existing-1', status: 'pendente', created_at: '2026-07-10T00:00:00Z' }] }) // SELECT existente
      .mockResolvedValueOnce({}) // SAVEPOINT
      .mockResolvedValueOnce({ rows: [] }) // INSERT roster event
      .mockResolvedValueOnce({}) // RELEASE SAVEPOINT
      .mockResolvedValueOnce({}); // COMMIT

    request(app)
      .post(`/public/roster-update/${TOKEN}/practitioner`)
      .send({ name: 'Aluno Repetido', email: 'x@x.com', belt_level: '3' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.already_pending).toBe(true);
        expect(res.body.id).toBe('req-existing-1');
        done();
      });
  });

  it('(c) token expirado → 410, nenhuma tabela de praticante é tocada', (done) => {
    const app = buildApp();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rows: [{ dojo_id: DOJO_ID, federation_id: FED_ID, token_expires_at: PAST }] }) // tokRes expirado
      .mockResolvedValueOnce({}); // ROLLBACK

    request(app)
      .post(`/public/roster-update/${TOKEN}/practitioner`)
      .send({ name: 'Aluno Tarde', phone: '11988887777', belt_level: '1' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(410);
        expect(mockClient.query).toHaveBeenCalledTimes(3); // BEGIN, tokRes, ROLLBACK
        done();
      });
  });
});
