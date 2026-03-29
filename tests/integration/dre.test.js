// ============================================================
// QA-02 — Testes de Integração: DRE Gerencial
// Requer plano negocio ou expansao
// DRE faz 2 queries: dre_category_map + transactions
// ============================================================
const request = require('supertest');
const jwt     = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.clearAllMocks());

const SECRET  = 'aura-test-secret-2026';
const cid     = '00000000-0000-0000-0000-000000000001';
// DRE requer plano negocio ou expansao
const authNeg = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio' },  SECRET, { expiresIn:'1h' })}` };
const authEss = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'essencial' },SECRET, { expiresIn:'1h' })}` };

describe('GET /companies/:id/dre', () => {
  test('200 — DRE retorna income, expenses e summary', async () => {
    // 2 queries: dre_category_map + transactions
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce({ rows: [] })  // dre_category_map vazio
      .mockResolvedValueOnce({ rows: [    // transactions
        { type:'income',  category:'venda',   amount:'5000', description:'Venda' },
        { type:'expense', category:'aluguel', amount:'1500', description:'Aluguel' },
      ]});
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dre`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('income');
    expect(res.body).toHaveProperty('expenses');
    expect(res.body).toHaveProperty('summary');
    expect(res.body.summary.receita_bruta).toBe(5000);
    expect(res.body.summary.despesa_fixa).toBe(-1500);
  });

  test('200 — DRE com período personalizado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // sem lançamentos
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dre?from=2026-01-01&to=2026-03-31`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(res.body.period.from).toBe('2026-01-01');
    expect(res.body.period.to).toBe('2026-03-31');
  });

  test('403 — plano essencial não tem acesso ao DRE', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dre`)
      .set(authEss);
    expect(res.status).toBe(403);
  });

  test('401 — sem token', async () => {
    const res = await request(app).get(`/api/v1/companies/${cid}/dre`);
    expect(res.status).toBe(401);
  });
});

describe('GET /companies/:id/dre/monthly', () => {
  test('200 — retorna evolução mensal', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({
      rows: [
        { month:'2026-03', receita:'5000', despesa:'3000' },
        { month:'2026-02', receita:'4000', despesa:'2500' },
      ],
    });
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/dre/monthly?months=3`)
      .set(authNeg);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toHaveProperty('lucro');
    expect(res.body[0]).toHaveProperty('margem_pct');
  });
});
