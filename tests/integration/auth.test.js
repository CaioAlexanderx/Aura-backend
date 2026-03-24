// ============================================================
// QA-02 — Testes de Integração: Autenticação e RBAC
// ============================================================

jest.mock('../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(() => ({ query: jest.fn(), release: jest.fn() })),
}));
jest.mock('../../src/config/sentry', () => ({
  Sentry: { Handlers: {
    requestHandler: () => (q,r,n) => n(),
    tracingHandler:  () => (q,r,n) => n(),
    errorHandler:    () => (e,q,r,n) => n(),
  }},
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
const makeToken = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });

let app;
beforeAll(() => { ({ app } = require('../../src/index')); });
afterEach(() => jest.clearAllMocks());

describe('Auth Middleware', () => {
  test('401 sem token', async () => {
    const res = await request(app).get('/api/v1/companies/any/obligations');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/token/i);
  });

  test('401 token malformado', async () => {
    const res = await request(app)
      .get('/api/v1/companies/any/obligations')
      .set('Authorization', 'Bearer token-invalido');
    expect(res.status).toBe(401);
  });

  test('401 token expirado', async () => {
    const expired = jwt.sign({ id: 'u1', role: 'client' }, JWT_SECRET, { expiresIn: '-1s' });
    const res = await request(app)
      .get('/api/v1/companies/any/obligations')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expirado/i);
  });

  test('Health check não requer auth', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('Rota raiz não requer auth', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });
});

describe('RBAC — roles', () => {
  const db = require('../../src/config/database');

  test('403 — client não acessa /admin/dashboard', async () => {
    const token = makeToken({ id: 'u1', role: 'client' });
    const res = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('200 — admin acessa /admin/dashboard', async () => {
    const token = makeToken({ id: 'u1', role: 'admin' });
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .get('/api/v1/admin/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  test('analyst acessa /admin/prospect (não 403)', async () => {
    const token = makeToken({ id: 'u1', role: 'analyst' });
    const res = await request(app)
      .get('/api/v1/admin/prospect/00000000000000')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(403);
  });
});
