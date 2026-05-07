// ============================================================
// QA — Testes: Products CRUD + Plan Limits + Color/Size
// Cobertura: P1 (limites por plano), P1-8 (cor/tamanho)
// Limites de CADASTRO (POST): essencial=2000, negocio=7000, expansao=999999
// Limite de LISTAGEM  (GET):  HARD_CAP=20000 (independente do plano —
//   bug Davi #2 [07/05/2026]: clientes com produtos cadastrados acima
//   do plano [import CSV legacy / downgrade] ficavam sem ver parte do
//   próprio catálogo. Listagem foi desacoplada do plan limit, gating
//   de plano agora vale só pra POST).
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
const HARD_CAP = 20000;

const authEssencial = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'essencial' }, SECRET, { expiresIn:'1h' })}` };
const authNegocio   = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'negocio'   }, SECRET, { expiresIn:'1h' })}` };
const authExpansao  = { Authorization: `Bearer ${jwt.sign({ id:'u1', role:'client', plan:'expansao'  }, SECRET, { expiresIn:'1h' })}` };

// ── GET /products — listagem desacoplada do plan ─────────────
// Plan limit segue exposto em plan_limit (gating de POST). limit
// efetivo aplica HARD_CAP, NÃO o plan_limit. Garante que clientes
// com produtos cadastrados acima do plano (Davi: 10157 com plan
// negocio=7000) ainda enxergam todo o catálogo.
describe('GET /companies/:id/products — plan limits', () => {
  test('plan essencial: limit padrao = HARD_CAP (não o plan_limit)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ total: '50' }] });   // countRes
    db.query.mockResolvedValueOnce({ rows: [] });                  // dataRes

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/products`)
      .set(authEssencial);

    expect(res.status).toBe(200);
    expect(res.body.plan_limit).toBe(2000);   // gating de POST mantém
    expect(res.body.limit).toBe(HARD_CAP);    // listagem usa HARD_CAP
  });

  test('plan negocio: limit padrao = HARD_CAP (não o plan_limit)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '100' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/products`)
      .set(authNegocio);

    expect(res.status).toBe(200);
    expect(res.body.plan_limit).toBe(7000);
    expect(res.body.limit).toBe(HARD_CAP);
  });

  test('plan expansao: plan_limit = 999999, listagem usa HARD_CAP', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '5000' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/products`)
      .set(authExpansao);

    expect(res.status).toBe(200);
    expect(res.body.plan_limit).toBe(999999);
    expect(res.body.limit).toBe(HARD_CAP);
  });

  test('query ?limit dentro do HARD_CAP é respeitado independente do plan', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '50' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    // Essencial pedindo 9999 — deve receber 9999 (não capa pelo plan,
    // só pelo HARD_CAP que é 20000). Comportamento NOVO desde fix do
    // bug Davi #2 — antes seria capado em 2000.
    const res = await request(app)
      .get(`/api/v1/companies/${cid}/products?limit=9999`)
      .set(authEssencial);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(9999);
  });

  test('query ?limit acima do HARD_CAP é capado em HARD_CAP', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '50' }] });
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/products?limit=99999`)
      .set(authNegocio);

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(HARD_CAP);
  });

  test('cenário Davi: plan negocio com >7000 produtos cadastrados — listagem devolve todos', async () => {
    // Reproduz o estado real: Davi tem plan=negocio (planLimit=7000) mas
    // 10157 produtos cadastrados via CSV legacy. Antes do fix, o GET
    // capava em 7000 e 3157 produtos ficavam invisíveis (incluindo
    // barcodes que o usuário tentava buscar no Estoque).
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '10157' }] }); // count real
    db.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/products`)
      .set(authNegocio);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(10157);     // total da empresa preservado
    expect(res.body.limit).toBe(HARD_CAP);  // limit cobre os 10157 (< 20000)
    expect(res.body.plan_limit).toBe(7000); // plan limit exposto (gating POST)
  });
});

// ── POST /products — plan limit enforcement ───────────────
describe('POST /companies/:id/products — plan limit enforcement', () => {
  test('201 — cria produto quando abaixo do limite (essencial)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ total: '500' }] }); // count check (500 < 2000)
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Produto Novo' }] }); // INSERT

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products`)
      .set(authEssencial)
      .send({ name: 'Produto Novo', price: 10 });

    expect(res.status).toBe(201);
  });

  test('403 — bloqueia criacao quando no limite do plano (essencial)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // companyAccess
    db.query.mockResolvedValueOnce({ rows: [{ total: '2000' }] }); // count = 2000 (no limite)

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products`)
      .set(authEssencial)
      .send({ name: 'Produto Extra', price: 10 });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Limite/);
    expect(res.body.limit).toBe(2000);
    expect(res.body.current).toBe(2000);
  });

  test('403 — bloqueia para negocio no limite de 7000', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });
    db.query.mockResolvedValueOnce({ rows: [{ total: '7000' }] }); // count = 7000

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/products`)
      .set(authNegocio)
      .send({ name: 'Produto Extra', price: 10 });

    expect(res.status).toBe(403);
    expect(res.body.limit).toBe(7000);
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
// Exposto via plan_limit no payload do GET. Continua refletindo o plano
// (gating de POST), mesmo que a listagem agora use HARD_CAP.
describe('getPlanLimit — logica de planos', () => {
  // Limites atuais: essencial=2000, negocio=7000, expansao/personalizado=999999
  const cases = [
    { plan: 'essencial', expected: 2000 },
    { plan: 'negocio',   expected: 7000 },
    { plan: 'expansao',  expected: 999999 },
    { plan: 'personalizado', expected: 999999 },
    { plan: undefined,   expected: 2000 },
    { plan: '',          expected: 2000 },
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
