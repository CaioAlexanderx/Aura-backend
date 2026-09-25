// ============================================================
// AURA. — Testes: estoque separado por empresa no grupo (migration 355)
//
// Luis Henrique (25/09/2026): adega e loja de roupas no mesmo grupo
// multi-CNPJ. O POST /products ligava is_group_shared sozinho e cada
// produto de uma loja aparecia na outra. O Davi usa o compartilhamento,
// entao ele segue sendo o padrao.
//
// O que estes testes travam:
//   1. Grupo compartilhado (Davi) continua criando produto compartilhado.
//   2. Grupo separado cria produto privado.
//   3. Base sem a 355 nao derruba o cadastro nem muda o comportamento.
//   4. A opcao so vale para o dono com 2+ empresas ativas no grupo.
//   5. Desligar/ligar acerta empresas e produtos do grupo numa transacao.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const productsRouter = require('../../src/routes/products');
const userCompaniesRouter = require('../../src/routes/userCompanies');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const cid2 = '18c05f0e-b75b-4c12-870e-d7fb65f1dca1';
const pid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/products', productsRouter);
  app.use('/api/v1/companies/:id', scoped);
  app.use('/api/v1/me/companies', userCompaniesRouter);
  return app;
}
const app = buildApp();

const erro42703 = () => Object.assign(new Error('column "share_products_in_group" does not exist'), { code: '42703' });

function mockProdutos(stats, { semColuna = false } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/AS in_group/i.test(s)) {
      if (semColuna && /share_products_in_group/.test(s)) return Promise.reject(erro42703());
      return Promise.resolve({ rows: [stats] });
    }
    if (/INSERT INTO products/i.test(s)) return Promise.resolve({ rows: [{ id: pid, name: 'Skol' }] });
    return Promise.resolve({ rows: [] });
  });
}

const criar = () => request(app).post(`/api/v1/companies/${cid}/products`).set(auth).send({ name: 'Skol' });
const insertParams = () => db.query.mock.calls.find((c) => /INSERT INTO products/i.test(String(c[0] || '')))[1];

describe('POST /products — default de is_group_shared', () => {
  test('grupo compartilhado (caso Davi) continua criando produto compartilhado', async () => {
    mockProdutos({ total: '3', in_group: true, group_separated: false });
    const r = await criar();
    expect(r.status).toBe(201);
    expect(insertParams()[15]).toBe(true);
  });

  test('grupo separado cria produto privado', async () => {
    mockProdutos({ total: '3', in_group: true, group_separated: true });
    const r = await criar();
    expect(r.status).toBe(201);
    expect(insertParams()[15]).toBe(false);
  });

  test('empresa sem grupo segue privada', async () => {
    mockProdutos({ total: '3', in_group: false, group_separated: false });
    await criar();
    expect(insertParams()[15]).toBe(false);
  });

  test('base sem a 355: cai para a consulta antiga e mantem o compartilhamento', async () => {
    mockProdutos({ total: '3', in_group: true }, { semColuna: true });
    const r = await criar();
    expect(r.status).toBe(201);
    expect(insertParams()[15]).toBe(true);
  });
});

// ─── /me/companies/stock-sharing ─────────────────────────────

const grupo = (share = [true, true], ativas = [true, true]) => ({
  rows: share.map((v, i) => ({
    id: i === 0 ? cid : cid2, name: i === 0 ? 'Adega' : 'Roupas',
    is_active: ativas[i], share_products_in_group: v,
  })),
});

describe('GET /me/companies/stock-sharing', () => {
  test('dono com 2 empresas ve a opcao ligada por padrao', async () => {
    db.query.mockResolvedValueOnce(grupo());
    const r = await request(app).get('/api/v1/me/companies/stock-sharing').set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: true, shared: true });
    expect(r.body.companies).toHaveLength(2);
  });

  test('uma empresa false basta para o grupo contar como separado', async () => {
    db.query.mockResolvedValueOnce(grupo([true, false]));
    const r = await request(app).get('/api/v1/me/companies/stock-sharing').set(auth);
    expect(r.body.shared).toBe(false);
  });

  test('empresa unica (ou segunda desativada) nao ve a opcao', async () => {
    db.query.mockResolvedValueOnce(grupo([true, true], [true, false]));
    const r = await request(app).get('/api/v1/me/companies/stock-sharing').set(auth);
    expect(r.body.available).toBe(false);
  });

  test('base sem a 355 esconde a opcao', async () => {
    db.query.mockRejectedValueOnce(erro42703());
    const r = await request(app).get('/api/v1/me/companies/stock-sharing').set(auth);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: false, shared: true });
  });
});

describe('PATCH /me/companies/stock-sharing', () => {
  function mockClient(grupoRows) {
    const client = {
      release: jest.fn(),
      query: jest.fn((sql) => {
        const s = String(sql || '');
        if (/FOR UPDATE OF g/.test(s)) return Promise.resolve(grupoRows);
        if (/UPDATE products/.test(s)) return Promise.resolve({ rowCount: 5, rows: [] });
        return Promise.resolve({ rowCount: 0, rows: [] });
      }),
    };
    db.connect.mockReturnValue(client);
    return client;
  }
  const sqls = (client) => client.query.mock.calls.map((c) => String(c[0]).trim());
  const patch = (body) => request(app).patch('/api/v1/me/companies/stock-sharing').set(auth).send(body);

  test('desligar grava false no grupo inteiro e descompartilha os produtos', async () => {
    const client = mockClient(grupo());
    const r = await patch({ shared: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ shared: false, products_changed: 5 });

    const upCompanies = client.query.mock.calls.find((c) => /UPDATE companies SET share_products_in_group/.test(c[0]));
    expect(upCompanies[1]).toEqual([false, [cid, cid2]]);
    const upProducts = client.query.mock.calls.find((c) => /UPDATE products SET is_group_shared/.test(c[0]));
    expect(upProducts[1]).toEqual([false, [cid, cid2]]);
    expect(sqls(client)).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  test('religar compartilha de novo', async () => {
    const client = mockClient(grupo([false, false]));
    const r = await patch({ shared: true });
    expect(r.body.shared).toBe(true);
    const upProducts = client.query.mock.calls.find((c) => /UPDATE products SET is_group_shared/.test(c[0]));
    expect(upProducts[1][0]).toBe(true);
  });

  test('sem 2 empresas ativas: 403 e nada e gravado', async () => {
    const client = mockClient(grupo([true], [true]));
    const r = await patch({ shared: false });
    expect(r.status).toBe(403);
    expect(sqls(client).some((s) => /^UPDATE/.test(s))).toBe(false);
    expect(sqls(client)).toContain('ROLLBACK');
  });

  test.each([undefined, 'false', 0, null])('shared=%p leva 400', async (v) => {
    const r = await patch({ shared: v });
    expect(r.status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });
});
