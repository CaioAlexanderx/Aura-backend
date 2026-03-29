// ============================================================
// AURA. — Testes Integração: Assinatura Digital (BE-25-10)
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET      = 'aura-test-secret-2026';
const validToken  = 'valid-token-123';
const cid         = '00000000-0000-0000-0000-000000000001';
const aid         = '00000000-0000-0000-0000-000000000002';
const authHeader  = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio' }, SECRET, { expiresIn:'1h' })}` };

jest.mock('../../src/services/dental', () => ({
  validateWsToken: jest.fn(),
  generateWsToken: jest.fn(),
  listPatients: jest.fn(() => []),
  getAgendaByPeriod: jest.fn(() => []),
  updateAppointmentStatus: jest.fn(),
  addProcedureToAppointment: jest.fn(),
  recalcAppointmentTotal: jest.fn(),
  calcAppointmentTotal: jest.fn(() => 0),
}));

const { validateWsToken, generateWsToken } = require('../../src/services/dental');

describe('GET /dental/sign/:token/pad', () => {
  beforeEach(() => jest.clearAllMocks());

  test('retorna HTML 200 com token válido', async () => {
    validateWsToken.mockResolvedValueOnce({ appointment_id:'a1', company_id:'c1', expires_at: new Date(Date.now()+600000).toISOString() });
    const res = await request(app).get(`/api/v1/dental/sign/${validToken}/pad`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  test('HTML contém canvas de assinatura', async () => {
    validateWsToken.mockResolvedValueOnce({ appointment_id:'a1', company_id:'c1', expires_at: new Date(Date.now()+600000).toISOString() });
    const res = await request(app).get(`/api/v1/dental/sign/${validToken}/pad`);
    expect(res.text).toContain('signCanvas');
  });

  test('HTML contém checkbox LGPD', async () => {
    validateWsToken.mockResolvedValueOnce({ appointment_id:'a1', company_id:'c1', expires_at: new Date(Date.now()+600000).toISOString() });
    const res = await request(app).get(`/api/v1/dental/sign/${validToken}/pad`);
    expect(res.text).toContain('LGPD');
    expect(res.text).toContain('consent');
  });

  test('HTML contém URL do WebSocket com token', async () => {
    validateWsToken.mockResolvedValueOnce({ appointment_id:'a1', company_id:'c1', expires_at: new Date(Date.now()+600000).toISOString() });
    const res = await request(app).get(`/api/v1/dental/sign/${validToken}/pad`);
    expect(res.text).toContain('/ws/sign/');
    expect(res.text).toContain(validToken);
  });

  test('retorna 410 com token expirado/inválido', async () => {
    validateWsToken.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/v1/dental/sign/token-invalido/pad');
    expect(res.status).toBe(410);
    expect(res.text).toContain('expirado');
  });
});

describe('GET /dental/sign/:token/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset(); // Clear mockResolvedValueOnce queue
  });

  test('retorna status waiting quando paciente não conectou', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ used_at:null, conclusion_signed:false, conclusion_at:null }] });
    const res = await request(app).get(`/api/v1/dental/sign/${validToken}/status`);
    expect(res.status).toBe(200);
    expect(res.body.signed).toBe(false);
    expect(res.body.status).toBe('waiting');
  });

  test('retorna status signed após assinatura registrada', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ used_at: new Date().toISOString(), conclusion_signed:true, conclusion_at: new Date().toISOString() }] });
    const res = await request(app).get(`/api/v1/dental/sign/${validToken}/status`);
    expect(res.status).toBe(200);
    expect(res.body.signed).toBe(true);
    expect(res.body.status).toBe('signed');
  });

  test('retorna 404 com token inexistente', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/dental/sign/nao-existe/status');
    expect(res.status).toBe(404);
  });
});

describe('POST /dental/appointments/:aid/signature-token', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset();
  });

  test('gera token de assinatura', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    generateWsToken.mockResolvedValueOnce({ token:'new-token-abc', pad_url:'https://example.com/pad', expires_at: new Date(Date.now()+600000).toISOString(), qr_data:'https://...' });
    const res = await request(app).post(`/api/v1/companies/${cid}/dental/appointments/${aid}/signature-token`).set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('pad_url');
  });

  test('retorna 401 sem autenticação', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/dental/appointments/${aid}/signature-token`);
    expect(res.status).toBe(401);
  });
});
