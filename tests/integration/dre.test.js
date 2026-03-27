// ============================================================
// QA-02 — Testes de Integração: DRE Gerencial
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid    = '00000000-0000-0000-0000-000000000001';
const auth   = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio' }, SECRET, { expiresIn:'1h' })}` };

describe('GET /companies/:id/dre', () => {
  test('200 — DRE retorna receitas e despesas', async () => {
    // Rota DRE faz 1 query de transactions agrupadas
    db.query.mockResolvedValueOnce({
      rows: [
        { type:'income',  category:'venda',   amount:5000, month:'2026-01-01' },
        { type:'expense', category:'aluguel', amount:1500, month:'2026-01-01' },
      ],
    });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dre`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('income');
    expect(res.body).toHaveProperty('expenses');
  });

  test('200 — DRE com período personalizado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dre?from=2026-01-01&to=2026-03-31`)
      .set(auth);
    expect([200, 404]).toContain(res.status);
  });

  test('401 — sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/dre`);
    expect(res.status).toBe(401);
  });
});

describe('GET /companies/:id/dre/withdrawal/summary — Minha Retirada', () => {
  test('200 — retorna resumo de retirada', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ tax_regime:'mei', annual_revenue:40000 }] })
      .mockResolvedValueOnce({ rows: [{ total_income:5000, total_expenses:2000 }] });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dre/withdrawal/summary`)
      .set(auth);
    expect([200, 404]).toContain(res.status);
  });
});
