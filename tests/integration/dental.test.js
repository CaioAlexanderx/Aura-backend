// ============================================================
// QA-02 — Testes de Integração: Módulo Odontológico
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio' }, SECRET, { expiresIn:'1h' })}` };

describe('POST /dental/patients — LGPD', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna 400 sem full_name', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/patients`)
      .set(auth).send({ cpf: '123.456.789-00' });
    expect(res.status).toBe(400);
  });

  test('retorna 400 sem consentimento LGPD', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/patients`)
      .set(auth).send({ full_name: 'João Silva', cpf: '123.456.789-00' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/consentimento|lgpd/i);
  });

  test('cria paciente com consentimento válido', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }] }) // companyAccess
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'pat1', full_name: 'João Silva' }] });
    const res = await request(app)
      .post(`/api/v1/companies/${cid}/dental/patients`)
      .set(auth).send({
        full_name: 'João Silva',
        cpf: '123.456.789-00',
        lgpd_consent: true,
        lgpd_consent_date: new Date().toISOString(),
      });
    expect(res.status).toBe(201);
  });
});

describe('GET /dental/sign/:token', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna 404 para token inválido ou expirado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/dental/sign/token-inexistente');
    expect([404, 410]).toContain(res.status);
    expect(res.body.error).toBeDefined();
  });
});
