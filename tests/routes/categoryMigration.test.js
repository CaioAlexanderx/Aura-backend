// ============================================================
// AURA. -- Testes: rotas de migracao de categorias + marca (Bloco B2)
// Router ISOLADO (private.js e do B1). App abaixo replica requireAuth +
// requireCompanyAccess + mount na raiz -- linha declarada no PR.
// Mock por SQL (mockImplementation por texto), nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const categoryMigrationRouter = require('../../src/routes/categoryMigration');
const migration = require('../../src/services/categoryMigration');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess()); // admin bypassa o SELECT no banco
  scoped.use('/', categoryMigrationRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();
const mkClient = (impl) => ({ query: jest.fn(impl), release: jest.fn() });
const mkPending = (n) => Array.from({ length: n }, (_, i) => ({ id: `st${i}`, raw_value: `V${i}`, kind: 'discard', target_path: null }));

describe('POST /categories/migration/analyze', () => {
  test('401 sem token', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/categories/migration/analyze`);
    expect(res.status).toBe(401);
  });

  test('200 -- 2 INSERTs + status', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).post(`/api/v1/companies/${cid}/categories/migration/analyze`).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.analyzed).toBe(true);
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  test('idempotencia + escopo vendavel + orfa incondicional + amostra <=5', async () => {
    const calls = [];
    db.query.mockImplementation((sql) => { calls.push(sql); return Promise.resolve({ rows: [] }); });
    await migration.analyze(cid);
    expect(calls).toHaveLength(2);
    calls.forEach((sql) => {
      const setClause = sql.match(/DO UPDATE\s+SET([\s\S]*)$/i)[1];
      expect(setClause).not.toMatch(/\bkind\s*=/i);
      expect(setClause).not.toMatch(/\btarget_path\s*=/i);
      expect(setClause).not.toMatch(/\bstatus\s*=/i);
      expect(setClause).not.toMatch(/\bresolved_category_id\s*=/i);
      expect(setClause).toMatch(/product_count\s*=\s*EXCLUDED\.product_count/i);
      expect(sql).toMatch(/is_active/);
      expect(sql).toMatch(/stock_qty\s*>\s*0/);
      expect(sql).toMatch(/unit\s+IS\s+NULL\s+OR\s+unit\s*<>\s*'srv'/i);
      expect(sql).toMatch(/LIMIT 5/);
    });
    expect(calls[1]).toMatch(/SELECT \$1, NULL/); // 2a query = orfa, sempre
  });
});

describe('GET /categories/migration/proposal', () => {
  test('separa orfa, ordena por product_count desc, data em -03:00', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'i1', raw_value: 'Produtos', product_count: 50, sample_product_names: ['A'], kind: null, target_path: null, status: 'pending', resolved_category_id: null, resolved_at: null, created_at: new Date('2026-07-30T15:00:00Z'), updated_at: new Date() },
        { id: 'i0', raw_value: null, product_count: 681, sample_product_names: null, kind: null, target_path: null, status: 'pending', resolved_category_id: null, resolved_at: null, created_at: new Date(), updated_at: new Date() },
      ],
    });
    const res = await request(app).get(`/api/v1/companies/${cid}/categories/migration/proposal`).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.orphan.raw_value).toBeNull();
    expect(res.body.orphan.product_count).toBe(681);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].raw_value).toBe('Produtos');
    expect(res.body.items[0].created_at).toBe('2026-07-30T12:00:00-03:00');
  });
});

describe('PATCH /categories/migration/items/:itemId', () => {
  test('422 kind invalido / status invalido ("applied" incluso)', async () => {
    const r1 = await request(app).patch(`/api/v1/companies/${cid}/categories/migration/items/i1`)
      .set(adminAuth).send({ kind: 'inventado', status: 'approved' });
    expect(r1.status).toBe(422);
    expect(db.query).not.toHaveBeenCalled();

    const r2 = await request(app).patch(`/api/v1/companies/${cid}/categories/migration/items/i1`)
      .set(adminAuth).send({ kind: 'category', status: 'applied' });
    expect(r2.status).toBe(422);
  });

  test('kind!=category ignora target_path; kind=category grava', async () => {
    db.query.mockImplementation((sql, params) => Promise.resolve({
      rows: [{ id: 'i1', raw_value: 'x', product_count: 1, sample_product_names: [], kind: params[0], target_path: params[1], status: params[2], resolved_category_id: null, resolved_at: null, created_at: new Date(), updated_at: new Date() }] }));
    const r1 = await request(app).patch(`/api/v1/companies/${cid}/categories/migration/items/i1`)
      .set(adminAuth).send({ kind: 'brand', target_path: 'Feminino > Calcados', status: 'approved' });
    expect(r1.body.target_path).toBeNull();
    const r2 = await request(app).patch(`/api/v1/companies/${cid}/categories/migration/items/i1`)
      .set(adminAuth).send({ kind: 'category', target_path: 'Feminino > Calcados > Sandalias', status: 'approved' });
    expect(r2.body.target_path).toBe('Feminino > Calcados > Sandalias');
  });

  test('404 -- item de outra empresa/inexistente nao vaza', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).patch(`/api/v1/companies/${cid}/categories/migration/items/i-outro`)
      .set(adminAuth).send({ kind: 'discard', status: 'approved' });
    expect(res.status).toBe(404);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$4 AND company_id = \$5/);
    expect(params[4]).toBe(cid);
  });
});

describe('POST /categories/migration/apply', () => {
  test('pula orfa (SELECT filtra raw_value IS NOT NULL)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await migration.apply(cid);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/status = 'approved'/);
    expect(sql).toMatch(/raw_value IS NOT NULL/);
  });

  test.each([
    ['sem primaria previa', []],
    ['ja tem primaria (troca de verdade)', ['p-com-primaria']],
  ])('kind=category resolve, desmarca ANTES do insert, marca applied -- %s', async (_label, existingIds) => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'st1', raw_value: 'Sandalia Feminina', kind: 'category', target_path: 'Feminino > Calcados > Sandalias' }] });
    const productIds = existingIds.length ? existingIds : ['p1', 'p2'];
    const client = mkClient((sql) => {
      if (/SELECT id FROM product_categories/.test(sql)) return Promise.resolve({ rows: [{ id: 'cat-1' }] });
      if (/SELECT id FROM products WHERE/.test(sql)) return Promise.resolve({ rows: productIds.map(id => ({ id })) });
      return Promise.resolve({ rows: [] });
    });
    db.connect.mockImplementation(() => Promise.resolve(client));
    const result = await migration.apply(cid);
    expect(result.applied).toBe(1);
    expect(result.errors).toHaveLength(0);
    const calls = client.query.mock.calls.map(c => c[0]);
    const u = calls.findIndex(s => /SET is_primary = false/.test(s));
    const i = calls.findIndex(s => /INSERT INTO product_category_links/.test(s));
    expect(u).toBeGreaterThan(-1);
    expect(i).toBeGreaterThan(u);
    expect(client.query.mock.calls[u][1][0]).toEqual(productIds);
    expect(calls.some(s => /UPDATE products SET category/.test(s))).toBe(false);
    expect(calls.some(s => /status = 'applied'/.test(s))).toBe(true);
  });

  test('target_path inexistente: nao cria categoria, erro acionavel, linha continua approved', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'st1', raw_value: 'Chinelo Fantasia', kind: 'category', target_path: 'Nao Existe > Nada' }] });
    const client = mkClient(() => Promise.resolve({ rows: [] }));
    db.connect.mockImplementation(() => Promise.resolve(client));
    const result = await migration.apply(cid);
    expect(result.applied).toBe(0);
    expect(result.errors[0].error).toMatch(/nao existe na arvore/);
    const calls = client.query.mock.calls.map(c => c[0]);
    expect(calls.some(s => /INSERT INTO product_categories/.test(s))).toBe(false);
    expect(calls.some(s => /status = 'applied'/.test(s))).toBe(false);
  });

  test('kind nao-categoria limpa products.category so em produtos sem link', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'st2', raw_value: 'Outlet', kind: 'discard', target_path: null }] });
    const client = mkClient(() => Promise.resolve({ rows: [] }));
    db.connect.mockImplementation(() => Promise.resolve(client));
    await migration.apply(cid);
    const cleanup = client.query.mock.calls.find(([sql]) => /UPDATE products p SET category = NULL/.test(sql));
    expect(cleanup).toBeTruthy();
    expect(cleanup[0]).toMatch(/NOT EXISTS \(SELECT 1 FROM product_category_links/);
  });

  test('lote de 100 retomavel: 150 aprovados -> 2 lotes/2 conexoes', async () => {
    db.query.mockResolvedValueOnce({ rows: mkPending(150) });
    db.connect.mockImplementation(() => Promise.resolve(mkClient(() => Promise.resolve({ rows: [] }))));
    const result = await migration.apply(cid);
    expect(db.connect).toHaveBeenCalledTimes(2);
    expect(result.batches).toBe(2);
    expect(result.applied).toBe(150);
  });

  test('erro no meio de um lote nao desfaz anteriores e nao tenta os seguintes', async () => {
    db.query.mockResolvedValueOnce({ rows: mkPending(250) });
    let n = -1;
    db.connect.mockImplementation(() => {
      n++;
      const batch = n;
      const client = mkClient((sql) => (batch === 1 && /UPDATE products p SET category = NULL/.test(sql)
        ? Promise.reject(new Error('conexao caiu no meio do lote'))
        : Promise.resolve({ rows: [] })));
      return Promise.resolve(client);
    });
    const result = await migration.apply(cid);
    expect(result.batches).toBe(1);
    expect(db.connect).toHaveBeenCalledTimes(2); // 3o nunca tentado
    expect(result.errors.some(e => /Erro inesperado no lote/.test(e.error))).toBe(true);
  });
});

describe('GET /categories/migration/status', () => {
  test('orphans apos aplicacao parcial + state', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        { raw_value: null, status: 'pending', product_count: 681 },
        { raw_value: 'Produtos', status: 'applied', product_count: 50 },
        { raw_value: 'Feminino', status: 'approved', product_count: 39 },
        { raw_value: 'Outlet', status: 'pending', product_count: 28 },
      ],
    });
    const r1 = await request(app).get(`/api/v1/companies/${cid}/categories/migration/status`).set(adminAuth);
    expect(r1.body).toEqual({ state: 'in_progress', total: 3, approved: 1, applied: 1, orphans: 681 });

    db.query.mockResolvedValueOnce({ rows: [] });
    const r2 = await request(app).get(`/api/v1/companies/${cid}/categories/migration/status`).set(adminAuth);
    expect(r2.body.state).toBe('not_started');

    db.query.mockResolvedValueOnce({ rows: [{ raw_value: null, status: 'pending', product_count: 0 }, { raw_value: 'A', status: 'applied', product_count: 5 }] });
    const r3 = await request(app).get(`/api/v1/companies/${cid}/categories/migration/status`).set(adminAuth);
    expect(r3.body.state).toBe('done');
  });

  test('multi-tenant -- proposal sempre filtra por company_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await migration.getProposal(cid);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE company_id = \$1/);
    expect(params[0]).toBe(cid);
  });
});
