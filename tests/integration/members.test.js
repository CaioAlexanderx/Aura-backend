// ============================================================
// QA-02 — Testes de Integração: Multi-usuário RBAC
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
jest.mock('../../src/services/dentalWs', () => ({ setupDentalWebSocket: jest.fn(), getSessionStatus: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'aura-dev-secret';
const token = jwt.sign({ id: 'u1', role: 'client' }, JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${token}` };

let app, db;
beforeAll(() => { ({ app } = require('../../src/index')); db = require('../../src/config/database'); });
afterEach(() => jest.clearAllMocks());

describe('GET /companies/:id/members', () => {
  test('200 — lista com resumo de cobrança', async () => {
    db.query.mockResolvedValueOnce({ rows: [
      { id: 'm1', role_label: 'vendedor', status: 'active', is_active: true, user_name: 'Ana', user_email: 'ana@email.com', template_name: 'Vendedor' },
      { id: 'm2', role_label: 'gerente', status: 'pending', is_active: false, user_name: null, user_email: null, invite_email: 'jose@email.com', template_name: null },
    ]});
    const res = await request(app).get('/api/v1/companies/c1/members').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.active).toBe(1);
    expect(res.body.pending).toBe(1);
    expect(res.body.monthly_cost).toBe(0); // 1 ativo - 1 dono = 0 cobráveis
  });
});

describe('POST /companies/:id/members/invite', () => {
  test('400 — sem invite_email', async () => {
    const res = await request(app)
      .post('/api/v1/companies/c1/members/invite')
      .set(auth).send({ role_label: 'vendedor' });
    expect(res.status).toBe(400);
  });

  test('409 — email já tem convite pendente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'm1', status: 'pending' }] });
    const res = await request(app)
      .post('/api/v1/companies/c1/members/invite')
      .set(auth).send({ invite_email: 'dup@email.com' });
    expect(res.status).toBe(409);
  });

  test('201 — convite criado com invite_url', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'm1', invite_token: 'tok123', invite_email: 'novo@email.com', role_label: 'vendedor', status: 'pending' }] });
    const res = await request(app)
      .post('/api/v1/companies/c1/members/invite')
      .set(auth).send({ invite_email: 'novo@email.com' });
    expect(res.status).toBe(201);
    expect(res.body.invite_url).toBeDefined();
    expect(res.body.note).toMatch(/BE-08/i);
  });
});

describe('GET /companies/:id/members/billing', () => {
  test('200 — R$57 para 4 membros ativos (3 cobráveis)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ total: '4' }] });
    const res = await request(app).get('/api/v1/companies/c1/members/billing').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.billable_members).toBe(3);
    expect(res.body.monthly_total).toBe(57);
  });
});
