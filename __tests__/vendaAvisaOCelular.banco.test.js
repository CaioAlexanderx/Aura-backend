// ============================================================
// AURA. — POST /pdv/sale avisa o celular (04/11/2026)
//
// Precisa do Postgres do CI: a venda de verdade passa por estoque,
// caixa e idempotencia, e o que este arquivo trava e o PONTO de disparo:
//   - depois do COMMIT, 'loja_venda_realizada' sai com o id da venda, o
//     total, o numero e quem passou a venda em `exceto`;
//   - a repeticao por Idempotency-Key devolve a venda gravada e NAO dispara
//     de novo (a idempotencia do aviso e a da venda).
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
let lojaEvents;

const userId = uuid();
const companyId = uuid();
const productId = uuid();
const url = `/companies/${companyId}/pdv/sale`;

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 4 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  require('../src/services/vendaIdempotente')._resetCache();
  lojaEvents = require('../src/services/lojaEvents');

  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Aviso')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await pool.query(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Aviso')`, [companyId, userId]);
  await pool.query(
    `INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Fixture Aviso', 10, 20)`,
    [productId, companyId]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));
});

afterAll(async () => {
  if (!pool) return;
  await new Promise((r) => setTimeout(r, 200));
  const limpar = [
    [`DELETE FROM transactions WHERE company_id = $1`, [companyId]],
    [`DELETE FROM sale_payments WHERE company_id = $1`, [companyId]],
    [`DELETE FROM stock_movements WHERE company_id = $1`, [companyId]],
    [`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE company_id = $1)`, [companyId]],
    [`DELETE FROM sales WHERE company_id = $1`, [companyId]],
    [`DELETE FROM products WHERE company_id = $1`, [companyId]],
    [`DELETE FROM companies WHERE id = $1`, [companyId]],
    [`DELETE FROM users WHERE id = $1`, [userId]],
  ];
  for (const [sql, params] of limpar) {
    try { await pool.query(sql, params); } catch (e) { /* banco de CI e descartavel */ }
  }
  await pool.end();
});

beforeEach(() => jest.spyOn(lojaEvents, 'emit').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

const BODY = {
  items: [{ product_id: productId, quantity: 2, unit_price: 10, product_name_snapshot: 'Fixture Aviso' }],
  payment_method: 'pix',
  seller_name: 'Bianca',
};

test('a venda dispara o aviso depois do COMMIT, sem avisar quem vendeu', async () => {
  const res = await request(app).post(url).send(BODY);
  expect(res.status).toBe(201);
  const sale = res.body.sale;

  const chamadas = lojaEvents.emit.mock.calls.filter(([t]) => t === 'loja_venda_realizada');
  expect(chamadas).toHaveLength(1);
  const [, payload, opts] = chamadas[0];
  expect(payload).toMatchObject({ id: sale.id, company_id: companyId, payment_method: 'pix' });
  expect(Number(payload.total)).toBe(20);
  expect(payload.sale_number).toBe(sale.sale_number);
  expect(opts).toEqual({ exceto: userId });
  // venda comum: nenhum "orcamento aprovado"
  expect(lojaEvents.emit.mock.calls.some(([t]) => t === 'loja_orcamento_aprovado')).toBe(false);
});

test('repeticao por Idempotency-Key nao avisa duas vezes', async () => {
  const key = uuid();
  const a = await request(app).post(url).set('Idempotency-Key', key).send(BODY);
  const b = await request(app).post(url).set('Idempotency-Key', key).send(BODY);
  expect(a.status).toBe(201);
  expect([200, 201]).toContain(b.status);
  expect(b.body.sale.id).toBe(a.body.sale.id);
  expect(lojaEvents.emit.mock.calls.filter(([t]) => t === 'loja_venda_realizada')).toHaveLength(1);
});
