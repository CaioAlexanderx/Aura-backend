// ============================================================
// AURA. — Em qual loja o produto entra, B2: o lote (20/11/2026).
// Postgres real.
//
// O que este arquivo trava:
//   1. lista (batch-create) com lojas + estoque_em na filial: a origem fica
//      com 0, a filial recebe a copia com o estoque e o movimento de entrada;
//      por_loja com as duas
//   2. sem `lojas`: a resposta nao ganha nada (sem por_loja) e o produto
//      nasce privado, como sempre
//   3. D12: grupo de estoque unico — lista e planilha nascem compartilhadas
//      (a regra do POST /products); `lojas` nao copia nada
//   4. planilha com lojas: cada loja com o SEU lote (import_logs +
//      import_batch_id); desfazer o lote da filial apaga so a copia dela;
//      grade copiada com o estoque so na loja do estoque
//   5. Chegou mercadoria: o produto novo nasce na filial sem estoque, sem
//      custo e sem fornecedor; repetir a chave devolve o mesmo por_loja
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));
jest.mock('../src/services/onboardingProgress', () => ({ avancarSemEsperar: jest.fn() }));

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let app;
let colunasDeEmpresa = new Set();
// products.size, color, ncm e import_batch_id existem em producao mas nenhuma migration do
// repo os cria (o banco de CI nao tem). Mesmo desenho do
// stockReceipts.produtosNovos.banco.test.js: cria se faltar, tira no fim.
const COLUNAS_SO_DA_PRODUCAO = { size: 'TEXT', color: 'TEXT', ncm: 'TEXT', import_batch_id: 'UUID' };
const criadas = [];
let criouImportLogs = false;

const dono = uuid();
const usuarios = [dono];
const matriz = uuid();
const filial = uuid();
const unicoA = uuid();
const unicoB = uuid();
const sozinha = uuid();
const empresas = [filial, unicoB, matriz, unicoA, sozinha];

