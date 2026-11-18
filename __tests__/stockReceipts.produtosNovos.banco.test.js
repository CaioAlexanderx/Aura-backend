// ============================================================
// AURA. — Produtos novos na entrada de vários itens (B2b, 17/11/2026) —
// Postgres real
//
// Item com new_product em vez de product_id: cadastra e dá entrada na mesma
// transação. O que este arquivo prova:
//   1. o produto novo fica igual a "cadastrar com estoque 0 e custo 0 e dar
//      entrada pelo caminho de um produto": estoque, custo médio, cost_price,
//      fornecedor principal, última compra, movimento; preço, categoria,
//      NCM, código de barras e unidade da linha
//   2. preço de venda obrigatório (pendência 6); código de barras que a loja
//      já usa ou repetido na entrada: 400 e nada grava
//   3. limite de produtos do plano: tudo ou nada (403 LIMITE_DO_PLANO);
//      plano maior passa
//   4. compartilhado no grupo pela regra do "+ Produto"; loja fora de grupo
//      não compartilha
//   5. a mesma chave de novo não cadastra outra vez
//   6. categoria que existe na árvore é ligada; a que não existe fica
//      pendente e não derruba a entrada
//   7. quem não vê custo cadastra sem custo
//   8. base sem products.ncm: cadastra sem o NCM
//
// products.ncm existe em produção, mas nenhuma migration do repo cria a
// coluna (o banco de CI não tem). O arquivo cria a coluna se faltar e a
// tira no fim, para provar os dois caminhos.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let app;
let criouNcm = false;

const dono = uuid();
const semCusto = uuid();
const usuarios = [dono, semCusto];
const matriz = uuid();
const filial = uuid();
const sozinha = uuid();
const cheia = uuid();
const empresas = [filial, sozinha, cheia, matriz];

const q = (sql, params) => pool.query(sql, params);
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function fornecedor(companyId, nome) {
  const { rows } = await q(`INSERT INTO suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [companyId, nome]);
  return rows[0].id;
}
async function produtoPorNome(companyId, nome) {
  const { rows } = await q(`SELECT * FROM products WHERE company_id = $1 AND name = $2`, [companyId, nome]);
  return rows;
}
async function retrato(pid) {
  const { rows: [p] } = await q(
    `SELECT name, price, category, ncm, barcode, unit, stock_qty, cost_price, weighted_avg_cost,
            supplier_id, supplier_name, last_supplier_name, last_purchase_unit_cost, is_group_shared
       FROM products WHERE id = $1`, [pid]);
  const { rows: ps } = await q(`SELECT supplier_id, cost, supplier_code, is_main FROM product_suppliers WHERE product_id = $1`, [pid]);
  const { rows: ms } = await q(`SELECT company_id, quantity, notes, supplier_id, unit_cost FROM stock_movements WHERE product_id = $1`, [pid]);
  return {
    produto: { ...p, price: num(p.price), stock_qty: num(p.stock_qty), cost_price: num(p.cost_price), weighted_avg_cost: num(p.weighted_avg_cost), last_purchase_unit_cost: num(p.last_purchase_unit_cost) },
    fornecedores: ps.map((r) => ({ ...r, cost: num(r.cost) })),
    movimentos: ms.map((m) => ({ ...m, quantity: num(m.quantity), unit_cost: num(m.unit_cost) })),
  };
}

const receber = (loja, body, { user = dono, plan } = {}) => {
  const r = request(app).post(`/companies/${loja}/products/stock-receipts`).set('x-user', user);
  if (plan) r.set('x-plan', plan);
  return r.send(body);
};

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.queryRetry = (sql, params) => pool.query(sql, params);
  db.connect.mockImplementation(async () => {
    const c = await pool.connect();
    return { query: (...a) => c.query(...a), release: (...a) => c.release(...a) };
  });

  const { rows: temNcm } = await q(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'ncm'`);
  if (!temNcm.length) { await q(`ALTER TABLE products ADD COLUMN ncm TEXT`); criouNcm = true; }

  for (const u of usuarios) {
    await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Novos')`, [u, `fixture-${u}@example.test`]);
  }
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Matriz Novos')`, [matriz, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Filial Novos', $3)`, [filial, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Sozinha Novos')`, [sozinha, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Cheia Novos')`, [cheia, dono]);
  await q(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active, permissions) VALUES ($1, $2, 'estoquista', 'active', true, $3)`,
    [sozinha, semCusto, JSON.stringify({ estoque: true, pdv: true, painel: false })]);

  const { estoqueSoConsulta } = require('../src/middleware/estoqueSoConsulta');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || dono, plan: req.headers['x-plan'] || 'essencial' }; next(); });
  app.use('/companies/:id/products', estoqueSoConsulta);
  app.use('/companies/:id/products', require('../src/routes/stockReceipts'));
  app.use('/companies/:id/products', require('../src/routes/productSuppliers'));
}, 30000);

afterAll(async () => {
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 200)); // avancarSemEsperar roda depois da resposta
  const limpar = [
    `DELETE FROM stock_receipts WHERE company_id = ANY($1)`,
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM product_suppliers WHERE company_id = ANY($1)`,
    `DELETE FROM product_category_links WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`,
    `DELETE FROM category_migration_staging WHERE company_id = ANY($1)`,
    `DELETE FROM products WHERE company_id = ANY($1)`,
    `DELETE FROM product_categories WHERE company_id = ANY($1)`,
    `DELETE FROM suppliers WHERE company_id = ANY($1)`,
    `DELETE FROM company_members WHERE company_id = ANY($1)`,
  ];
  for (const sql of limpar) {
    try { await q(sql, [empresas]); } catch (e) { /* banco de CI é descartável */ }
  }
  for (const id of empresas) {
    try { await q(`DELETE FROM companies WHERE id = $1`, [id]); } catch (e) { /* idem */ }
  }
  try { await q(`DELETE FROM users WHERE id = ANY($1)`, [usuarios]); } catch (e) { /* idem */ }
  if (criouNcm) { try { await q(`ALTER TABLE products DROP COLUMN IF EXISTS ncm`); } catch (e) { /* idem */ } }
  await pool.end();
}, 30000);

