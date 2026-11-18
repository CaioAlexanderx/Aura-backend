// ============================================================
// AURA. — GET /me/products/aggregated com mais de 500 produtos — Postgres real
// (18/11/2026, INC-2026-11-18-01)
//
// Lojista com matriz e filial e ~1.500 produtos: o consolidado "Somado"
// cortava em LIMIT 500 fixo, então o resto do estoque (e o filtro "Loja"
// do app) sumia. O que este arquivo trava:
//   1. sem `limit`, vêm TODOS os grupos (aqui 523), com `total` certo;
//   2. as duas lojas aparecem nos itens (o filtro "Loja" enxerga as duas);
//   3. `limit`/`offset` paginam em ordem estável (nome, depois group_key):
//      as páginas juntas = a lista inteira, sem repetir nem pular;
//   4. página além do fim: lista vazia, `total` certo, has_more false;
//   5. produto vinculado (mesmo master_sku nas duas lojas) é UM grupo.
//
// No main (LIMIT 500) os testes 1, 2 e 3 falham.
// Fixtures com uuid próprio, apagadas no afterAll.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = req.user || { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let app;

const userId = uuid();
const matriz = uuid();
const filial = uuid();
const empresas = [matriz, filial];
const sufixo = userId.slice(0, 8);

const SO_MATRIZ = 400;
const SO_FILIAL = 120;
const VINCULADOS = 3; // cada um com um produto em cada loja
const GRUPOS = SO_MATRIZ + SO_FILIAL + VINCULADOS; // 523

const lista = (qs = '') => request(app).get(`/me/products/aggregated${qs}`);

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 1 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Agregado')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await pool.query(`INSERT INTO companies (id, owner_id, legal_name, trade_name, is_primary) VALUES ($1, $2, 'Matriz Fixture', 'Matriz', true)`, [matriz, userId]);
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id) VALUES ($1, $2, 'Filial Fixture', 'Filial', $3)`,
    [filial, userId, matriz]
  );

  // Nomes repetidos de propósito (de 10 em 10): a ordem só é estável com o
  // desempate por group_key.
  await pool.query(
    `INSERT INTO products (company_id, name, price, cost_price, stock_qty)
     SELECT $1, 'Produto ' || lpad((g % 40)::text, 3, '0'), 10, 5, 1 FROM generate_series(1, $2) g`,
    [matriz, SO_MATRIZ]
  );
  await pool.query(
    `INSERT INTO products (company_id, name, price, cost_price, stock_qty)
     SELECT $1, 'Produto ' || lpad((g % 40)::text, 3, '0'), 10, 5, 2 FROM generate_series(1, $2) g`,
    [filial, SO_FILIAL]
  );
  for (let i = 1; i <= VINCULADOS; i++) {
    for (const cid of empresas) {
      await pool.query(
        `INSERT INTO products (company_id, name, price, cost_price, stock_qty, master_sku) VALUES ($1, $2, 10, 5, 3, $3)`,
        [cid, `Vinculado ${i}`, `MS-${sufixo}-${i}`]
      );
    }
  }
  // Inativo não entra (filho de variante desativado, por exemplo).
  await pool.query(`INSERT INTO products (company_id, name, price, stock_qty, is_active) VALUES ($1, 'Inativo', 1, 0, false)`, [matriz]);

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/me', require('../src/routes/productLinks').userRouter);
});

afterAll(async () => {
  if (!pool) return;
  try { await pool.query(`DELETE FROM products WHERE company_id = ANY($1)`, [empresas]); } catch (e) { /* banco de CI e descartavel */ }
  for (const id of [filial, matriz]) {
    try { await pool.query(`DELETE FROM companies WHERE id = $1`, [id]); } catch (e) { /* idem */ }
  }
  try { await pool.query(`DELETE FROM users WHERE id = $1`, [userId]); } catch (e) { /* idem */ }
  await pool.end();
});

test('sem limit: todos os grupos, além dos 500 de antes', async () => {
  const res = await lista();
  expect(res.status).toBe(200);
  expect(res.body.products).toHaveLength(GRUPOS);
  expect(res.body.total).toBe(GRUPOS);
  expect(res.body.has_more).toBe(false);
  expect(res.body.searched_companies).toBe(2);
});

test('as duas lojas aparecem nos itens (o filtro "Loja" vê as duas)', async () => {
  const res = await lista();
  const porLoja = {};
  res.body.products.forEach((g) => g.items.forEach((it) => { porLoja[it.company_id] = (porLoja[it.company_id] || 0) + 1; }));
  expect(porLoja[matriz]).toBe(SO_MATRIZ + VINCULADOS);
  expect(porLoja[filial]).toBe(SO_FILIAL + VINCULADOS);
});

test('vinculado é um grupo só, com as duas lojas', async () => {
  const res = await lista();
  const v = res.body.products.filter((g) => g.is_linked);
  expect(v).toHaveLength(VINCULADOS);
  v.forEach((g) => expect(g.items.map((i) => i.company_id).sort()).toEqual([...empresas].sort()));
});

test('páginas de 200: juntas são a lista inteira, na mesma ordem, sem repetir', async () => {
  const inteira = (await lista()).body.products.map((g) => g.group_key);
  const paginas = [];
  for (let offset = 0; offset < GRUPOS; offset += 200) {
    const r = await lista(`?limit=200&offset=${offset}`);
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(GRUPOS);
    expect(r.body.limit).toBe(200);
    expect(r.body.has_more).toBe(offset + 200 < GRUPOS);
    paginas.push(...r.body.products.map((g) => g.group_key));
  }
  expect(paginas).toEqual(inteira);
  expect(new Set(paginas).size).toBe(GRUPOS);
  // Ordem por nome (o desempate é o group_key).
  const nomes = (await lista()).body.products.map((g) => g.name);
  expect(nomes).toEqual([...nomes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
});

test('página além do fim: vazia, com o total certo', async () => {
  const r = await lista(`?limit=50&offset=${GRUPOS + 10}`);
  expect(r.status).toBe(200);
  expect(r.body.products).toEqual([]);
  expect(r.body.total).toBe(GRUPOS);
  expect(r.body.has_more).toBe(false);
});

test('limit acima do teto cai no teto; limit inválido vira o padrão', async () => {
  const r = await lista('?limit=999999');
  expect(r.body.limit).toBe(20000);
  const r2 = await lista('?limit=abc&offset=-3');
  expect(r2.body.limit).toBe(20000);
  expect(r2.body.offset).toBe(0);
  expect(r2.body.products).toHaveLength(GRUPOS);
});
