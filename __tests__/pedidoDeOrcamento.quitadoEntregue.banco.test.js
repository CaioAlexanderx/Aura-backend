// ============================================================
// AURA. — Pedido de orcamento quitado e entregue (B1b) — Postgres real
// services/entregaDoPedidoDeOrcamento.js
//
// Cenario: orcamento de 2 canecas a R$ 50 (total 100), sinal 30, saldo 70, com
// estoque 10.
//   - sinal pago: payment_status segue 'pending' (falta o saldo);
//   - saldo pago: payment_status vira 'confirmed' (o valor que a loja online
//     grava ao confirmar o Pix); o Financeiro nao muda;
//   - entregar (PATCH production-status 'delivered'): delivered_at gravado e
//     estoque 10 -> 8, stock_deducted TRUE;
//   - entregar de novo: nada baixa de novo, delivered_at intacto;
//   - entregar com saldo aberto: baixa e grava a entrega, NAO marca pago.
// Loja de teste da frente (personalizados_teste) liga o fluxo novo; a loja sem
// a trava segue como antes (nada baixa).
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyStatusChange: jest.fn(async () => {}), notifyPaymentConfirmed: jest.fn(async () => {}),
}));
jest.mock('../src/middleware/auth', () => {
  const passa = (_req, _res, next) => next();
  return { requireAuth: passa, requirePlan: () => passa, requireRole: () => passa };
});

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const ID = { dono: uuid(), loja: uuid(), semTrava: uuid() };
const EMPRESAS = [ID.loja, ID.semTrava];

let pool;
let app;
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  const passos = [
    [`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM finance_categories WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM studio_payments WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM studio_quote_items WHERE quote_id IN (SELECT id FROM studio_quotes WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM studio_quotes WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_sequences WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = $1`, [ID.dono]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 10 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  await q(`ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await q(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurrence_type TEXT,
                                   ADD COLUMN IF NOT EXISTS recurrence_group_id UUID,
                                   ADD COLUMN IF NOT EXISTS recurrence_index INTEGER,
                                   ADD COLUMN IF NOT EXISTS payment_method VARCHAR,
                                   ADD COLUMN IF NOT EXISTS employee_id UUID,
                                   ADD COLUMN IF NOT EXISTS employee_name TEXT`);
  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Pedido Quitado')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  for (const id of EMPRESAS) {
    await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Pedido Quitado')`, [id, ID.dono]);
  }
  await q(`UPDATE companies SET studio_settings = COALESCE(studio_settings, '{}'::jsonb) || '{"personalizados_teste": true}'::jsonb
            WHERE id = $1`, [ID.loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: ID.dono, role: 'client', is_staff: true }; next(); });
  app.use('/companies/:id/studio', require('../src/routes/studioKdsApproval'));
  app.use('/companies/:id/studio', require('../src/routes/studioQuotes'));
  app.use('/companies/:id/studio', require('../src/routes/studioPayments'));
});

beforeEach(() => { delete process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO; });

afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

async function novoPedido({ empresa = ID.loja, estoque = 10 } = {}) {
  const { rows: [p] } = await q(
    `INSERT INTO products (company_id, name, price, stock_qty) VALUES ($1, 'Caneca fixture', 50, $2) RETURNING id`,
    [empresa, estoque]);
  const qid = uuid();
  await q(
    `INSERT INTO studio_quotes (id, company_id, customer_name, customer_phone, status, subtotal, discount, total, deposit_amount)
     VALUES ($1, $2, 'Cliente Fixture', '11999990000', 'draft', 100, 0, 100, 30)`,
    [qid, empresa]);
  await q(
    `INSERT INTO studio_quote_items (quote_id, product_id, description, quantity, unit_price, sort_order)
     VALUES ($1, $2, 'Caneca fixture', 2, 50, 0)`,
    [qid, p.id]);
  const r = await request(app).post(`/companies/${empresa}/studio/quotes/${qid}/aprovar`);
  expect(r.status).toBe(200);
  const oid = r.body.order_id;
  const { rows: m } = await q(`SELECT id, kind FROM studio_payments WHERE order_id = $1`, [oid]);
  return {
    oid, produto: p.id, empresa,
    sinal: m.find((x) => x.kind === 'deposit').id,
    saldo: m.find((x) => x.kind === 'balance').id,
  };
}

const pagar = (pid, empresa = ID.loja) =>
  request(app).post(`/companies/${empresa}/studio/payments/${pid}/mark-paid`).send({ method: 'pix' });

async function entregar(ped) {
  const { rows: [h] } = await q(`SELECT id FROM studio_orders WHERE digital_order_id = $1`, [ped.oid]);
  return request(app).patch(`/companies/${ped.empresa}/studio/orders/${h.id}/production-status`).send({ status: 'delivered' });
}

const pedido = async (oid) => (await q(
  `SELECT payment_status, delivered_at, stock_deducted, studio_production_status FROM digital_orders WHERE id = $1`, [oid])).rows[0];
