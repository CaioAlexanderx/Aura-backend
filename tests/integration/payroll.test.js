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
const JWT_SECRET = process.env.JWT_SECRET || 'aura-dev-secret';
const token = jwt.sign({ id: 'u1', role: 'client' }, JWT_SECRET, { expiresIn: '1h' });
const auth = { Authorization: `Bearer ${token}` };

let app, db;
beforeAll(() => { ({ app } = require('../../src/index')); db = require('../../src/config/database'); });
afterEach(() => jest.clearAllMocks());

describe('POST /companies/:id/payroll/calculate', () => {
  test('200 — INSS e FGTS corretos para R$2.000', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      id: 'e1', name: 'João', base_salary: 2000, pis_pasep: '12345678901', fgts_account: null,
    }]});
    const res = await request(app)
      .post('/api/v1/companies/c1/payroll/calculate')
      .set(auth).send({ employee_id: 'e1', reference_month: '2026-03-01' });
    expect(res.status).toBe(200);
    expect(parseFloat(res.body.payroll.inss)).toBeCloseTo(150, 0);  // 7.5% de 2000
    expect(parseFloat(res.body.payroll.fgts)).toBeCloseTo(160, 0);  // 8% de 2000
    expect(parseFloat(res.body.payroll.net_salary)).toBeLessThan(2000);
    expect(parseFloat(res.body.payroll.net_salary)).toBeGreaterThan(1800);
  });
});

describe('GET /companies/:id/obligations/das/preview', () => {
  test('200 — DAS MEI services', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ tax_regime: 'mei', annual_revenue: 40000 }] });
    const res = await request(app)
      .get('/api/v1/companies/c1/obligations/das/preview?activity_type=services')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.regime).toBe('mei');
    expect(res.body.das.total).toBeGreaterThan(0);
    expect(res.body.das.disclaimer).toBeDefined();
  });

  test('400 — Simples sem parâmetros obrigatórios', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ tax_regime: 'simples_nacional', annual_revenue: 200000 }] });
    const res = await request(app)
      .get('/api/v1/companies/c1/obligations/das/preview')
      .set(auth);
    expect(res.status).toBe(400);
  });

  test('200 — DAS Simples estimado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ tax_regime: 'simples_nacional', annual_revenue: 200000 }] });
    const res = await request(app)
      .get('/api/v1/companies/c1/obligations/das/preview?current_revenue=20000&revenue_12m=200000')
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.das.estimated_das).toBeGreaterThan(0);
  });
});
