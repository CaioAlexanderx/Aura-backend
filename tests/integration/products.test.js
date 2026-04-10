// ============================================================
// QA — Testes: Products CRUD + Plan Limits + Color/Size
// Cobertura: P1 (limites por plano), P1-8 (cor/tamanho)
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

const authEssencial = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'essencial' }, SECRET, { expiresIn:'1h' })}` };
const authNegocio   = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio'   }, SECRET, { expiresIn:'1h' })}` };
const authExpansao  = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'expansao'  }, SECRET, { expiresIn:'1h' })}` };

// ── GET /products ─────────────────────────────────────────
describe('GET /companies/:id/products — plan limits', () => {
  test('plan essencial: limit padrao = 1000', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ total: '50' }] });   // countRes
    db.query.mockResolvedValueOnce({ rows: [] });                  // dataRes

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/products`)
      .set(authEssencial);

    expect(res.status).toBe(200);
    expect(res.body.plan_limit).toBe(1000);
    expect(res.body.limit).toBe(1000);
  });

  test('plan negocio: limit padrao = 5000', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '100' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/products`)
      .set(authNegocio);

    expect(res.status).toBe(200);
    expect(res.body.plan_limit).toBe(5000);
    expect(res.body.limit).toBe(5000);
  });

  test('plan expansao: limit = 999999 (ilimitado)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '5000' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/products`)
      .set(authExpansao);

    expect(res.status).toBe(200);
    expect(res.body.plan_limit).toBe(999999);
  });

  test('query limit nao pode exceder plan_limit', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '50' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    // Essencial tentando pedir 9999 — deve ser capped em 1000
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/products?limit=9999`)
      .set(authEssencial);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(1000);
  });
});

// ── POST /products — plan limit enforcement ───────────────
describe('POST /companies/:id/products — plan limit enforcement', () => {
  test('201 — cria produto quando abaixo do limite (essencial)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ total: '500' }] }); // count check (500 < 1000)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Produto Novo' }] }); // INSERT

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products`)
      .set(authEssencial)
      .send({ name: 'Produto Novo', price: 10 });

    expect(res.status).toBe(201);
  });

  test('403 — bloqueia criacao quando no limite do plano (essencial)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ total: '1000' }] }); // count = 1000 (no limite)

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products`)
      .set(authEssencial)
      .send({ name: 'Produto Extra', price: 10 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Limite/);
    expect(res.body.limit).toBe(1000);
    expect(res.body.current).toBe(1000);
  });

  test('403 — bloqueia para negocio no limite de 5000', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '5000' }] }); // count = 5000

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products`)
      .set(authNegocio)
      .send({ name: 'Produto Extra', price: 10 });

    expect(res.status).toBe(403);
    expect(res.body.limit).toBe(5000);
  });

  test('201 — expansao cria produto mesmo com 5000+ existentes', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '9999' }] }); // count = 9999 < 999999
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p2', name: 'Produto VIP' }] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products`)
      .set(authExpansao)
      .send({ name: 'Produto VIP', price: 50 });

    expect(res.status).toBe(201);
  });

  test('400 — name obrigatorio', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products`)
      .set(authEssencial)
      .send({ price: 10 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });
});

// ── POST /products — color e size (P1-8) ─────────────────
describe('POST /companies/:id/products — color e size', () => {
  test('201 — aceita cor hexadecimal valida', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Camiseta', color: '#ff0000', size: 'M' }] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products`)
      .set(authEssencial)
      .send({ name: 'Camiseta', price: 49.90, color: '#ff0000', size: 'M' });

    expect(res.status).toBe(201);
  });

  test('201 — aceita product sem cor/tamanho (campos opcionais)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p2', name: 'Produto Simples', color: null, size: null }] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products`)
      .set(authEssencial)
      .send({ name: 'Produto Simples', price: 10 });

    expect(res.status).toBe(201);
  });
});

// ── PATCH /:pid — stock decrement (atomico) ───────────────
describe('PATCH /companies/:id/products/:pid — stock_qty_decrement', () => {
  test('200 — decrementa estoque atomicamente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1', stock_qty: 8 }] }); // UPDATE RETURNING

    const res = await request(app)
      .patch(`/api/v1/companies/${cid}/products/p1`)
      .set(authEssencial)
      .send({ stock_qty_decrement: 2 });

    expect(res.status).toBe(200);
    expect(res.body.stock_qty).toBe(8); // mock retorna 8
  });

  test('400 — decrement negativo rejeitado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });

    const res = await request(app)
      .patch(`/api/v1/companies/${cid}/products/p1`)
      .set(authEssencial)
      .send({ stock_qty_decrement: -5 });

    expect(res.status).toBe(400);
  });

  test('404 — produto nao encontrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [] }); // produto nao existe

    const res = await request(app)
      .patch(`/api/v1/companies/${cid}/products/nao-existe`)
      .set(authEssencial)
      .send({ stock_qty_decrement: 1 });

    expect(res.status).toBe(404);
  });
});

// ── DELETE /:pid ──────────────────────────────────────────
describe('DELETE /companies/:id/products/:pid', () => {
  test('200 — deleta produto existente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Produto Deletado' }] });

    const res = await request(app)
      .delete(`/api/v1/companies/${cid}/products/p1`)
      .set(authEssencial);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  test('404 — produto nao encontrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete(`/api/v1/companies/${cid}/products/nao-existe`)
      .set(authEssencial);

    expect(res.status).toBe(404);
  });

  test('401 — sem token', async () => {
    const res = await request(app)
      .delete(`/api/v1/companies/${cid}/products/p1`);
    expect(res.status).toBe(401);
  });
});

// ── getPlanLimit unit test ────────────────────────────────
describe('getPlanLimit — logica de planos', () => {
  // Acessa a funcao via endpoint que a usa internamente
  const cases = [
    { plan: 'essencial', expected: 1000 },
    { plan: 'negocio',   expected: 5000 },
    { plan: 'expansao',  expected: 999999 },
    { plan: 'personalizado', expected: 999999 },
    { plan: undefined,   expected: 1000 },
    { plan: '',          expected: 1000 },
  ];

  cases.forEach(({ plan, expected }) => {
    test(`plano "${plan}" => limit ${expected}`, async () => {
      const token = jwt.sign({ id:'u1', role:'client', plan }, SECRET, { expiresIn:'1h' });
      db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
      db.query.mockResolvedValueOnce({ rows: [{ total: '0' }] });
      db.query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get(`/api/v1/companies/${cid}/products`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.plan_limit).toBe(expected);
    });
  });
});
