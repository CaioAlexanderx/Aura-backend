// ============================================================
// Editar venda (09/11/2026) — duas edições ao mesmo tempo, Postgres real
//
// Revisão do Aura-backend#972: o FOR UPDATE dentro da consulta grande não
// protegia (em READ COMMITTED as subconsultas viam o retrato de antes) e duas
// edições juntas criavam dois débitos e dois carnês. Agora a venda é travada
// num comando próprio, ANTES da leitura.
//
// Diferente do vendas.editarVenda.banco.test.js: a corrida precisa de COMMIT
// de verdade em duas conexões, então as fixtures têm uuid próprio e são
// apagadas no afterAll (mesmo desenho do vendas.idempotencia.banco.test.js).
// Venda 1x sem data de vencimento: não cria parcela, e o createCreditSale não
// precisa das colunas de parcelamento que o CI não tem.
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

const userId = uuid();
const companyId = uuid();
const customerId = uuid();
const saleId = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  require('../src/services/editarVenda')._resetCache();

  await pool.query(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Corrida')`, [userId, `fixture-${userId}@example.test`]);
  await pool.query(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Corrida')`, [companyId, userId]);
  await pool.query(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Cliente Corrida')`, [customerId, companyId]);
  await pool.query(
    `INSERT INTO sales (id, company_id, customer_id, seller_id, total_amount, discount_amount, payment_method, status, created_at)
     VALUES ($1, $2, $3, $4, 120, 0, 'pix', 'completed', NOW() - INTERVAL '1 day')`,
    [saleId, companyId, customerId, userId]
  );
  await pool.query(
    `INSERT INTO sale_payments (sale_id, company_id, method, amount) VALUES ($1, $2, 'pix', 120)`,
    [saleId, companyId]
  );
  await pool.query(
    `INSERT INTO transactions (company_id, type, status, amount, description, category, due_date, paid_at, created_by, idempotency_key)
     VALUES ($1, 'income', 'confirmed', 120, 'Venda PDV - Item (pix)', 'Vendas', CURRENT_DATE, NOW(), $2, $3)`,
    [companyId, userId, 'pdv-sale-' + saleId]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; req.companyRole = 'owner'; next(); });
  app.use('/companies/:id/sales', require('../src/routes/sales'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    [`DELETE FROM sale_edits WHERE company_id = $1`, [companyId]],
    [`DELETE FROM credit_installments WHERE company_id = $1`, [companyId]],
    [`DELETE FROM customer_credit_transactions WHERE company_id = $1`, [companyId]],
    [`DELETE FROM transactions WHERE company_id = $1`, [companyId]],
    [`DELETE FROM credit_accounts WHERE company_id = $1`, [companyId]],
    [`DELETE FROM customer_credit_profiles WHERE company_id = $1`, [companyId]],
    [`DELETE FROM credit_plan_configs WHERE company_id = $1`, [companyId]],
    [`DELETE FROM sale_payments WHERE company_id = $1`, [companyId]],
    [`DELETE FROM sales WHERE company_id = $1`, [companyId]],
    [`DELETE FROM customers WHERE company_id = $1`, [companyId]],
    [`DELETE FROM companies WHERE id = $1`, [companyId]],
    [`DELETE FROM users WHERE id = $1`, [userId]],
  ];
  for (const [sql, params] of limpar) {
    try { await pool.query(sql, params); } catch (e) { /* banco de CI é descartável */ }
  }
  await pool.end();
});

test('duas edições juntas para o crediário: um débito, um carnê, uma resposta de sucesso', async () => {
  const corpo = { payments: [{ method: 'crediario', amount: 120 }] };
  const url = `/companies/${companyId}/sales/${saleId}`;
  const [a, b] = await Promise.all([
    request(app).patch(url).send(corpo),
    request(app).patch(url).send(corpo),
  ]);
  const status = [a.status, b.status].sort();
  // A segunda espera a trava e já encontra a venda no crediário: nada a mudar.
  expect(status).toEqual([200, 400]);
  expect([a.body.code, b.body.code]).toContain('NO_CHANGES');

  const deb = await pool.query(`SELECT COUNT(*)::int AS n FROM customer_credit_transactions WHERE sale_id = $1 AND type = 'debit'`, [saleId]);
  expect(deb.rows[0].n).toBe(1);
  const carnes = await pool.query(`SELECT COUNT(*)::int AS n FROM credit_accounts WHERE company_id = $1 AND customer_id = $2 AND status = 'open'`, [companyId, customerId]);
  expect(carnes.rows[0].n).toBe(1);
  const ar = await pool.query(`SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key LIKE $1`, ['pdv-credit-receivable-' + saleId + '%']);
  expect(ar.rows[0].n).toBe(1);
  const reg = await pool.query(`SELECT COUNT(*)::int AS n FROM sale_edits WHERE sale_id = $1`, [saleId]);
  expect(reg.rows[0].n).toBe(1);
});
