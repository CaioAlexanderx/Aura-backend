// ============================================================
// QA-02 — Testes de Integração: Módulo Odontologia
// ============================================================

jest.mock('../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(() => ({ query: jest.fn(), release: jest.fn() })),
}));
jest.mock('../../src/config/sentry', () => ({
  Sentry: { Handlers: { requestHandler:()=>(q,r,n)=>n(), tracingHandler:()=>(q,r,n)=>n(), errorHandler:()=>(e,q,r,n)=>n() }},
  initSentry: jest.fn(),
}));
jest.mock('../../src/config/redis', () => ({}));
jest.mock('../../src/services/dentalWs', () => ({
  setupDentalWebSocket: jest.fn(),
  getSessionStatus: jest.fn(() => ({ connected: false, status: 'waiting' })),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'aura-dev-secret';
const token = jwt.sign({ id: 'u1', role: 'client' }, JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${token}` };

let app, db;
beforeAll(() => { ({ app } = require('../../src/index')); db = require('../../src/config/database'); });
afterEach(() => jest.clearAllMocks());

describe('POST /companies/:id/dental/patients — LGPD', () => {
  test('400 — sem full_name', async () => {
    const res = await request(app)
      .post('/api/v1/companies/c1/dental/patients')
      .set(auth).send({ lgpd_consent: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/full_name/i);
  });

  test('400 — sem consentimento LGPD Art.11', async () => {
    const res = await request(app)
      .post('/api/v1/companies/c1/dental/patients')
      .set(auth).send({ full_name: 'João Silva' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lgpd/i);
  });

  test('201 — paciente criado com consentimento', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'pt1', full_name: 'João Silva', lgpd_consent: true }]});
    const res = await request(app)
      .post('/api/v1/companies/c1/dental/patients')
      .set(auth).send({ full_name: 'João Silva', lgpd_consent: true });
    expect(res.status).toBe(201);
    expect(res.body.patient.lgpd_consent).toBe(true);
  });
});

describe('PATCH /companies/:id/dental/appointments/:aid — transições', () => {
  test('400 — transição inválida concluido → avaliacao', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ status: 'concluido' }] });
    const res = await request(app)
      .patch('/api/v1/companies/c1/dental/appointments/a1')
      .set(auth).send({ status: 'avaliacao' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/transição inválida/i);
  });

  test('200 — transição válida agendado → em_atendimento', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ status: 'agendado' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'a1', status: 'em_atendimento', started_at: new Date() }] });
    const res = await request(app)
      .patch('/api/v1/companies/c1/dental/appointments/a1')
      .set(auth).send({ status: 'em_atendimento' });
    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('em_atendimento');
  });
});

describe('GET /dental/sign/:token — validação WS token', () => {
  test('410 — token expirado/inválido', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/dental/sign/token-invalido');
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expirado/i);
  });

  test('200 — token válido', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      id: 't1', appointment_id: 'a1', company_id: 'c1',
      expires_at: new Date(Date.now() + 600000), used_at: null,
    }]});
    const res = await request(app).get('/api/v1/dental/sign/token-valido');
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });
});
