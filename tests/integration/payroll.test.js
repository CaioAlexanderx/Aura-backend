// ============================================================
// QA-02 — Testes de Integração: Folha de Pagamento e DAS
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
const JWT_SECRET = process.env.JWT_SECRET || 'aura-test-secret-2026';
const token = jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${token}` };

let app, db;
beforeAll(() => { ({ app } = require('../../src/index')); db = require('../../src/config/database'); });
beforeEach(() => jest.clearAllMocks());

// ── Folha de Pagamento ─────────────────────────────────────
// A rota POST /payroll/calculate foi movida para services/payroll.js
// e é testada via testes unitários (tests/unit/payroll.test.js).
// Os testes de integração cobrem o endpoint de cálculo via obligations.

describe('GET /companies/:id/obligations/das/preview — MEI', () => {
  test('200 — DAS MEI para atividade de serviços', async () => {
    // Rota: busca company → retorna { tax_regime, annual_revenue }
    db.query.mockResolvedValueOnce({
      rows: [{ tax_regime: 'mei', annual_revenue: 40000 }],
    });
    const res = await request(app)
      .get('/api/v1/companies/c1/obligations/das/preview?activity_type=services')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.regime).toBe('mei');
    expect(res.body.das).toBeDefined();
    expect(res.body.limit_check).toBeDefined();
  });

  test('200 — DAS MEI para comércio (activity_type omitido usa default)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ tax_regime: 'mei', annual_revenue: 60000 }],
    });
    const res = await request(app)
      .get('/api/v1/companies/c1/obligations/das/preview')
      .set(auth);
    // MEI não exige current_revenue/revenue_12m — sempre retorna 200
    expect(res.status).toBe(200);
    expect(res.body.regime).toBe('mei');
  });

  test('404 — empresa não encontrada', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/api/v1/companies/nao-existe/obligations/das/preview')
      .set(auth);
    expect(res.status).toBe(404);
  });
});

describe('GET /companies/:id/obligations/das/preview — Simples Nacional', () => {
  test('400 — Simples sem current_revenue e revenue_12m obrigatórios', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ tax_regime: 'simples_nacional', annual_revenue: 200000 }],
    });
    const res = await request(app)
      .get('/api/v1/companies/c1/obligations/das/preview')
      .set(auth);
    // Simples exige current_revenue e revenue_12m
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current_revenue|revenue_12m/i);
  });

  test('200 — DAS Simples com parâmetros corretos', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ tax_regime: 'simples_nacional', annual_revenue: 200000 }],
    });
    const res = await request(app)
      .get('/api/v1/companies/c1/obligations/das/preview?current_revenue=20000&revenue_12m=200000')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.regime).toBe('simples_nacional');
    expect(res.body.das).toBeDefined();
  });
});
