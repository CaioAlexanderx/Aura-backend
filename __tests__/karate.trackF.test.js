// ============================================================
// AURA KARATÊ — Testes unitários Track F (conectividade dojô)
//
// Cobertura:
//   1. Criar conexão manual → 201 connected / 422 via inválida
//   2. Aprovar conexão native → 200 + sync_token (claro 1x)
//   3. Listar conexões → 200 com counts
//   4. Recusar conexão → 200 revoked
//
// Mocks Jest (padrão Track C/E): ordem dos mocks = ordem real das queries.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/karateSyncService', () => ({
  generateSyncToken: jest.fn(() => ({ token: 'tok_plain_123', hash: 'hash_x', prefix: 'tok_plai' })),
  maskToken: (p) => (p ? `${p}••••` : null),
  verifyToken: jest.fn(() => true),
  hashToken: jest.fn((t) => 'hash' + t),
  verifyHmac: jest.fn(() => true),
}));

const db = require('../src/config/database');

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const makeToken = (o) => jwt.sign(Object.assign({ id: 'user-test-uuid', role: 'admin', plan: 'expansao' }, o || {}), 'aura-test-secret-2026', { expiresIn: '1h' });
const adminToken = makeToken();

const FED_ID = 'fed-uuid-001';
const DOJO_ID = 'dojo-uuid-001';
const CONN_ID = 'conn-uuid-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateConnections'));
  return app;
}

const connRow = (over) => Object.assign({
  id: CONN_ID, federation_id: FED_ID, dojo_id: DOJO_ID, dojo_name: 'Dojô Shotokan Jacareí',
  fpkt_affiliation_id: 'FPKT-014', via: 'manual', status: 'connected',
  sync_token_prefix: null, token_rotated_at: null, connected_at: new Date().toISOString(),
  last_sync_at: null, last_sync_status: null, adapter_cpf_matched: null, adapter_cpf_pending: null,
  notes: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
}, over || {});

// ── Suite 1: criar conexão ─────────────────────────────────
describe('POST /federation/:id/connections', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('cria conexão manual e retorna 201 connected', (done) => {
    jest.clearAllMocks();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: DOJO_ID }] })          // SELECT companies (dojo existe)
      .mockResolvedValueOnce({ rows: [{ id: CONN_ID }] })          // INSERT RETURNING id
      .mockResolvedValueOnce({ rows: [connRow()] });               // SELECT_CONN detalhe
    request(app)
      .post('/federation/' + FED_ID + '/connections')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ dojo_id: DOJO_ID, via: 'manual' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.via).toBe('manual');
        expect(res.body.status).toBe('connected');
        done();
      });
  });

  it('retorna 422 com via inválida', (done) => {
    jest.clearAllMocks();
    request(app)
      .post('/federation/' + FED_ID + '/connections')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ dojo_id: DOJO_ID, via: 'telepatia' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/via/);
        done();
      });
  });
});

// ── Suite 2: aprovar conexão native → gera token ─────────────
describe('POST /connections/:connId/approve (native gera token)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('aprova native e retorna 200 + sync_token (claro 1x)', (done) => {
    jest.clearAllMocks();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);
    db.query
      .mockResolvedValueOnce({ rows: [connRow({ via: 'native', status: 'pending', connected_at: null })] })
      .mockResolvedValueOnce({ rows: [connRow({ via: 'native', status: 'connected', sync_token_prefix: 'tok_plai' })] });
    mockClient.query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    request(app)
      .post('/federation/' + FED_ID + '/connections/' + CONN_ID + '/approve')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('connected');
        expect(res.body.sync_token).toBe('tok_plain_123');
        done();
      });
  });

  it('retorna 409 se já estiver conectada', (done) => {
    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({ rows: [connRow({ via: 'native', status: 'connected' })] });
    request(app)
      .post('/federation/' + FED_ID + '/connections/' + CONN_ID + '/approve')
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

// ── Suite 3: listar conexões ─────────────────────────────
describe('GET /federation/:id/connections', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('retorna lista + counts', (done) => {
    jest.clearAllMocks();
    db.query
      .mockResolvedValueOnce({ rows: [connRow(), connRow({ id: 'c2', via: 'native', status: 'pending' })] })
      .mockResolvedValueOnce({ rows: [{ status: 'connected', n: 1 }, { status: 'pending', n: 1 }] });
    request(app)
      .get('/federation/' + FED_ID + '/connections')
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.data)).toBe(true);
        expect(res.body.data.length).toBe(2);
        expect(res.body.counts.connected).toBe(1);
        done();
      });
  });
});

// ── Suite 4: recusar conexão ────────────────────────────
describe('POST /connections/:connId/reject', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('revoga e retorna 200 status=revoked', (done) => {
    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({ rows: [{ id: CONN_ID }] });
    request(app)
      .post('/federation/' + FED_ID + '/connections/' + CONN_ID + '/reject')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('revoked');
        done();
      });
  });
});
