// ============================================================
// AURA. Studio, orcamento vira pedido (convert/aprovar) — Postgres real
//
// Duas coisas que so o Postgres prova:
//   1. o INSERT em digital_orders usa colunas que EXISTEM (antes usava
//      total_amount/created_by, que nao existem, e order_number ficava sem
//      valor: o convert/aprovar davam 500 sempre; em producao 4 orcamentos,
//      0 com pedido)
//   2. a corrida de verdade: varias requisicoes SIMULTANEAS no mesmo
//      orcamento, cada uma no seu client e na sua transacao, criam UM pedido
//      so (o orcamento e lido com FOR UPDATE; quem chega depois espera e
//      devolve o pedido ja criado)
//
// Corrida precisa de COMMIT de verdade em varias conexoes, entao as
// fixtures usam uuid proprio e sao apagadas no afterAll.
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
const outraEmpresaId = uuid();

jest.setTimeout(30000);

const url = (qid, acao) => `/companies/${companyId}/studio/quotes/${qid}/${acao}`;

async function novoOrcamento({ status = 'draft', deposito = null, comItens = true, empresa = companyId } = {}) {
  const qid = uuid();
  await pool.query(
    `INSERT INTO studio_quotes (id, company_id, customer_name, customer_phone, status,
                                subtotal, discount, total, deposit_amount)
     VALUES ($1, $2, 'Cliente Fixture', '11999990000', $3, 100, 0, 100, $4)`,
    [qid, empresa, status, deposito]
  );
  if (comItens) {
    await pool.query(
      `INSERT INTO studio_quote_items (quote_id, description, quantity, unit_price, customization, sort_order)
       VALUES ($1, 'Caneca fixture', 2, 30, '{"texto":"oi"}', 0),
              ($1, 'Camiseta fixture', 1, 40, NULL, 1)`,
      [qid]
    );
  }
  return qid;
}

async function contarPedidos() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM digital_orders WHERE company_id = $1`, [companyId]);
  return rows[0].n;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 10 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  // Banco recriado do zero (CI): a 070 cria digital_order_sequences sem
  // updated_at e a 273 (CREATE TABLE IF NOT EXISTS) nao a corrige, mas a
  // next_digital_order_number() da 273 grava updated_at. Em producao a coluna
  // existe (conferido em 18/10/2026). Aqui so igualamos o schema de teste.
  await pool.query(
    `ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`
  );
  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Orcamento')`,
    [userId, `fixture-${userId}@example.test`]
  );
  for (const id of [companyId, outraEmpresaId]) {
    await pool.query(
      `INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Orcamento')`,
      [id, userId]
    );
  }

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/companies/:id/studio', require('../src/routes/studioQuotes'));
});

afterAll(async () => {
  if (!pool) return;
  const limpar = [
    [`DELETE FROM studio_payments WHERE company_id = ANY($1)`, [[companyId, outraEmpresaId]]],
    [`DELETE FROM studio_quotes WHERE company_id = ANY($1)`, [[companyId, outraEmpresaId]]],
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [[companyId, outraEmpresaId]]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [[companyId, outraEmpresaId]]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [[companyId, outraEmpresaId]]],
    [`DELETE FROM users WHERE id = $1`, [userId]],
  ];
  for (const [sql, params] of limpar) {
    try { await pool.query(sql, params); } catch (e) { /* banco de CI e descartavel */ }
  }
  await pool.end();
});

