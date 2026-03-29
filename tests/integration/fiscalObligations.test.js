// ============================================================
// QA-02 — Testes de Integração: Obrigações Fiscais
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

describe('GET /companies/:id/obligations', () => {
  test('200 — lista obrigações com campos calculados', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [
      { id: 'o1', code: 'DAS_MEI', description: 'DAS-MEI', due_date: new Date(),
        status: 'pending', estimated_amount: 80.90, checkpoint_total: 3, checkpoint_done: 0 },
    ]});
    const res = await request(app).get('/api/v1/companies/c1/obligations').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.obligations[0]).toHaveProperty('days_until_due');
    expect(res.body.obligations[0]).toHaveProperty('alert_level');
    expect(res.body.obligations[0]).toHaveProperty('disclaimer');
  });

  test('200 — lista vazia', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/companies/c1/obligations').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});

describe('GET /companies/:id/obligations/calendar', () => {
  const mockCompany = { id: 'c1', name: 'Empresa', tax_regime: 'mei', cnae_code: '9602500', has_employee: false };
  const mockTemplates = [
    { code: 'DAS_MEI', name_display: 'DAS-MEI', frequency: 'monthly', due_rule: 'day_20',
      responsible: 'aura', filter_label: 'aura_resolve', aura_action: 'Calcula automaticamente',
      user_action: null, time_estimate: null, checkpoint_total: 3, sort_order: 10 },
    { code: 'DASN_SIMEI', name_display: 'DASN-SIMEI', frequency: 'annual', due_rule: 'may_31',
      responsible: 'voce', filter_label: 'voce_faz', aura_action: 'Consolida e pré-preenche',
      user_action: 'Confirmar no portal', time_estimate: '5 min', checkpoint_total: 5, sort_order: 40 },
  ];

  test('200 — calendário completo MEI', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: mockTemplates })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/companies/c1/obligations/calendar').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.calendar).toHaveLength(2);
    expect(res.body.summary.aura_resolve).toBe(1);
    expect(res.body.summary.voce_faz).toBe(1);
    expect(res.body.disclaimer).toBeDefined();
  });

  test('200 — filtro aura_resolve', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce({ rows: [mockCompany] })
      .mockResolvedValueOnce({ rows: mockTemplates })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/companies/c1/obligations/calendar?filter=aura_resolve').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.calendar.every(c => c.filter_label === 'aura_resolve')).toBe(true);
  });

  test('400 — filtro inválido', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app).get('/api/v1/companies/c1/obligations/calendar?filter=invalido').set(auth);
    expect(res.status).toBe(400);
  });

  test('404 — empresa não encontrada', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get('/api/v1/companies/c1/obligations/calendar').set(auth);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /companies/:id/obligations/:id/checkpoint', () => {
  test('400 — sem checkpoint_done', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app)
      .patch('/api/v1/companies/c1/obligations/o1/checkpoint')
      .set(auth).send({});
    expect(res.status).toBe(400);
  });

  test('200 — checkpoint atualizado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: 'o1', checkpoint_done: 2, status: 'pending' }] });
    const res = await request(app)
      .patch('/api/v1/companies/c1/obligations/o1/checkpoint')
      .set(auth).send({ checkpoint_done: 2 });
    expect(res.status).toBe(200);
  });
});