const q = (sql, params) => pool.query(sql, params);
const num = (v) => (v === null || v === undefined ? null : Number(v));
const porLojaDe = (body, id) => body.por_loja.find((l) => l.company_id === id);
const post = (url, body) => request(app).post(url).set('x-user', dono).send(body);

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.queryRetry = (sql, params) => pool.query(sql, params);
  db.connect.mockImplementation(async () => {
    const c = await pool.connect();
    return { query: (...a) => c.query(...a), release: (...a) => c.release(...a) };
  });
  const temProd = new Set((await q(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products'`)).rows.map((c) => c.column_name));
  for (const [c, tipo] of Object.entries(COLUNAS_SO_DA_PRODUCAO)) {
    if (!temProd.has(c)) { await q(`ALTER TABLE products ADD COLUMN ${c} ${tipo}`); criadas.push(c); }
  }
  // import_logs tambem so existe na producao.
  const { rows: temLogs } = await q(`SELECT to_regclass('public.import_logs') AS t`);
  if (!temLogs[0].t) {
    await q(`CREATE TABLE import_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID NOT NULL, module TEXT, format TEXT,
      total_rows INT, imported_rows INT, error_rows INT, batch_id UUID, created_by UUID, meta JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(), reverted_at TIMESTAMPTZ)`);
    criouImportLogs = true;
  }
  require('../src/services/copiaDeCadastro')._limparCacheDeColunas();
  colunasDeEmpresa = new Set((await q(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'companies'`)).rows.map((c) => c.column_name));

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Lote')`, [dono, `fixture-${dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan) VALUES ($1, $2, 'Matriz Lote', 'Matriz', 'negocio')`, [matriz, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan, billing_owner_company_id) VALUES ($1, $2, 'Filial Lote', 'Filial Centro', 'negocio', $3)`, [filial, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Unico A')`, [unicoA, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Unico B', $3)`, [unicoB, dono, unicoA]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Sozinha Lote')`, [sozinha, dono]);
  if (colunasDeEmpresa.has('share_products_in_group')) {
    await q(`UPDATE companies SET share_products_in_group = false WHERE id = $1`, [filial]);
  }

  app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || dono, plan: 'negocio' }; next(); });
  app.use('/companies/:id/products', require('../src/routes/productsBatch'));
  app.use('/companies/:id/products', require('../src/routes/stockReceipts'));
  app.use('/companies/:id', require('../src/routes/importData'));
}, 30000);

afterAll(async () => {
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 200));
  const limpar = [
    `DELETE FROM stock_receipts WHERE company_id = ANY($1)`,
    `DELETE FROM import_logs WHERE company_id = ANY($1)`,
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM product_suppliers WHERE company_id = ANY($1)`,
    `DELETE FROM product_category_links WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`,
    `DELETE FROM category_migration_staging WHERE company_id = ANY($1)`,
    `DELETE FROM products WHERE company_id = ANY($1)`,
    `DELETE FROM product_categories WHERE company_id = ANY($1)`,
    `DELETE FROM suppliers WHERE company_id = ANY($1)`,
  ];
  for (const sql of limpar) {
    try { await q(sql, [empresas]); } catch (e) { /* banco de CI e descartavel */ }
  }
  for (const id of empresas) {
    try { await q(`DELETE FROM companies WHERE id = $1`, [id]); } catch (e) { /* idem */ }
  }
  try { await q(`DELETE FROM users WHERE id = ANY($1)`, [usuarios]); } catch (e) { /* idem */ }
  if (criouImportLogs) { try { await q(`DROP TABLE IF EXISTS import_logs`); } catch (e) { /* idem */ } }
  for (const c of criadas) { try { await q(`ALTER TABLE products DROP COLUMN IF EXISTS ${c}`); } catch (e) { /* idem */ } }
  require('../src/services/copiaDeCadastro')._limparCacheDeColunas();
  await pool.end();
}, 30000);

describe('lista (batch-create)', () => {
  test('lojas + estoque_em na filial: a origem fica com 0, a filial recebe o estoque', async () => {
    const r = await post(`/companies/${matriz}/products/batch-create`, {
      lojas: [matriz, filial], estoque_em: filial,
      products: [{ name: 'Blusa lote', price: 59.9, stock_qty: 4, barcode: '7895550000011' }, { name: 'Saia lote', price: 89, stock_qty: 0 }],
    });
    expect(r.status).toBe(201);
    expect(r.body.total_created).toBe(2);
    expect(r.body.por_loja).toEqual([
      { company_id: matriz, nome: 'Matriz', criados: 2, ja_existiam: 0, erros: [] },
      { company_id: filial, nome: 'Filial Centro', criados: 2, ja_existiam: 0, erros: [] },
    ]);
    const blusa = r.body.created.find((c) => c.name === 'Blusa lote');
    const { rows: [orig] } = await q(`SELECT stock_qty, master_sku, is_group_shared FROM products WHERE id = $1`, [blusa.id]);
    expect(num(orig.stock_qty)).toBe(0);
    expect(orig.is_group_shared).toBe(false);
    const { rows: [copia] } = await q(`SELECT id, stock_qty, master_sku, barcode, is_group_shared FROM products WHERE company_id = $1 AND name = 'Blusa lote'`, [filial]);
    expect(num(copia.stock_qty)).toBe(4);
    expect(copia).toMatchObject({ master_sku: orig.master_sku, barcode: '7895550000011', is_group_shared: false });
    const { rows: movs } = await q(`SELECT type, quantity FROM stock_movements WHERE product_id = $1`, [copia.id]);
    expect(movs.map((m) => [m.type, num(m.quantity)])).toEqual([['in', 4]]);
  });

  test('sem lojas: a resposta de sempre (sem por_loja) e o produto privado', async () => {
    const r = await post(`/companies/${matriz}/products/batch-create`, { products: [{ name: 'Sem lojas', price: 10, stock_qty: 2 }] });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(['categorias', 'created', 'duplicates', 'errors', 'total_created', 'total_requested']);
    const { rows } = await q(`SELECT company_id, stock_qty, is_group_shared, master_sku FROM products WHERE name = 'Sem lojas' AND company_id = ANY($1)`, [[matriz, filial]]);
    expect(rows).toEqual([{ company_id: matriz, stock_qty: expect.anything(), is_group_shared: false, master_sku: null }]);
    expect(num(rows[0].stock_qty)).toBe(2);
  });

  test('loja sem grupo: privado, como sempre', async () => {
    const r = await post(`/companies/${sozinha}/products/batch-create`, { products: [{ name: 'Da sozinha', price: 10 }] });
    expect(r.status).toBe(201);
    const { rows: [p] } = await q(`SELECT is_group_shared FROM products WHERE company_id = $1 AND name = 'Da sozinha'`, [sozinha]);
    expect(p.is_group_shared).toBe(false);
  });

  test('D12: grupo de estoque unico nasce compartilhado; lojas nao copia', async () => {
    const r = await post(`/companies/${unicoA}/products/batch-create`, { lojas: [unicoA, unicoB], products: [{ name: 'Do grupo unico', price: 10, stock_qty: 1 }] });
    expect(r.status).toBe(201);
    const { rows } = await q(`SELECT company_id, is_group_shared FROM products WHERE name = 'Do grupo unico'`);
    expect(rows).toEqual([{ company_id: unicoA, is_group_shared: true }]);
    expect(r.body.por_loja).toEqual([{ company_id: unicoA, nome: 'Unico A', criados: 1, ja_existiam: 0, erros: [] }]);
  });

  test('lojas sem a loja do caminho ou estoque_em fora da lista: 400 e nada grava', async () => {
    const a = await post(`/companies/${matriz}/products/batch-create`, { lojas: [filial], products: [{ name: 'Nao entra 1', price: 1 }] });
    expect(a.status).toBe(400);
    expect(a.body.code).toBe('LOJAS_INVALIDAS');
    const b = await post(`/companies/${matriz}/products/batch-create`, { lojas: [matriz], estoque_em: filial, products: [{ name: 'Nao entra 2', price: 1 }] });
    expect(b.status).toBe(400);
    expect(num((await q(`SELECT COUNT(*) AS n FROM products WHERE name LIKE 'Nao entra%'`)).rows[0].n)).toBe(0);
  });
});

describe('planilha (products/import)', () => {
  test('lojas: cada loja com o seu lote; desfazer o da filial apaga so a copia dela', async () => {
    const r = await post(`/companies/${matriz}/products/import`, {
      lojas: [matriz, filial],
      column_map: { Nome: 'name', Preco: 'price', Estoque: 'stock_qty', Codigo: 'barcode' },
      rows: [
        { Nome: 'Camiseta planilha', Preco: '49,90', Estoque: '5', Codigo: '7895550000028' },
        { Nome: 'Bermuda planilha', Preco: '79,90', Estoque: '3', Codigo: '' },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.saved).toBe(2);
    expect(porLojaDe(r.body, matriz)).toMatchObject({ criados: 2, erros: [] });
    expect(porLojaDe(r.body, filial)).toMatchObject({ nome: 'Filial Centro', criados: 2, ja_existiam: 0, erros: [] });

    // estoque na origem (estoque_em padrao); a filial nasce com 0
    const { rows: [orig] } = await q(`SELECT stock_qty, import_batch_id FROM products WHERE company_id = $1 AND name = 'Camiseta planilha'`, [matriz]);
    expect(num(orig.stock_qty)).toBe(5);
    expect(orig.import_batch_id).toBe(r.body.batch_id);
    const { rows: [copia] } = await q(`SELECT stock_qty, import_batch_id FROM products WHERE company_id = $1 AND name = 'Camiseta planilha'`, [filial]);
    expect(num(copia.stock_qty)).toBe(0);
    expect(copia.import_batch_id).toBeTruthy();
    expect(copia.import_batch_id).not.toBe(r.body.batch_id);

    const { rows: logs } = await q(`SELECT company_id, imported_rows, batch_id FROM import_logs WHERE batch_id = $1`, [copia.import_batch_id]);
    expect(logs).toEqual([{ company_id: filial, imported_rows: 2, batch_id: copia.import_batch_id }]);

    const undo = await request(app).delete(`/companies/${filial}/imports/${copia.import_batch_id}`).set('x-user', dono);
    expect(undo.status).toBe(200);
    expect(undo.body.deleted_count).toBe(2);
    expect(num((await q(`SELECT COUNT(*) AS n FROM products WHERE company_id = $1 AND name LIKE '%planilha'`, [filial])).rows[0].n)).toBe(0);
    expect(num((await q(`SELECT COUNT(*) AS n FROM products WHERE company_id = $1 AND name LIKE '%planilha'`, [matriz])).rows[0].n)).toBe(2);
  });

  test('grade com estoque_em na filial: variantes copiadas, estoque so na filial', async () => {
    const r = await post(`/companies/${matriz}/products/import`, {
      lojas: [matriz, filial], estoque_em: filial,
      column_map: { Nome: 'name', Preco: 'price', Estoque: 'stock_qty', SKU: 'sku', Cor: 'color', Tamanho: 'size' },
      rows: [
        { Nome: 'Vestido grade', Preco: '120', Estoque: '2', SKU: 'VG-1', Cor: 'Preto', Tamanho: 'P' },
        { Nome: 'Vestido grade', Preco: '120', Estoque: '3', SKU: 'VG-1', Cor: 'Preto', Tamanho: 'M' },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.grade).toMatchObject({ modelos: 1, variacoes: 2 });
    expect(porLojaDe(r.body, filial)).toMatchObject({ criados: 1, erros: [] });
    const estoqueDaGrade = async (loja) => (await q(
      `SELECT v.sku_suffix, v.stock_qty FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE p.company_id = $1 AND p.name = 'Vestido grade' AND v.is_active = true ORDER BY v.sku_suffix`, [loja]))
      .rows.map((x) => [x.sku_suffix, num(x.stock_qty)]);
    const naFilial = await estoqueDaGrade(filial);
    expect(naFilial.map((x) => x[1]).sort()).toEqual([2, 3]);
    expect((await estoqueDaGrade(matriz)).map((x) => x[1])).toEqual([0, 0]);
    expect(naFilial.map((x) => x[0])).toEqual((await estoqueDaGrade(matriz)).map((x) => x[0]));
  });

  test('sem lojas: sem por_loja', async () => {
    const r = await post(`/companies/${matriz}/products/import`, {
      column_map: { Nome: 'name', Preco: 'price' }, rows: [{ Nome: 'Avulso planilha sem lojas', Preco: '9' }],
    });
    expect(r.status).toBe(201);
    expect(r.body.por_loja).toBeUndefined();
    expect(num((await q(`SELECT COUNT(*) AS n FROM products WHERE name = 'Avulso planilha sem lojas'`)).rows[0].n)).toBe(1);
  });

  test('D12: grupo de estoque unico, a planilha nasce compartilhada', async () => {
    const r = await post(`/companies/${unicoA}/products/import`, {
      column_map: { Nome: 'name', Preco: 'price' }, rows: [{ Nome: 'Planilha do grupo unico', Preco: '9' }],
    });
    expect(r.status).toBe(201);
    const { rows: [p] } = await q(`SELECT is_group_shared FROM products WHERE company_id = $1 AND name = 'Planilha do grupo unico'`, [unicoA]);
    expect(p.is_group_shared).toBe(true);
  });
});

describe('Chegou mercadoria (stock-receipts)', () => {
  test('produto novo tambem na filial: sem estoque, sem custo, sem fornecedor; a chave repete o por_loja', async () => {
    const { rows: [forn] } = await q(`INSERT INTO suppliers (company_id, name) VALUES ($1, 'Distribuidora Lote') RETURNING id`, [matriz]);
    const corpo = {
      idempotency_key: uuid(), supplier_id: forn.id, invoice_number: '77', origin: 'nota', lojas: [matriz, filial],
      items: [{ new_product: { name: 'Tenis da nota', price: 199.9, barcode: '7895550000035' }, quantity: 6, unit_cost: 80 }],
    };
    const r = await post(`/companies/${matriz}/products/stock-receipts`, corpo);
    expect(r.status).toBe(201);
    expect(r.body.por_loja).toEqual([
      { company_id: matriz, nome: 'Matriz', criados: 1, ja_existiam: 0, erros: [] },
      { company_id: filial, nome: 'Filial Centro', criados: 1, ja_existiam: 0, erros: [] },
    ]);
    const { rows: [orig] } = await q(`SELECT stock_qty, cost_price, supplier_id, master_sku FROM products WHERE company_id = $1 AND name = 'Tenis da nota'`, [matriz]);
    expect(num(orig.stock_qty)).toBe(6);
    expect(num(orig.cost_price)).toBe(80);
    const { rows: [copia] } = await q(`SELECT * FROM products WHERE company_id = $1 AND name = 'Tenis da nota'`, [filial]);
    expect(num(copia.stock_qty)).toBe(0);
    expect(num(copia.cost_price)).toBe(0);
    expect(copia.supplier_id).toBeNull();
    expect(copia.barcode).toBe('7895550000035');
    expect(copia.master_sku).toBe(orig.master_sku);
    expect(num(copia.price)).toBe(199.9);
    if ('weighted_avg_cost' in copia) expect(copia.weighted_avg_cost).toBeNull();
    expect((await q(`SELECT 1 FROM product_suppliers WHERE product_id = $1`, [copia.id])).rows).toEqual([]);
    expect((await q(`SELECT 1 FROM stock_movements WHERE product_id = $1`, [copia.id])).rows).toEqual([]);

    const de_novo = await post(`/companies/${matriz}/products/stock-receipts`, corpo);
    expect(de_novo.status).toBe(200);
    expect(de_novo.body.repeated).toBe(true);
    expect(de_novo.body.por_loja).toEqual(r.body.por_loja);
    expect(num((await q(`SELECT COUNT(*) AS n FROM products WHERE company_id = $1 AND name = 'Tenis da nota'`, [filial])).rows[0].n)).toBe(1);
  });

  test('sem lojas: a resposta de sempre', async () => {
    const r = await post(`/companies/${matriz}/products/stock-receipts`, {
      idempotency_key: uuid(), items: [{ new_product: { name: 'Meia da nota', price: 19.9 }, quantity: 2 }],
    });
    expect(r.status).toBe(201);
    expect(r.body.por_loja).toBeUndefined();
    expect(num((await q(`SELECT COUNT(*) AS n FROM products WHERE company_id = $1 AND name = 'Meia da nota'`, [filial])).rows[0].n)).toBe(0);
  });
});
