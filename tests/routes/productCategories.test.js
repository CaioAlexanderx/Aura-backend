// ============================================================
// AURA. -- Testes: rotas de arvore de categorias (F0 Bloco B1)
//
// Nao havia testes existentes para src/routes/productCategories.js antes
// deste PR (nenhum arquivo em tests/ referenciava a rota legada) -- este
// arquivo e criado do zero e cobre tanto o CRUD absorvido quanto os
// endpoints novos.
//
// Mock por SQL (mockImplementation casando o texto da query), NUNCA fila
// posicional -- um gate novo entra na frente e desalinha tudo. beforeEach
// com resetAllMocks -- clearAllMocks nao purga a fila de
// mockResolvedValueOnce entre testes. requireCompanyAccess consome
// db.query e e sempre o primeiro mock (reconhecido aqui pelo texto
// "company_members").
// ============================================================
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0'; // Davi Matriz
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };
const BASE = `/api/v1/companies/${cid}`;

// Mocka db.query por padrao de SQL. requireCompanyAccess (auth.js) sempre
// bate primeiro -- respondido aqui de forma generica com 'owner'.
function mockDbBySql(pairs) {
  db.query.mockImplementation((sql, params) => {
    if (/company_members/.test(sql)) return Promise.resolve({ rows: [{ role: 'owner' }] });
    for (const [pattern, val] of pairs) {
      if (pattern.test(sql)) {
        const out = typeof val === 'function' ? val(params) : val;
        return out instanceof Promise ? out : Promise.resolve(out);
      }
    }
    return Promise.resolve({ rows: [] });
  });
}

// Cliente transacional mockado (db.connect()). BEGIN/COMMIT/ROLLBACK sempre
// respondem { rows: [] } sem precisar entrar nos pares.
function mockClientBySql(pairs) {
  const calls = [];
  const query = jest.fn((sql, params) => {
    calls.push({ sql, params });
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(sql)) return Promise.resolve({ rows: [] });
    for (const [pattern, val] of pairs) {
      if (pattern.test(sql)) {
        const out = typeof val === 'function' ? val(params) : val;
        return out instanceof Promise ? out : Promise.resolve(out);
      }
    }
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn(), calls };
}

// ── Aceite: nenhuma escrita em products.category sobrou no arquivo -------
describe('Aceite -- products.category nunca escrito pela rota', () => {
  test('grep: nenhum "SET category" em src/routes/productCategories.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/productCategories.js'), 'utf8');
    expect(src).not.toMatch(/SET\s+category\b/i);
  });
});

// ── GET / -- shape legado preservado ---------------------------------------
describe('GET /product-categories -- shape legado exato', () => {
  test('200 -- { categories, total, type }, com path no objeto (regressao companiesApi.ts)', async () => {
    mockDbBySql([
      [/FROM product_categories c/, { rows: [
        { id: 'cat-1', name: 'Botas', color: '#111111', sort_order: 0, type: 'product', path: '/feminino/calcados/botas', created_at: new Date(), updated_at: new Date(), product_count: 5 },
      ] }],
    ]);
    const res = await request(app).get(`${BASE}/product-categories`).set(auth);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['categories', 'total', 'type']);
    expect(res.body.type).toBe('product');
    expect(res.body.total).toBe(1);
    expect(res.body.categories[0]).toHaveProperty('path', '/feminino/calcados/botas');
    expect(res.body.categories[0]).toHaveProperty('product_count', 5);
  });

  test('?type=service continua bilingue -- retrocompat (decisao C1)', async () => {
    mockDbBySql([[/FROM product_categories c/, { rows: [] }]]);
    const res = await request(app).get(`${BASE}/product-categories?type=service`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('service');
  });
});