describe('produto novo na entrada', () => {
  test('igual a cadastrar com estoque 0 e dar entrada pelo caminho de um produto', async () => {
    const forn = await fornecedor(sozinha, 'Distribuidora Novos');
    const existente = (await q(`INSERT INTO products (company_id, name, price, stock_qty, cost_price) VALUES ($1, 'Já existia', 10, 2, 4) RETURNING id`, [sozinha])).rows[0].id;
    const novo = { name: 'Suco de uva 1 L', price: 12.9, category: 'Bebidas', ncm: '2009.69.00', barcode: '7891234567895', unit: 'un' };

    const r = await receber(sozinha, {
      idempotency_key: uuid(), supplier_id: forn, invoice_number: '55', origin: 'nota',
      items: [
        { product_id: existente, quantity: 2, unit_cost: 6 },
        { new_product: novo, quantity: 12, unit_cost: 6.4567, supplier_code: 'UVA1' },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.totals).toMatchObject({ lines: 2, products: 2, created_products: 1 });
    expect(r.body.lines[0].created).toBeUndefined();
    expect(r.body.lines[1]).toMatchObject({ created: true, name: 'Suco de uva 1 L', before: { stock_qty: 0, avg_cost: null }, after: { stock_qty: 12, avg_cost: 6.4567 } });

    // Régua: o mesmo produto, cadastrado com estoque 0 e custo 0, e a entrada de um produto.
    const { rows: [{ id: regua }] } = await q(
      `INSERT INTO products (company_id, name, price, category, ncm, barcode, unit, stock_qty, cost_price, is_group_shared)
       VALUES ($1, 'Suco de uva 1 L', 12.9, 'Bebidas', '20096900', NULL, 'un', 0, 0, false) RETURNING id`, [sozinha]);
    const rr = await request(app).post(`/companies/${sozinha}/products/${regua}/stock-entries`).set('x-user', dono)
      .send({ supplier_id: forn, quantity: 12, unit_cost: 6.4567, invoice_number: '55' });
    expect(rr.status).toBe(201);

    const criado = r.body.lines[1].product_id;
    const a = await retrato(regua);
    const b = await retrato(criado);
    expect({ ...b.produto, barcode: null }).toEqual(a.produto);
    expect(b.produto.barcode).toBe('7891234567895');
    expect(b.fornecedores.map(({ supplier_code, ...f }) => f)).toEqual(a.fornecedores.map(({ supplier_code, ...f }) => f));
    expect(b.fornecedores[0].supplier_code).toBe('UVA1');
    expect(b.movimentos).toEqual(a.movimentos);
    expect(b.produto).toMatchObject({ stock_qty: 12, weighted_avg_cost: 6.4567, cost_price: 6.46, price: 12.9, ncm: '20096900', supplier_id: forn, is_group_shared: false });
  });

  test('sem preço de venda, código de barras da loja ou repetido: 400 e nada grava', async () => {
    const usado = (await q(`INSERT INTO products (company_id, name, price, barcode) VALUES ($1, 'Dono do código', 5, '111') RETURNING id`, [sozinha])).rows[0].id;
    expect(usado).toBeTruthy();
    const r = await receber(sozinha, { idempotency_key: uuid(), items: [
      { new_product: { name: 'Sem preço' }, quantity: 1 },
      { new_product: { name: 'Preço zero', price: 0 }, quantity: 1 },
      { new_product: { name: 'Código usado', price: 5, barcode: '111' }, quantity: 1 },
      { new_product: { name: 'Código A', price: 5, barcode: '222' }, quantity: 1 },
      { new_product: { name: 'Código A de novo', price: 5, barcode: '222' }, quantity: 1 },
      { new_product: { name: 'Com grade', price: 5 }, variants: [{ variant_id: uuid(), quantity: 1 }] },
    ] });
    expect(r.status).toBe(400);
    expect(r.body.lines.map((l) => l.index)).toEqual([0, 1, 4, 5]);
    // o código já usado só aparece depois, no banco (as outras linhas já derrubaram a leitura do corpo)
    const r2 = await receber(sozinha, { idempotency_key: uuid(), items: [{ new_product: { name: 'Código usado', price: 5, barcode: '111' }, quantity: 1 }] });
    expect(r2.status).toBe(400);
    expect(r2.body.lines[0].error).toMatch(/Dono do código/);
    for (const nome of ['Sem preço', 'Preço zero', 'Código usado', 'Código A']) expect(await produtoPorNome(sozinha, nome)).toEqual([]);
  });

  test('limite do plano: tudo ou nada; plano maior passa', async () => {
    await q(`INSERT INTO products (company_id, name, price) SELECT $1, 'Cheia ' || g, 1 FROM generate_series(1, 1999) g`, [cheia]);
    const corpo = () => ({ idempotency_key: uuid(), items: [
      { new_product: { name: 'Novo 1', price: 3 }, quantity: 1 },
      { new_product: { name: 'Novo 2', price: 3 }, quantity: 1 },
    ] });
    const r = await receber(cheia, corpo());
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'LIMITE_DO_PLANO', limit: 2000, current: 1999, attempted: 2 });
    expect(await produtoPorNome(cheia, 'Novo 1')).toEqual([]);
    const ok = await receber(cheia, corpo(), { plan: 'negocio' });
    expect(ok.status).toBe(201);
    expect(ok.body.totals.created_products).toBe(2);
  }, 30000);

  test('compartilhado no grupo pela regra do "+ Produto"', async () => {
    const r = await receber(filial, { idempotency_key: uuid(), items: [{ new_product: { name: 'Novo da filial', price: 9 }, quantity: 3, unit_cost: 4 }] });
    expect(r.status).toBe(201);
    const [p] = await produtoPorNome(filial, 'Novo da filial');
    expect(p.is_group_shared).toBe(true);
    expect(num(p.stock_qty)).toBe(3);
    const { rows: [m] } = await q(`SELECT company_id FROM stock_movements WHERE product_id = $1`, [p.id]);
    expect(m.company_id).toBe(filial);
  });

  test('a mesma chave de novo não cadastra outra vez', async () => {
    const body = { idempotency_key: uuid(), items: [{ new_product: { name: 'Uma vez só', price: 2 }, quantity: 1 }] };
    expect((await receber(sozinha, body)).status).toBe(201);
    const r2 = await receber(sozinha, body);
    expect(r2.status).toBe(200);
    expect(r2.body.repeated).toBe(true);
    expect(await produtoPorNome(sozinha, 'Uma vez só')).toHaveLength(1);
  });

  test('categoria da árvore é ligada; a que não existe fica pendente sem derrubar a entrada', async () => {
    const { rows: [cat] } = await q(`INSERT INTO product_categories (company_id, name, type) VALUES ($1, 'Vinhos', 'product') RETURNING id`, [matriz]);
    const r = await receber(matriz, { idempotency_key: uuid(), items: [
      { new_product: { name: 'Tinto seco', price: 59, category: 'vinhos' }, quantity: 6, unit_cost: 30 },
      { new_product: { name: 'Taça', price: 15, category: 'Utilidades' }, quantity: 4 },
    ] });
    expect(r.status).toBe(201);
    expect(r.body.categorias).toEqual({ pendentes: ['Utilidades'], ambiguos: [] });
    const [tinto] = await produtoPorNome(matriz, 'Tinto seco');
    const { rows: links } = await q(`SELECT category_id, is_primary FROM product_category_links WHERE product_id = $1`, [tinto.id]);
    expect(links).toEqual([{ category_id: cat.id, is_primary: true }]);
    const [taca] = await produtoPorNome(matriz, 'Taça');
    expect(num(taca.stock_qty)).toBe(4);
  });

  test('quem não vê custo cadastra sem custo', async () => {
    const r = await receber(sozinha, { idempotency_key: uuid(), items: [{ new_product: { name: 'Sem custo visível', price: 8 }, quantity: 5, unit_cost: 99 }] }, { user: semCusto });
    expect(r.status).toBe(201);
    const [p] = await produtoPorNome(sozinha, 'Sem custo visível');
    expect({ stock: num(p.stock_qty), cost: num(p.cost_price), avg: num(p.weighted_avg_cost), price: num(p.price) }).toEqual({ stock: 5, cost: 0, avg: null, price: 8 });
  });

  test('base sem products.ncm: cadastra sem o NCM (só quando o teste criou a coluna)', async () => {
    if (!criouNcm) return;
    await q(`ALTER TABLE products DROP COLUMN ncm`);
    try {
      const r = await receber(sozinha, { idempotency_key: uuid(), items: [{ new_product: { name: 'Sem coluna de NCM', price: 7, ncm: '20096900' }, quantity: 2, unit_cost: 3 }] });
      expect(r.status).toBe(201);
      const [p] = await produtoPorNome(sozinha, 'Sem coluna de NCM');
      expect({ stock: num(p.stock_qty), avg: num(p.weighted_avg_cost) }).toEqual({ stock: 2, avg: 3 });
    } finally {
      await q(`ALTER TABLE products ADD COLUMN IF NOT EXISTS ncm TEXT`);
    }
  }, 30000);
});
