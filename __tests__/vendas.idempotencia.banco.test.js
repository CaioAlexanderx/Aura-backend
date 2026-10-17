// ============================================================
// AURA. — Venda idempotente no Caixa (migration 390) — Postgres real
//
// O teste de rota (tests/routes/pdvVendaIdempotente.test.js) usa um banco de
// mentira. Este prova as duas pecas que so o Postgres prova:
//   1. o indice UNICO parcial: a mesma (empresa, chave) nao entra duas
//      vezes; venda sem chave (NULL) entra quantas vezes for
//   2. a corrida de verdade: duas requisicoes SIMULTANEAS com a mesma chave,
//      cada uma no seu client e na sua transacao (advisory lock + indice),
//      gravam UMA venda e baixam o estoque UMA vez
//
// Diferente dos outros *.banco: a corrida precisa de COMMIT de verdade em
// duas conexoes, entao nao da para viver dentro de uma transacao revertida.
// As fixtures usam uuid proprio e sao apagadas no afterAll.
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
let vendaIdempotente;

const userId = uuid();
const companyId = uuid();
const productId = uuid();

const ITENS = [{ product_id: productId, quantity: 2, unit_price: 10, product_name_snapshot: 'Fixture Idem' }];
const BODY = { items: ITENS, payment_method: 'dinheiro' };
const url = `/companies/${companyId}/pdv/sale`;
const post = (key, body = BODY) => {
  const r = request(app).post(url);
  if (key) r.set('Idempotency-Key', key);
  return r.send(body);
};

async function contarVendas() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM sales WHERE company_id = $1`, [companyId]);
  return rows[0].n;
}
async function estoque() {
  const { rows } = await pool.query(`SELECT stock_qty FROM products WHERE id = $1`, [productId]);
  return Number(rows[0].stock_qty);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  vendaIdempotente = require('../src/services/vendaIdempotente');
  vendaIdempotente._resetCache();

  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Idempotencia')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await pool.query(
    `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Idempotencia')`,
    [companyId, userId]
  );
  await pool.query(
    `INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Fixture Idem', 10, 20)`,
    [productId, companyId]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));
});

afterAll(async () => {
  if (!pool) return;
  // A venda dispara tarefas sem esperar (trial, resposta guardada): da um
  // respiro antes de fechar o pool.
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

describe('migration 390 — indice unico parcial', () => {
  test('mesma (empresa, chave) recusa a segunda linha; sem chave entra sempre', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const k = uuid();
      await c.query(`INSERT INTO sales (company_id, total_amount, idempotency_key) VALUES ($1, 1, $2)`, [companyId, k]);
      await c.query('SAVEPOINT dup');
      let erro = null;
      try {
        await c.query(`INSERT INTO sales (company_id, total_amount, idempotency_key) VALUES ($1, 1, $2)`, [companyId, k]);
      } catch (e) { erro = e; }
      expect(erro).not.toBeNull();
      expect(erro.code).toBe('23505');
      expect(vendaIdempotente.ehColisaoDaChave(erro)).toBe(true);
      await c.query('ROLLBACK TO SAVEPOINT dup');
      await c.query(`INSERT INTO sales (company_id, total_amount) VALUES ($1, 1), ($1, 1)`, [companyId]);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

describe('POST /pdv/sale com Idempotency-Key — Postgres real', () => {
  const KEY = uuid();

  test('duas requisicoes simultaneas com a mesma chave: 1 venda, estoque baixa uma vez', async () => {
    const antes = await contarVendas();
    const [a, b] = await Promise.all([post(KEY), post(KEY)]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.sale.id).toBe(b.body.sale.id);
    expect(await contarVendas()).toBe(antes + 1);
    expect(await estoque()).toBe(18);
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM transactions WHERE idempotency_key = $1`, ['pdv-sale-' + a.body.sale.id]
    );
    expect(rows[0].n).toBe(1);
  });

  test('a mesma chave depois: devolve a mesma venda, sem gravar', async () => {
    const antes = await contarVendas();
    const c = await post(KEY);
    expect(c.status).toBe(201);
    expect(c.body.idempotent_replay).toBe(true);
    expect(await contarVendas()).toBe(antes);
    expect(await estoque()).toBe(18);
  });

  test('chave diferente e sem chave: vendas novas', async () => {
    const antes = await contarVendas();
    const d = await post(uuid());
    const e = await post(null);
    expect(d.status).toBe(201);
    expect(e.status).toBe(201);
    expect(d.body.idempotent_replay).toBeUndefined();
    expect(await contarVendas()).toBe(antes + 2);
    expect(await estoque()).toBe(14);
  });
});
