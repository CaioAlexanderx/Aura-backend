// ============================================================
// QA — Testes: Customers CRUD + Plan Limits
// Cobertura: P1 (limites por plano), editar cliente (P0-2)
// NOTA: /customers requer requirePlan('negocio','expansao')
//
// MULTICNPJ Onda 2.3 (03/05/2026): customers.js chama
// getOwnerScopedCompanyIds() antes de cada handler — isso consume
// uma db.query extra. Todo teste que nao retorna 400/403 antes
// dessa chamada precisa de um mock adicional:
//   db.query.mockResolvedValueOnce({ rows: [{ id: cid }] }) // ownerScope
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

// -- Plano essencial bloqueado pelo requirePlan ---------------
// Nao chega em getOwnerScopedCompanyIds (bloqueado antes pelo requirePlan)
describe('GET /companies/:id/customers -- plano essencial bloqueado', () => {
  test('403 -- plano essencial nao tem acesso a clientes (requer negocio+)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/customers`)
      .set(authEssencial);

    expect(res.status).toBe(403);
  });
});

// -- GET /customers -- plan limits ----------------------------
describe('GET /companies/:id/customers -- plan limits', () => {
  test('plan negocio: limit = 5000', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: cid }] });        // getOwnerScopedCompanyIds
    db.query.mockResolvedValueOnce({ rows: [{ total: '200' }] });   // COUNT
    db.query.mockResolvedValueOnce({ rows: [] });                    // data list

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/customers`)
      .set(authNegocio);

    expect(res.status).toBe(200);
    expect(res.body.plan_limit).toBe(5000);
  });

  test('plan expansao: limit = 999999', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: cid }] });        // getOwnerScopedCompanyIds
    db.query.mockResolvedValueOnce({ rows: [{ total: '9999' }] });  // COUNT
    db.query.mockResolvedValueOnce({ rows: [] });                    // data list

    const res = await request(app)
      .get(`/api/v1/companies/${cid}/customers`)
      .set(authExpansao);

    expect(res.status).toBe(200);
    expect(res.body.plan_limit).toBe(999999);
  });
});

// -- POST /customers -- plan limit enforcement ----------------
describe('POST /companies/:id/customers -- plan limit enforcement', () => {
  test('201 -- cria cliente quando abaixo do limite (negocio)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });              // requireCompanyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: cid }] });                    // getOwnerScopedCompanyIds (plan count)
    db.query.mockResolvedValueOnce({ rows: [{ total: '50' }] });                // COUNT clientes
    db.query.mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'Maria Silva' }] }); // INSERT

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/customers`)
      .set(authNegocio)
      .send({ name: 'Maria Silva' });

    expect(res.status).toBe(201);
  });

  test('403 -- bloqueia criacao no limite do plano (negocio=5000)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: cid }] });        // getOwnerScopedCompanyIds
    db.query.mockResolvedValueOnce({ rows: [{ total: '5000' }] });  // COUNT

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/customers`)
      .set(authNegocio)
      .send({ name: 'Cliente Extra' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Limite/);
    expect(res.body.limit).toBe(5000);
  });

  test('201 -- expansao cria cliente com 9999 existentes', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });                  // requireCompanyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: cid }] });                        // getOwnerScopedCompanyIds
    db.query.mockResolvedValueOnce({ rows: [{ total: '9999' }] });                  // COUNT
    db.query.mockResolvedValueOnce({ rows: [{ id: 'c2', name: 'VIP Customer' }] }); // INSERT

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/customers`)
      .set(authExpansao)
      .send({ name: 'VIP Customer' });

    expect(res.status).toBe(201);
  });

  // 400 retorna antes de getOwnerScopedCompanyIds — so precisa do requireCompanyAccess mock
  test('400 -- name obrigatorio', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/customers`)
      .set(authNegocio)
      .send({ email: 'sem-nome@test.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });
});

// -- PATCH /:cid -- editar cliente ----------------------------
describe('PATCH /companies/:id/customers/:cid -- editar cliente', () => {
  test('200 -- atualiza campos do cliente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });                                          // requireCompanyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: cid }] });                                               // getOwnerScopedCompanyIds
    db.query.mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'Maria Atualizada', phone: '(12) 99999-0000' }] }); // UPDATE

    const res = await request(app)
      .patch(`/api/v1/companies/${cid}/customers/c1`)
      .set(authNegocio)
      .send({ name: 'Maria Atualizada', phone: '(12) 99999-0000' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Maria Atualizada');
  });

  // 400 retorna antes de getOwnerScopedCompanyIds
  test('400 -- nenhum campo para atualizar', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess

    const res = await request(app)
      .patch(`/api/v1/companies/${cid}/customers/c1`)
      .set(authNegocio)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Nenhum campo/);
  });

  test('404 -- cliente nao encontrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: cid }] });        // getOwnerScopedCompanyIds
    db.query.mockResolvedValueOnce({ rows: [] });                    // UPDATE (nenhum resultado)

    const res = await request(app)
      .patch(`/api/v1/companies/${cid}/customers/nao-existe`)
      .set(authNegocio)
      .send({ name: 'Novo Nome' });

    expect(res.status).toBe(404);
  });
});

// -- DELETE /:cid ---------------------------------------------
describe('DELETE /companies/:id/customers/:cid', () => {
  test('200 -- deleta cliente existente', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] });             // requireCompanyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: cid }] });                   // getOwnerScopedCompanyIds
    db.query.mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'Maria' }] });   // DELETE

    const res = await request(app)
      .delete(`/api/v1/companies/${cid}/customers/c1`)
      .set(authNegocio);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  test('404 -- cliente nao encontrado', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ role: 'owner' }] }); // requireCompanyAccess
    db.query.mockResolvedValueOnce({ rows: [{ id: cid }] });        // getOwnerScopedCompanyIds
    db.query.mockResolvedValueOnce({ rows: [] });                    // DELETE (nenhum resultado)

    const res = await request(app)
      .delete(`/api/v1/companies/${cid}/customers/nao-existe`)
      .set(authNegocio);

    expect(res.status).toBe(404);
  });

  test('401 -- sem token', async () => {
    const res = await request(app)
      .delete(`/api/v1/companies/${cid}/customers/c1`);
    expect(res.status).toBe(401);
  });
});
