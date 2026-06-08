// ============================================================
// AURA KARATÊ — Testes unitários Track D (Carteirinha + Portal)
// Cobertura mínima:
//   1. Carteirinha: emissão (POST issue-card) processa dados
//   2. Verify público: dados mínimos; MENORES reduzidos (LGPD)
//   3. effectiveStatus: active|revoked (carteirinha SEM validade por tempo)
//   4. Portal: token type:'portal' roundtrip; verify rejeita token alheio
//   5. Portal verify-otp: 404 quando federação não encontrada
//
// jest.setup.js já mocka src/config/database (db.query/db.connect = jest.fn).
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

const cardService = require('../src/services/karateCardService');
const portalAuth  = require('../src/services/karatePortalAuthService');

const adminToken = jwt.sign(
  { id: 'user-test-uuid', role: 'admin', plan: 'expansao' },
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateCards'));
  app.use('/public/karate', require('../src/routes/karatePublic'));
  return app;
}

// ── Lógica pura ──────────────────────────────────────────────
describe('karateCardService — computeIsMinor', () => {
  it('detecta menor de idade', () => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 10);
    expect(cardService.computeIsMinor(d.toISOString().split('T')[0])).toBe(true);
  });
  it('detecta adulto', () => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 30);
    expect(cardService.computeIsMinor(d.toISOString().split('T')[0])).toBe(false);
  });
  it('birth_date nulo → não é menor', () => {
    expect(cardService.computeIsMinor(null)).toBe(false);
  });
});

describe('karateCardService — effectiveStatus (sem validade por tempo)', () => {
  it('active permanece active', () => {
    expect(cardService.effectiveStatus({ status: 'active' })).toBe('active');
  });
  it('revoked permanece revoked', () => {
    expect(cardService.effectiveStatus({ status: 'revoked' })).toBe('revoked');
  });
});

// ── Verify público (LGPD) ────────────────────────────────────
describe('karateCardService — verifyByToken', () => {
  const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // 32 hex

  beforeEach(() => jest.clearAllMocks());

  it('token malformado → null (sem consultar DB)', async () => {
    const r = await cardService.verifyByToken('not a token!');
    expect(r).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('menor → display_name é só primeiro nome e card_number null', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      card_number: 'FPKT-A-00001', belt_snapshot: '3kyu', belt_name_snapshot: 'Marrom',
      dojo_name_snapshot: 'Dojô X', is_minor: true, status: 'active',
      student_name: 'João Pedro Silva', federation_name: 'FPKT', federation_logo: null,
    }] });
    const r = await cardService.verifyByToken(TOKEN);
    expect(r.valid).toBe(true);
    expect(r.display_name).toBe('João');
    expect(r.card_number).toBeNull();
    expect(r.belt_name).toBe('Marrom');
  });

  it('adulto → nome completo e card_number presente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      card_number: 'FPKT-A-00002', belt_snapshot: '1dan', belt_name_snapshot: 'Preta',
      dojo_name_snapshot: 'Dojô Y', is_minor: false, status: 'active',
      student_name: 'Maria Souza', federation_name: 'FPKT', federation_logo: null,
    }] });
    const r = await cardService.verifyByToken(TOKEN);
    expect(r.display_name).toBe('Maria Souza');
    expect(r.card_number).toBe('FPKT-A-00002');
  });
});

// ── Token de portal ──────────────────────────────────────────
describe('karatePortalAuthService — token de portal', () => {
  it('sign → verify roundtrip preserva ids', () => {
    const t = portalAuth.signPortalToken({ practitionerId: 'p1', federationId: 'f1' });
    const d = portalAuth.verifyPortalToken(t);
    expect(d.practitioner_id).toBe('p1');
    expect(d.federation_id).toBe('f1');
    expect(d.type).toBe('portal');
  });

  it('rejeita token que não é de portal', () => {
    const alien = jwt.sign({ id: 'u', role: 'admin' }, 'aura-test-secret-2026');
    expect(() => portalAuth.verifyPortalToken(alien)).toThrow();
  });
});

// ── Rotas HTTP ───────────────────────────────────────────────
describe('POST /federation/:id/practitioners/:pid/issue-card', () => {
  const FED = 'fed-uuid-001';
  const PRAC = 'prac-uuid-001';
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    const client = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({})                                  // BEGIN
      .mockResolvedValueOnce({ rows: [{                          // snapshot praticante
        id: PRAC, name: 'João Silva', karate_registration_number: 'FPKT-A-00001',
        dojo_id: 'dojo-1', birth_date: '1990-01-01', photo_url: null,
        belt_snapshot: '1dan', belt_name_snapshot: 'Preta', dojo_name: 'Dojô X',
      }] })
      .mockResolvedValueOnce({ rows: [] })                       // advisory lock
      .mockResolvedValueOnce({ rows: [] })                       // expira anterior
      .mockResolvedValueOnce({ rows: [{                          // INSERT card
        id: 'card-1', federation_id: FED, student_id: PRAC, card_number: 'FPKT-A-00001',
        belt_snapshot: '1dan', belt_name_snapshot: 'Preta', dojo_id: 'dojo-1',
        dojo_name_snapshot: 'Dojô X', photo_url_snapshot: null, is_minor: false,
        issued_at: new Date().toISOString(),
        verify_token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', status: 'active',
      }] })
      .mockResolvedValueOnce({});                                // COMMIT
  });

  it('emite carteirinha e retorna verify_token', (done) => {
    request(app)
      .post(`/federation/${FED}/practitioners/${PRAC}/issue-card`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.verify_token).toMatch(/^[a-f0-9]{32}$/);
        expect(res.body.status).toBe('active');
        expect(res.body).toHaveProperty('warnings');
        done();
      });
  });
});

describe('POST /public/karate/:slug/portal/verify-otp', () => {
  let app;
  beforeAll(() => { app = buildApp(); });
  beforeEach(() => jest.clearAllMocks());

  it('404 quando federação não encontrada', (done) => {
    db.query.mockResolvedValueOnce({ rows: [] }); // resolveFederation: slug não existe
    request(app)
      .post('/public/karate/inexistente/portal/verify-otp')
      .send({ cpf: '12345678900', code: '000000' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(404);
        done();
      });
  });
});
