const request = require('supertest');
const jwt     = require('jsonwebtoken');
const { app } = require('../../src/index');
const db      = require('../../src/config/database');

const JWT_SECRET = 'aura-test-secret-2026';
function makeToken(p = {}) {
  return jwt.sign({ id: 'u1', email: 'test@aura.com', role: 'client', plan: 'negocio', ...p }, JWT_SECRET, { expiresIn: '1h' });
}

describe('Auth — Middleware de autenticação', () => {
  beforeEach(() => jest.clearAllMocks());

  test('Rota protegida retorna 401 sem token', async () => {
    const res = await request(app).get('/api/v1/companies/x/obligations');
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty('error');
  });

  test('Retorna 401 com token malformado', async () => {
    const res = await request(app).get('/api/v1/companies/x/obligations').set('Authorization', 'Bearer token-invalido');
    expect(res.status).toBe(401);
  });

  test('Retorna 401 com token expirado', async () => {
    const expired = jwt.sign({ id: 'x', role: 'client' }, JWT_SECRET, { expiresIn: '-1s' });
    const res = await request(app).get('/api/v1/companies/x/obligations').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expirado/i);
  });

  test('Rota protegida passa com token válido', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/companies/x/obligations').set('Authorization', `Bearer ${makeToken()}`);
    expect(res.status).not.toBe(401);
  });

  test('requireRole bloqueia role insuficiente (403)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get('/api/v1/admin/dashboard').set('Authorization', `Bearer ${makeToken({ role: 'client' })}`);
    expect(res.status).toBe(403);
  });

  test('requireRole permite admin acessar /admin', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: 0 }] });
    const res = await request(app).get('/api/v1/admin/dashboard').set('Authorization', `Bearer ${makeToken({ role: 'admin' })}`);
    expect(res.status).toBe(200);
  });

  test('Authorization sem Bearer retorna 401', async () => {
    const res = await request(app).get('/api/v1/companies/x/members').set('Authorization', makeToken());
    expect(res.status).toBe(401);
  });
});