// ── GET /tree ----------------------------------------------------------------
describe('GET /product-categories/tree', () => {
  test('200 -- aninhado, product_count_total correto em 3 niveis', async () => {
    const rows = [
      { id: 'r-fem', company_id: cid, type: 'product', parent_id: null, name: 'Feminino', slug: 'feminino', path: '/feminino', depth: 0, sort_order: 0, product_count: 0, product_count_total: 6 },
      { id: 'r-calc', company_id: cid, type: 'product', parent_id: 'r-fem', name: 'Calcados', slug: 'calcados', path: '/feminino/calcados', depth: 1, sort_order: 0, product_count: 1, product_count_total: 6 },
      { id: 'r-botas', company_id: cid, type: 'product', parent_id: 'r-calc', name: 'Botas', slug: 'botas', path: '/feminino/calcados/botas', depth: 2, sort_order: 0, product_count: 5, product_count_total: 5 },
    ];
    mockDbBySql([[/WITH RECURSIVE tree AS/, { rows }]]);
    const res = await request(app).get(`${BASE}/product-categories/tree`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('product');
    const fem = res.body.categories[0];
    expect(fem.name).toBe('Feminino');
    expect(fem.depth).toBe(0);
    expect(fem.product_count_total).toBe(6);
    const calc = fem.children[0];
    expect(calc.depth).toBe(1);
    const botas = calc.children[0];
    expect(botas.depth).toBe(2);
    expect(botas.product_count).toBe(5);
  });
});

// ── POST / -- decisao C1 (service flat) -------------------------------------
describe('POST /product-categories -- decisao C1', () => {
  test('201 -- type=service forca parent_id NULL mesmo se enviado no body', async () => {
    let insertedParentId = 'nao-setado';
    db.query.mockImplementation((sql, params) => {
      if (/company_members/.test(sql)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/INSERT INTO product_categories/.test(sql)) {
        insertedParentId = params[5];
        return Promise.resolve({ rows: [{ id: 'svc-1', type: 'service', parent_id: null }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app)
      .post(`${BASE}/product-categories`)
      .set(auth)
      .send({ name: 'Manutencao', type: 'service', parent_id: 'algum-pai' });
    expect(res.status).toBe(201);
    expect(insertedParentId).toBeNull();
  });

  test('400 -- name obrigatorio', async () => {
    mockDbBySql([]);
    const res = await request(app).post(`${BASE}/product-categories`).set(auth).send({});
    expect(res.status).toBe(400);
  });
});

// ── PATCH /:catId -- sem cascata manual ---------------------------------------
describe('PATCH /product-categories/:catId', () => {
  test('200 -- affected_products deriva da contagem de product_category_links (nao de rowCount de UPDATE em products)', async () => {
    mockDbBySql([
      [/UPDATE product_categories SET/, { rows: [{ id: 'cat-1', name: 'Botas Novo', company_id: cid }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM product_category_links WHERE category_id = \$1/, { rows: [{ n: 7 }] }],
    ]);
    const res = await request(app)
      .patch(`${BASE}/product-categories/cat-1`)
      .set(auth)
      .send({ name: 'Botas Novo' });
    expect(res.status).toBe(200);
    expect(res.body.affected_products).toBe(7);
  });

  test('404 -- categoria nao encontrada', async () => {
    mockDbBySql([[/UPDATE product_categories SET/, { rows: [] }]]);
    const res = await request(app).patch(`${BASE}/product-categories/cat-x`).set(auth).send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /:catId -- reescrita completa (decisao B1) -------------------------
describe('DELETE /product-categories/:catId -- decisao B1', () => {
  test('409 CATEGORY_HAS_CHILDREN -- nunca 500 (antes da FK RESTRICT estourar)', async () => {
    const client = mockClientBySql([
      [/SELECT id, type FROM product_categories WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, { rows: [{ id: 'cat-1', type: 'product' }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM product_categories WHERE parent_id = \$1/, { rows: [{ n: 2 }] }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app).delete(`${BASE}/product-categories/cat-1`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATEGORY_HAS_CHILDREN');
    expect(res.body.children_count).toBe(2);
    expect(client.calls.some((c) => /^DELETE FROM product_categories/.test(c.sql.trim()))).toBe(false);
  });

  test('409 CATEGORY_HAS_PRODUCTS -- links existem e move_to nao veio', async () => {
    const client = mockClientBySql([
      [/SELECT id, type FROM product_categories WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, { rows: [{ id: 'cat-1', type: 'product' }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM product_categories WHERE parent_id = \$1/, { rows: [{ n: 0 }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM product_category_links WHERE category_id = \$1/, { rows: [{ n: 12 }] }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app).delete(`${BASE}/product-categories/cat-1`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATEGORY_HAS_PRODUCTS');
    expect(res.body.product_count).toBe(12);
  });

  test('?move_to=<uuid> resolve por id, move os LINKS (nunca o texto), termina com link no destino', async () => {
    const client = mockClientBySql([
      [/SELECT id, type FROM product_categories WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, { rows: [{ id: 'cat-1', type: 'product' }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM product_categories WHERE parent_id = \$1/, { rows: [{ n: 0 }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM product_category_links WHERE category_id = \$1/, { rows: [{ n: 3 }] }],
      [/WHERE id = \$1 AND company_id = \$2 AND type = \$3/, { rows: [{ id: 'cat-dest' }] }],
      [/SELECT product_id FROM product_category_links WHERE category_id = ANY/, { rows: [{ product_id: 'p1' }] }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app)
      .delete(`${BASE}/product-categories/cat-1?move_to=ea68b4d2-f051-46b1-9ac5-b8438c6cd5fc`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.moved_products).toBe(3);
    const sqlTexts = client.calls.map((c) => c.sql);
    expect(sqlTexts.some((s) => /INSERT INTO product_category_links/.test(s) && s.includes('DO NOTHING'))).toBe(true);
    expect(sqlTexts.some((s) => /^DELETE FROM product_category_links WHERE category_id = ANY/.test(s.trim()))).toBe(true);
    expect(sqlTexts.some((s) => s.includes('SET is_primary = true'))).toBe(true);
    expect(sqlTexts.some((s) => /^DELETE FROM product_categories WHERE id = \$1 AND company_id = \$2/.test(s.trim()))).toBe(true);
    expect(sqlTexts.some((s) => /UPDATE\s+products\b.*SET\s+category/is.test(s))).toBe(false);
  });

  test('?move_to=<nome> ambiguo -- 409 CATEGORY_DUPLICATE com candidatos (id, path)', async () => {
    const client = mockClientBySql([
      [/SELECT id, type FROM product_categories WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, { rows: [{ id: 'cat-1', type: 'product' }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM product_categories WHERE parent_id = \$1/, { rows: [{ n: 0 }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM product_category_links WHERE category_id = \$1/, { rows: [{ n: 3 }] }],
      [/name_norm = lower\(btrim\(\$3\)\)/, { rows: [
        { id: 'cat-a', path: '/feminino/calcados/botas' },
        { id: 'cat-b', path: '/infantil/botas' },
      ] }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app).delete(`${BASE}/product-categories/cat-1?move_to=Botas`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATEGORY_DUPLICATE');
    expect(res.body.candidates).toHaveLength(2);
  });
});

// ── POST /merge ----------------------------------------------------------------
describe('POST /product-categories/merge', () => {
  test('200 -- move todos os links sem violar PK nem one_primary', async () => {
    const client = mockClientBySql([
      [/SELECT id, type FROM product_categories WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, { rows: [{ id: 'target-1', type: 'product' }] }],
      [/SELECT id FROM product_categories WHERE id = ANY\(\$1::uuid\[\]\) AND company_id = \$2 AND type = \$3 FOR UPDATE/, { rows: [{ id: 'src-1' }, { id: 'src-2' }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM product_categories WHERE parent_id = ANY/, { rows: [{ n: 0 }] }],
      [/SELECT product_id FROM product_category_links WHERE category_id = ANY/, { rows: [{ product_id: 'p1' }] }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app)
      .post(`${BASE}/product-categories/merge`)
      .set(auth)
      .send({ source_ids: ['src-1', 'src-2'], target_id: 'target-1' });
    expect(res.status).toBe(200);
    expect(res.body.merged).toBe(true);
    const sqlTexts = client.calls.map((c) => c.sql);
    expect(sqlTexts.some((s) => s.includes('ON CONFLICT (product_id, category_id) DO NOTHING'))).toBe(true);
    expect(sqlTexts.some((s) => /^DELETE FROM product_category_links WHERE category_id = ANY/.test(s.trim()))).toBe(true);
    expect(sqlTexts.some((s) => /DELETE FROM product_categories WHERE id = ANY/.test(s))).toBe(true);
  });

  test('409 CATEGORY_HAS_CHILDREN -- categoria de origem tem subcategorias', async () => {
    const client = mockClientBySql([
      [/SELECT id, type FROM product_categories WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, { rows: [{ id: 'target-1', type: 'product' }] }],
      [/SELECT id FROM product_categories WHERE id = ANY\(\$1::uuid\[\]\) AND company_id = \$2 AND type = \$3 FOR UPDATE/, { rows: [{ id: 'src-1' }] }],
      [/SELECT COUNT\(\*\)::int AS n FROM product_categories WHERE parent_id = ANY/, { rows: [{ n: 1 }] }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app)
      .post(`${BASE}/product-categories/merge`)
      .set(auth)
      .send({ source_ids: ['src-1'], target_id: 'target-1' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATEGORY_HAS_CHILDREN');
  });
});

// ── POST /reorder --------------------------------------------------------------
describe('POST /product-categories/reorder', () => {
  test('200 -- atualiza sort_order via unnest WITH ORDINALITY', async () => {
    mockDbBySql([
      [/UPDATE product_categories AS c/, { rowCount: 3, rows: [] }],
    ]);
    const res = await request(app)
      .post(`${BASE}/product-categories/reorder`)
      .set(auth)
      .send({ parent_id: 'cat-parent', ordered_ids: ['cat-a', 'cat-b', 'cat-c'] });
    expect(res.status).toBe(200);
    expect(res.body.reordered).toBe(3);
  });

  test('400 -- ordered_ids[] obrigatorio', async () => {
    mockDbBySql([]);
    const res = await request(app)
      .post(`${BASE}/product-categories/reorder`)
      .set(auth)
      .send({ parent_id: 'cat-parent', ordered_ids: [] });
    expect(res.status).toBe(400);
  });
});

// ── POST /clone-from -------------------------------------------------------------
describe('POST /product-categories/clone-from', () => {
  test('201 -- copia estrutura e sort_order, nenhum produto', async () => {
    const insertedNames = [];
    const client = mockClientBySql([
      [/target_group/, { rows: [{ target_group: cid, source_group: cid }] }],
      [/SELECT id, parent_id, name, sort_order, color/, { rows: [
        { id: 'src-root', parent_id: null, name: 'Feminino', sort_order: 0, color: null },
        { id: 'src-child', parent_id: 'src-root', name: 'Calcados', sort_order: 0, color: null },
      ] }],
      [/INSERT INTO product_categories/, (params) => {
        insertedNames.push(params[2]); // VALUES ($1,'product',$2,$3,$4,$5) -- params[2] = $3 = name
        return { rows: [{ id: `new-${insertedNames.length}` }] };
      }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app)
      .post(`${BASE}/product-categories/clone-from`)
      .set(auth)
      .send({ source_company_id: 'ea68b4d2-f051-46b1-9ac5-b8438c6cd5fc' });
    expect(res.status).toBe(201);
    expect(res.body.cloned).toBe(2);
    expect(insertedNames).toEqual(['Feminino', 'Calcados']);
    const allSql = client.calls.map((c) => c.sql).join('\n');
    expect(allSql).not.toMatch(/INSERT INTO products\b/);
  });

  test('403 -- source_company_id fora do grupo de faturamento', async () => {
    const client = mockClientBySql([
      [/target_group/, { rows: [{ target_group: 'group-a', source_group: 'group-b' }] }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app)
      .post(`${BASE}/product-categories/clone-from`)
      .set(auth)
      .send({ source_company_id: '11111111-1111-1111-1111-111111111111' });
    expect(res.status).toBe(403);
  });
});

// ── POST /products/categories/bulk --------------------------------------------
describe('POST /products/categories/bulk', () => {
  test('400 -- acima do teto de 100', async () => {
    mockDbBySql([]);
    const res = await request(app)
      .post(`${BASE}/products/categories/bulk`)
      .set(auth)
      .send({ product_ids: Array.from({ length: 101 }, (_, i) => `p${i}`), primary_category_id: 'cat-1', mode: 'add_secondary' });
    expect(res.status).toBe(400);
  });

  test("mode 'replace_primary' troca a primaria de quem ja tem uma -- UPDATE (perde A) vem ANTES do INSERT (ganha B)", async () => {
    const client = mockClientBySql([
      [/SELECT id FROM products WHERE id = ANY/, { rows: [{ id: 'p1' }] }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app)
      .post(`${BASE}/products/categories/bulk`)
      .set(auth)
      .send({ product_ids: ['p1'], primary_category_id: 'cat-B', mode: 'replace_primary' });
    expect(res.status).toBe(200);
    const sqlTexts = client.calls.map((c) => c.sql);
    const updIdx = sqlTexts.findIndex((s) => s.includes('SET is_primary = false'));
    const insIdx = sqlTexts.findIndex((s) => s.includes('DO UPDATE SET is_primary = true'));
    expect(updIdx).toBeGreaterThanOrEqual(0);
    expect(insIdx).toBeGreaterThanOrEqual(0);
    expect(updIdx).toBeLessThan(insIdx); // ordem obrigatoria -- contrato secao 6.1
  });

  test("mode 'add_secondary' usa DO NOTHING -- correto pra secundaria", async () => {
    const client = mockClientBySql([
      [/SELECT id FROM products WHERE id = ANY/, { rows: [{ id: 'p1' }] }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app)
      .post(`${BASE}/products/categories/bulk`)
      .set(auth)
      .send({ product_ids: ['p1'], primary_category_id: 'cat-C', mode: 'add_secondary' });
    expect(res.status).toBe(200);
    const sqlTexts = client.calls.map((c) => c.sql);
    expect(sqlTexts.some((s) => s.includes('is_primary') && s.includes('ON CONFLICT DO NOTHING'))).toBe(true);
    expect(sqlTexts.some((s) => s.includes('SET is_primary = false'))).toBe(false);
  });

  test("400 -- mode invalido", async () => {
    mockDbBySql([]);
    const res = await request(app)
      .post(`${BASE}/products/categories/bulk`)
      .set(auth)
      .send({ product_ids: ['p1'], primary_category_id: 'cat-1', mode: 'invalido' });
    expect(res.status).toBe(400);
  });
});

// ── PUT /products/:productId/categories ----------------------------------------
describe('PUT /products/:productId/categories', () => {
  test('200 -- substitui vinculos (delete total + insert com primaria correta)', async () => {
    const client = mockClientBySql([
      [/SELECT id FROM products WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, { rows: [{ id: 'prod-1' }] }],
      [/SELECT id FROM product_categories WHERE id = ANY/, (params) => ({ rows: params[0].map((catId) => ({ id: catId })) })],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app)
      .put(`${BASE}/products/prod-1/categories`)
      .set(auth)
      .send({ primary_category_id: 'cat-A', also_in: ['cat-B', 'cat-C'] });
    expect(res.status).toBe(200);
    const sqlTexts = client.calls.map((c) => c.sql);
    expect(sqlTexts.some((s) => /^DELETE FROM product_category_links WHERE product_id = \$1/.test(s.trim()))).toBe(true);
    expect(sqlTexts.some((s) => /INSERT INTO product_category_links/.test(s))).toBe(true);
  });

  test('404 -- produto nao encontrado', async () => {
    const client = mockClientBySql([
      [/SELECT id FROM products WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, { rows: [] }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app)
      .put(`${BASE}/products/nao-existe/categories`)
      .set(auth)
      .send({ primary_category_id: 'cat-A' });
    expect(res.status).toBe(404);
  });
});

// ── GET /products/unclassified -- definicao contraintuitiva (secao 5.7) --------
describe('GET /products/unclassified', () => {
  test('200 -- responde de verdade, NAO capturada por GET /products/:id de ./products (app inteiro montado)', async () => {
    db.query.mockImplementation((sql) => {
      if (/company_members/.test(sql)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/SELECT COUNT\(\*\)::int AS total FROM products p/.test(sql)) return Promise.resolve({ rows: [{ total: 911 }] });
      if (/SELECT p\.id, p\.name, p\.sku/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app)
      .get(`${BASE}/products/unclassified?has_stock=true`)
      .set(auth);
    // Hoje (0 links na base): devolve TODOS os vendaveis -- 911 e correto,
    // NAO 681 (numero pos-migracao) nem 0. Briefing secao 5.7.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total', 911);
    expect(res.body).toHaveProperty('products');
    expect(res.body).not.toHaveProperty('name'); // nao e o shape de 1 produto (provaria captura por GET /:id)
  });

  test('?q= usa unaccent(lower(...)) -- insensivel a acento e caixa', async () => {
    let capturedSql = null;
    db.query.mockImplementation((sql) => {
      if (/company_members/.test(sql)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/unaccent/.test(sql)) capturedSql = sql;
      if (/COUNT\(\*\)::int AS total/.test(sql)) return Promise.resolve({ rows: [{ total: 0 }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get(`${BASE}/products/unclassified?q=Botas`).set(auth);
    expect(res.status).toBe(200);
    expect(capturedSql).toMatch(/unaccent\(lower\(p\.name\)\) LIKE unaccent\(lower\(/);
  });

  test('orfao = SEM link primario -- WHERE usa product_category_links, NUNCA category IS NULL', async () => {
    let capturedSql = null;
    db.query.mockImplementation((sql) => {
      if (/company_members/.test(sql)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/FROM products p WHERE/.test(sql) && !capturedSql) capturedSql = sql;
      return Promise.resolve({ rows: [{ total: 0 }] });
    });
    await request(app).get(`${BASE}/products/unclassified`).set(auth);
    expect(capturedSql).toMatch(/NOT EXISTS \(SELECT 1 FROM product_category_links l WHERE l\.product_id = p\.id AND l\.is_primary\)/);
    expect(capturedSql).not.toMatch(/category IS NULL/);
  });

  test('paginado -- limit e offset ecoados, total vem do COUNT', async () => {
    db.query.mockImplementation((sql) => {
      if (/company_members/.test(sql)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/COUNT\(\*\)::int AS total/.test(sql)) return Promise.resolve({ rows: [{ total: 250 }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get(`${BASE}/products/unclassified?limit=20&offset=40`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(250);
    expect(res.body.limit).toBe(20);
    expect(res.body.offset).toBe(40);
  });
});

// ── Erros mapeados -- contrato secao 6 (6 erros, incluindo os 3 P0001) --------
describe('Erros mapeados -- contrato secao 6', () => {
  test('POST / -- 23505 unique_sibling vira 409 CATEGORY_DUPLICATE com existing_id', async () => {
    db.query.mockImplementation((sql) => {
      if (/company_members/.test(sql)) return Promise.resolve({ rows: [{ role: 'owner' }] });
      if (/INSERT INTO product_categories/.test(sql)) {
        const err = new Error('duplicate key value violates unique constraint "product_categories_unique_sibling"');
        err.code = '23505';
        err.constraint = 'product_categories_unique_sibling';
        return Promise.reject(err);
      }
      if (/name_norm = lower\(btrim\(\$4\)\)/.test(sql)) return Promise.resolve({ rows: [{ id: 'existing-1' }] });
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).post(`${BASE}/product-categories`).set(auth).send({ name: 'Botas' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATEGORY_DUPLICATE');
    expect(res.body.existing_id).toBe('existing-1');
  });

  test('POST /:catId/move -- 23514 depth_max vira 422 CATEGORY_MAX_DEPTH', async () => {
    mockDbBySql([[/UPDATE product_categories\s+SET parent_id/, () => {
      const err = new Error('new row violates check constraint "product_categories_depth_max"');
      err.code = '23514';
      err.constraint = 'product_categories_depth_max';
      throw err;
    }]]);
    const res = await request(app)
      .post(`${BASE}/product-categories/cat-1/move`)
      .set(auth)
      .send({ parent_id: null });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CATEGORY_MAX_DEPTH');
  });

  test('POST /:catId/move -- P0001 CATEGORY_CYCLE vira 422', async () => {
    mockDbBySql([
      // parent_id truthy -> rota confere que o pai existe ANTES do UPDATE.
      [/SELECT id FROM product_categories WHERE id = \$1 AND company_id = \$2 AND type = 'product'/, { rows: [{ id: 'cat-descendente' }] }],
      [/UPDATE product_categories\s+SET parent_id/, () => {
        const err = new Error('CATEGORY_CYCLE');
        err.code = 'P0001';
        throw err;
      }],
    ]);
    const res = await request(app)
      .post(`${BASE}/product-categories/cat-1/move`)
      .set(auth)
      .send({ parent_id: 'cat-descendente' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CATEGORY_CYCLE');
  });

  test('PUT /products/:productId/categories -- P0001 CATEGORY_CROSS_TENANT vira 403', async () => {
    const client = mockClientBySql([
      [/SELECT id FROM products WHERE id = \$1 AND company_id = \$2 FOR UPDATE/, { rows: [{ id: 'prod-1' }] }],
      [/SELECT id FROM product_categories WHERE id = ANY/, { rows: [{ id: 'cat-A' }] }],
      [/INSERT INTO product_category_links/, () => {
        const err = new Error('CATEGORY_CROSS_TENANT');
        err.code = 'P0001';
        throw err;
      }],
    ]);
    db.connect.mockResolvedValueOnce(client);
    mockDbBySql([]);
    const res = await request(app)
      .put(`${BASE}/products/prod-1/categories`)
      .set(auth)
      .send({ primary_category_id: 'cat-A' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CATEGORY_CROSS_TENANT');
  });
});

// ── 401 sem token (sanidade de auth, todas as rotas passam por requireAuth) ---
describe('401 sem token', () => {
  test.each([
    ['get', `${BASE}/product-categories`],
    ['get', `${BASE}/product-categories/tree`],
    ['get', `${BASE}/products/unclassified`],
  ])('%s %s -- 401', async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(401);
  });
});
