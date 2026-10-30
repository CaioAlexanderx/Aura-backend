// ============================================================
// AURA. — Gerar EAN-13 (p-74): duas gravações ao mesmo tempo
// Postgres real, com DUAS conexões de verdade.
//
// Sem a trava (pg_advisory_xact_lock por grupo), dois lotes simultâneos
// leem o mesmo "maior número" e gravam os mesmos códigos — e a variante
// não tem UNIQUE nenhuma para segurar. Aqui as duas chamadas rodam em
// paralelo, cada uma na sua conexão, e nenhum número pode repetir.
//
// Diferente dos outros *.banco.test.js, este arquivo precisa de COMMIT
// de verdade (a trava só faz efeito entre transações diferentes). As
// fixtures usam ids novos e são apagadas no afterAll.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const { validateEAN13 } = require('../src/services/barcode');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let app;
const userId = uuid();
const matriz = uuid();
const filial = uuid();
const produtosMatriz = [];
const variantesFilial = [];

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture EAN concorrencia')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await pool.query(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Matriz Conc LTDA', 'Matriz')`, [matriz, userId]);
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id)
     VALUES ($1, $2, 'Filial Conc LTDA', 'Filial', $3)`,
    [filial, userId, matriz]
  );
  for (let i = 0; i < 15; i++) {
    const { rows } = await pool.query(
      `INSERT INTO products (company_id, name, price, stock_qty) VALUES ($1, $2, 10, 0) RETURNING id`,
      [matriz, `Produto matriz ${i}`]
    );
    produtosMatriz.push(rows[0].id);
  }
  const { rows: pf } = await pool.query(
    `INSERT INTO products (company_id, name, price, stock_qty) VALUES ($1, 'Produto filial', 10, 0) RETURNING id`,
    [filial]
  );
  for (let i = 0; i < 15; i++) {
    const { rows } = await pool.query(
      `INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, $2, 1) RETURNING id`,
      [pf[0].id, `T${i}`]
    );
    variantesFilial.push({ product_id: pf[0].id, variant_id: rows[0].id });
  }

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'client' }; req.companyRole = 'owner'; next(); });
  app.use('/companies/:id/products', require('../src/routes/productsBarcodeGenerate'));
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    [`DELETE FROM audit_log WHERE company_id = ANY($1::uuid[])`, [[matriz, filial]]],
    [`DELETE FROM products WHERE company_id = ANY($1::uuid[])`, [[matriz, filial]]],
    [`DELETE FROM companies WHERE id = $1`, [filial]],
    [`DELETE FROM companies WHERE id = $1`, [matriz]],
    [`DELETE FROM users WHERE id = $1`, [userId]],
  ];
  for (const [sql, params] of limpar) {
    try { await pool.query(sql, params); } catch (e) { /* banco do CI é descartável */ }
  }
  await pool.end();
});

const gerar = (cid, targets) =>
  request(app).post(`/companies/${cid}/products/barcodes/generate`).send({ dry_run: false, targets });

test('matriz e filial (mesmo grupo) gravando ao mesmo tempo não repetem número', async () => {
  const [a, b] = await Promise.all([
    gerar(matriz, produtosMatriz.map((id) => ({ product_id: id, variant_id: null }))),
    gerar(filial, variantesFilial),
  ]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(a.body.items).toHaveLength(15);
  expect(b.body.items).toHaveLength(15);

  const todos = [...a.body.items, ...b.body.items].map((i) => i.barcode);
  expect(new Set(todos).size).toBe(30);
  todos.forEach((c) => expect(validateEAN13(c)).toBe(true));

  // O que foi gravado é o que voltou, e o banco também não tem repetidos.
  const { rows } = await pool.query(
    `SELECT barcode FROM products WHERE company_id = $1 AND barcode IS NOT NULL
     UNION ALL
     SELECT pv.barcode FROM product_variants pv JOIN products p ON p.id = pv.product_id
      WHERE p.company_id = $2 AND pv.barcode IS NOT NULL`,
    [matriz, filial]
  );
  const gravados = rows.map((r) => r.barcode).sort();
  expect(gravados).toEqual([...todos].sort());
});

test('os mesmos alvos em duas chamadas simultâneas: cada um recebe UM código só', async () => {
  const { rows } = await pool.query(
    `INSERT INTO products (company_id, name, price, stock_qty)
     SELECT $1, 'Repetido ' || g, 10, 0 FROM generate_series(1, 5) g RETURNING id`,
    [matriz]
  );
  const alvos = rows.map((r) => ({ product_id: r.id, variant_id: null }));
  const [a, b] = await Promise.all([gerar(matriz, alvos), gerar(matriz, alvos)]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  const gerados = [...a.body.items, ...b.body.items];
  expect(gerados).toHaveLength(5);
  const pulados = [...a.body.skipped, ...b.body.skipped];
  expect(pulados).toHaveLength(5);
  pulados.forEach((s) => expect(s.reason).toBe('ja_tem_codigo'));
});