describe('aprovar: o pedido grava de verdade no schema real', () => {
  test('cria pedido com numero, total, itens, etapa da esteira e sinal; orcamento vira converted', async () => {
    const qid = await novoOrcamento({ deposito: 50 });
    const r = await request(app).post(url(qid, 'aprovar'));
    expect(r.status).toBe(200);
    expect(r.body.quote.status).toBe('converted');
    expect(r.body.quote.order_id).toBe(r.body.order_id);

    const { rows: [o] } = await pool.query(`SELECT * FROM digital_orders WHERE id = $1`, [r.body.order_id]);
    expect(o.company_id).toBe(companyId);
    expect(o.vertical).toBe('studio');
    expect(o.studio_production_status).toBe('pending_art');
    expect(o.order_number).toBeTruthy();
    expect(Number(o.total)).toBe(100);
    expect(Number(o.subtotal)).toBe(100);
    expect(Number(o.deposit_required)).toBe(50);
    expect(o.customer_name).toBe('Cliente Fixture');

    const { rows: itens } = await pool.query(
      `SELECT product_name, quantity, unit_price, customization FROM digital_order_items WHERE order_id = $1 ORDER BY product_name`,
      [o.id]
    );
    expect(itens.map((i) => i.product_name)).toEqual(['Camiseta fixture', 'Caneca fixture'].sort());
    const { rows: pag } = await pool.query(`SELECT kind, amount, status FROM studio_payments WHERE order_id = $1`, [o.id]);
    expect(pag).toHaveLength(1);
    expect(pag[0].kind).toBe('deposit');
    expect(Number(pag[0].amount)).toBe(50);
  });

  test('orcamento sem nome nem telefone ainda vira pedido (colunas NOT NULL)', async () => {
    const qid = uuid();
    await pool.query(`INSERT INTO studio_quotes (id, company_id, status, subtotal, total) VALUES ($1, $2, 'draft', 10, 10)`, [qid, companyId]);
    await pool.query(`INSERT INTO studio_quote_items (quote_id, description, quantity, unit_price) VALUES ($1, 'Item', 1, 10)`, [qid]);
    const r = await request(app).post(url(qid, 'aprovar'));
    expect(r.status).toBe(200);
    const { rows: [o] } = await pool.query(`SELECT customer_name, customer_phone FROM digital_orders WHERE id = $1`, [r.body.order_id]);
    expect(o.customer_name).toBe('Cliente');
    expect(o.customer_phone).toBe('');
  });

  test('sem itens: 400 e nenhum pedido; outra empresa: 404', async () => {
    const semItens = await novoOrcamento({ comItens: false });
    const antes = await contarPedidos();
    expect((await request(app).post(url(semItens, 'aprovar'))).status).toBe(400);
    expect(await contarPedidos()).toBe(antes);

    const deOutra = await novoOrcamento({ empresa: outraEmpresaId });
    expect((await request(app).post(url(deOutra, 'aprovar'))).status).toBe(404);
    const { rows } = await pool.query(`SELECT order_id FROM studio_quotes WHERE id = $1`, [deOutra]);
    expect(rows[0].order_id).toBeNull();
  });
});

describe('corrida: clique duplo e duas abas criam UM pedido so', () => {
  test('aprovar x8 ao mesmo tempo: 1 pedido, mesma resposta para todos', async () => {
    const qid = await novoOrcamento({ deposito: 30 });
    const antes = await contarPedidos();
    const rs = await Promise.all(Array.from({ length: 8 }, () => request(app).post(url(qid, 'aprovar'))));

    expect(rs.map((r) => r.status)).toEqual(Array(8).fill(200));
    const ids = new Set(rs.map((r) => r.body.order_id));
    expect(ids.size).toBe(1);
    expect(await contarPedidos()).toBe(antes + 1);

    const [orderId] = [...ids];
    const { rows: itens } = await pool.query(`SELECT COUNT(*)::int AS n FROM digital_order_items WHERE order_id = $1`, [orderId]);
    expect(itens[0].n).toBe(2);
    const { rows: pag } = await pool.query(`SELECT COUNT(*)::int AS n FROM studio_payments WHERE order_id = $1`, [orderId]);
    expect(pag[0].n).toBe(1);
    const { rows: [q] } = await pool.query(`SELECT order_id, status FROM studio_quotes WHERE id = $1`, [qid]);
    expect(q.order_id).toBe(orderId);
    expect(q.status).toBe('converted');
  });

  test('convert x8 ao mesmo tempo (orcamento aceito): 1 pedido', async () => {
    const qid = await novoOrcamento({ status: 'accepted' });
    const antes = await contarPedidos();
    const rs = await Promise.all(Array.from({ length: 8 }, () => request(app).post(url(qid, 'convert'))));

    expect(rs.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect(new Set(rs.map((r) => r.body.order_id)).size).toBe(1);
    expect(await contarPedidos()).toBe(antes + 1);
  });

  test('convert e aprovar ao mesmo tempo no mesmo orcamento: 1 pedido', async () => {
    const qid = await novoOrcamento({ status: 'accepted' });
    const antes = await contarPedidos();
    const rs = await Promise.all([
      request(app).post(url(qid, 'convert')),
      request(app).post(url(qid, 'aprovar')),
      request(app).post(url(qid, 'convert')),
      request(app).post(url(qid, 'aprovar')),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(rs.map((r) => r.body.order_id)).size).toBe(1);
    expect(await contarPedidos()).toBe(antes + 1);
  });

  test('convert exige accepted: rascunho recusa e nao cria pedido', async () => {
    const qid = await novoOrcamento({ status: 'draft' });
    const antes = await contarPedidos();
    const r = await request(app).post(url(qid, 'convert'));
    expect(r.status).toBe(400);
    expect(await contarPedidos()).toBe(antes);
  });
});