const estoque = async (pid) => Number((await q(`SELECT stock_qty FROM products WHERE id = $1`, [pid])).rows[0].stock_qty);
const financeiro = async (oid) => (await q(
  `SELECT idempotency_key, status::text AS status, amount::numeric AS amount
     FROM transactions WHERE idempotency_key LIKE $1 OR idempotency_key IN (
       SELECT 'pedido-saldo-' || id::text FROM studio_payments WHERE order_id = $2)
    ORDER BY idempotency_key`, [`pedido-%${oid}`, oid])).rows.map((r) => [r.idempotency_key.slice(0, 13), r.status, Number(r.amount)]);

describe('quitar', () => {
  test('so o sinal: payment_status segue pending; sinal + saldo: vira confirmed e o Financeiro nao muda', async () => {
    const ped = await novoPedido();
    expect((await pedido(ped.oid)).payment_status).toBe('pending');

    expect((await pagar(ped.sinal)).status).toBe(200);
    expect((await pedido(ped.oid)).payment_status).toBe('pending');
    const aposSinal = await financeiro(ped.oid);

    expect((await pagar(ped.saldo)).status).toBe(200);
    expect((await pedido(ped.oid)).payment_status).toBe('confirmed');
    // so entrou o saldo e a conta foi quitada; nada de valor mudou no sinal
    const aposSaldo = await financeiro(ped.oid);
    expect(aposSaldo.filter((l) => l[0] === 'pedido-sinal-')).toEqual(aposSinal.filter((l) => l[0] === 'pedido-sinal-'));
    expect(aposSaldo.filter((l) => l[0] === 'pedido-saldo-').map((l) => [l[1], l[2]])).toEqual([['confirmed', 70]]);
  });

  test('repetir o recebimento nao muda nada (idempotente)', async () => {
    const ped = await novoPedido();
    await pagar(ped.sinal); await pagar(ped.saldo);
    const antes = await pedido(ped.oid);
    expect((await pagar(ped.saldo)).status).toBe(200);
    expect(await pedido(ped.oid)).toEqual(antes);
  });
});

describe('entregar', () => {
  test('quitado e entregue: delivered_at gravado, estoque 10 -> 8, stock_deducted TRUE', async () => {
    const ped = await novoPedido();
    await pagar(ped.sinal); await pagar(ped.saldo);
    expect((await entregar(ped)).status).toBe(200);
    const o = await pedido(ped.oid);
    expect(o).toMatchObject({ payment_status: 'confirmed', stock_deducted: true, studio_production_status: 'delivered' });
    expect(o.delivered_at).toBeTruthy();
    expect(await estoque(ped.produto)).toBe(8);
  });

  test('entregar duas vezes: nao baixa de novo e delivered_at nao muda', async () => {
    const ped = await novoPedido();
    await pagar(ped.sinal); await pagar(ped.saldo);
    await entregar(ped);
    const primeira = await pedido(ped.oid);
    expect((await entregar(ped)).status).toBe(200);
    const segunda = await pedido(ped.oid);
    expect(segunda.delivered_at).toEqual(primeira.delivered_at);
    expect(await estoque(ped.produto)).toBe(8);
    // 4 em paralelo tambem baixam uma vez so
    const ped2 = await novoPedido();
    await pagar(ped2.sinal); await pagar(ped2.saldo);
    await Promise.all(Array.from({ length: 4 }, () => entregar(ped2)));
    expect(await estoque(ped2.produto)).toBe(8);
  });

  test('entregar com saldo aberto: grava a entrega e baixa o estoque, mas NAO marca pago', async () => {
    const ped = await novoPedido();
    await pagar(ped.sinal);
    expect((await entregar(ped)).status).toBe(200);
    const o = await pedido(ped.oid);
    expect(o).toMatchObject({ payment_status: 'pending', stock_deducted: true });
    expect(o.delivered_at).toBeTruthy();
    expect(await estoque(ped.produto)).toBe(8);
    // receber o saldo depois quita, sem baixar de novo
    await pagar(ped.saldo);
    expect((await pedido(ped.oid)).payment_status).toBe('confirmed');
    expect(await estoque(ped.produto)).toBe(8);
  });

  test('estoque nao fica negativo (GREATEST 0, como na loja online)', async () => {
    const ped = await novoPedido({ estoque: 1 });
    await entregar(ped);
    expect(await estoque(ped.produto)).toBe(0);
  });
});

describe('fora do fluxo novo', () => {
  test('loja sem a trava e sem conta a receber: entregar segue como antes (nada baixa)', async () => {
    const ped = await novoPedido({ empresa: ID.semTrava });
    expect((await entregar(ped)).status).toBe(200);
    const o = await pedido(ped.oid);
    expect(o).toMatchObject({ stock_deducted: false, payment_status: 'pending' });
    expect(o.delivered_at).toBeNull();
    expect(await estoque(ped.produto)).toBe(10);
  });
});
