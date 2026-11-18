// ============================================================
// AURA. — Paridade da fila do Canal Digital com o pedido do balcao (B1)
// Postgres real, transacao unica revertida no afterAll.
//
// O pedido guardado no Caixa (origem 'balcao', migration 459) mora em
// digital_orders, a mesma tabela da loja online. O que este arquivo trava:
//
//   1. GET /digital-channel/orders (fila, contagens e paginacao) devolve
//      EXATAMENTE a mesma resposta antes e depois de a loja ter pedidos do
//      balcao em toda situacao — sem filtro, por situacao, com busca por
//      nome, produto e numero, e na segunda pagina. Os pedidos da loja
//      (origem NULL) e os da Aurinha (origem 'aurinha') continuam todos la;
//   2. o PATCH /status do Canal recusa o pedido do balcao (409), sem mudar
//      nada e sem avisar a cliente; a saida para entrega tambem;
//   3. o pedido da loja segue andando pelo PATCH /status como hoje;
//   4. a loja online nao consegue gravar a origem 'balcao' pela atribuicao.
//
// Em producao digital_orders.status e payment_status sao TEXT (conferido em
// 17/11/2026, information_schema, so leitura). O banco do CI nasce com os
// ENUM da 070, e a contagem da fila ('expired') nao roda nele. Dentro da
// transacao revertida as duas colunas viram TEXT como em producao — mesmo
// desenho de pedidoDaLojaPersonalizado.banco.test.js.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyStatusChange: jest.fn(async () => {}), notifyPaymentConfirmed: jest.fn(async () => {}),
}));
jest.mock('../src/services/nfceEmissionService', () => ({
  emitForDigitalOrder: jest.fn(async () => ({ skipped: true, reason: 'teste' })),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

let pool;
let client;
let app;
let qn = 0;
let seq = 0;

const dono = uuid();
const loja = uuid();
const camiseta = uuid();
const caneca = uuid();
const CANAL = `/companies/${loja}/digital-channel/orders`;

let fila = Promise.resolve();
function naFila(fn) {
  const p = fila.then(fn);
  fila = p.catch(() => {});
  return p;
}

// Uma consulta "solta" (db.query): savepoint proprio, erro nao contamina.
async function soltaNoSavepoint(sql, params) {
  qn += 1;
  const sp = `q_${qn}`;
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const r = await client.query(sql, params);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return r;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    throw err;
  }
}
const q = (sql, params) => naFila(() => soltaNoSavepoint(sql, params));

// O client da transacao da rota: BEGIN/COMMIT/ROLLBACK viram savepoint.
function clienteDaRota() {
  return {
    query: (sql, params) => naFila(async () => {
      const s = String(sql).trim();
      if (s === 'BEGIN') return client.query('SAVEPOINT rota');
      if (s === 'COMMIT') return client.query('RELEASE SAVEPOINT rota');
      if (s === 'ROLLBACK') {
        await client.query('ROLLBACK TO SAVEPOINT rota');
        return client.query('RELEASE SAVEPOINT rota');
      }
      return client.query(sql, params);
    }),
    release: () => {},
  };
}

async function statusComoEmProducao() {
  const { rows: tipos } = await q(
    `SELECT udt_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'digital_orders' AND column_name = 'status'`);
  if (!tipos.length || tipos[0].udt_name === 'text') return;
  const { rows: views } = await q(
    `SELECT DISTINCT c.relname AS nome, pg_get_viewdef(c.oid) AS def
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class c ON c.oid = r.ev_class
      WHERE d.refobjid = 'digital_orders'::regclass AND c.relname <> 'digital_orders'`);
  const { rows: gatilhos } = await q(
    `SELECT tgname AS nome, pg_get_triggerdef(oid) AS def
       FROM pg_trigger WHERE tgrelid = 'digital_orders'::regclass AND NOT tgisinternal`);
  const { rows: indices } = await q(
    `SELECT indexname AS nome, indexdef AS def FROM pg_indexes
      WHERE tablename = 'digital_orders' AND indexdef LIKE '%::digital_order%'`);
  for (const v of views) await q(`DROP VIEW IF EXISTS ${v.nome} CASCADE`);
  for (const g of gatilhos) await q(`DROP TRIGGER ${g.nome} ON digital_orders`);
  for (const i of indices) await q(`DROP INDEX ${i.nome}`);
  await q(`ALTER TABLE digital_orders ALTER COLUMN status DROP DEFAULT, ALTER COLUMN payment_status DROP DEFAULT`);
  await q(`ALTER TABLE digital_orders ALTER COLUMN status TYPE text, ALTER COLUMN payment_status TYPE text`);
  await q(`ALTER TABLE digital_orders ALTER COLUMN status SET DEFAULT 'pending_payment',
                                     ALTER COLUMN payment_status SET DEFAULT 'pending'`);
  for (const i of indices) await q(i.def.replace(/::digital_order_(payment_)?status/g, '::text'));
  for (const g of gatilhos) await q(g.def);
  for (const v of views) await q(`CREATE VIEW ${v.nome} AS ${v.def.replace(/::digital_order_(payment_)?status/g, '::text')}`);
}

async function pedidoDaLoja({ status, nome = 'Cliente Loja', origem = null, produto = camiseta, pagamento = 'pending' }) {
  seq += 1;
  const id = uuid();
  await q(
    `INSERT INTO digital_orders
       (id, company_id, order_number, customer_name, customer_phone, subtotal, total, status, payment_status, origem, created_at)
     VALUES ($1, $2, $3, $4, '11977776666', 50, 50, $5, $6, $7, NOW() - ($8 || ' minutes')::interval)`,
    [id, loja, 'LJ-' + String(seq).padStart(4, '0'), nome, status, pagamento, origem, String(100 - seq)]);
  await q(`INSERT INTO digital_order_items (order_id, product_id, product_name, unit_price, quantity, subtotal)
           VALUES ($1, $2, 'Camiseta basica', 50, 1, 50)`, [id, produto]);
  return id;
}

function guardarNoCaixa(body) {
  return request(app).post(`/companies/${loja}/pedidos`)
    .set('Idempotency-Key', `paridade-${uuid()}`).send(body);
}

const CONSULTAS = [
  '', '?status=all', '?status=confirmed', '?status=preparing', '?status=ready',
  '?status=cancelled', '?q=Cliente', '?q=Camiseta', '?q=Caneca', '?q=1', '?page=2&limit=2',
];

async function retrato() {
  const out = {};
  for (const c of CONSULTAS) {
    const r = await request(app).get(CANAL + c);
    expect(r.status).toBe(200);
    out[c] = r.body;
  }
  return out;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 2 });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => q(sql, params));
  db.connect.mockImplementation(async () => clienteDaRota());

  await statusComoEmProducao();
  await q(`ALTER TABLE digital_order_sequences ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Paridade')`,
    [dono, `fixture-${dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture Paridade')`, [loja, dono]);
  await q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $3, 'Camiseta basica', 50, 5), ($2, $3, 'Caneca lisa', 30, 5)`,
    [camiseta, caneca, loja]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: dono, role: 'client', is_staff: true }; next(); });
  app.use('/companies/:id/pedidos', require('../src/routes/pedidosDoBalcao'));
  app.use('/companies/:id/digital-channel/orders', require('../src/routes/digitalOrders'));
});

afterAll(async () => {
  if (!client) return;
  await fila;
  await client.query('ROLLBACK').catch(() => {});
  client.release();
  await pool.end();
});

describe('fila do Canal Digital', () => {
  test('pedido do balcao nao muda a fila, as contagens nem a paginacao', async () => {
    await pedidoDaLoja({ status: 'confirmed', pagamento: 'paid' });
    await pedidoDaLoja({ status: 'preparing', nome: 'Cliente Aurinha', origem: 'aurinha' });
    await pedidoDaLoja({ status: 'pending_payment' });
    await pedidoDaLoja({ status: 'ready', produto: caneca });
    await pedidoDaLoja({ status: 'cancelled', pagamento: 'expired' });
    await pedidoDaLoja({ status: 'delivered' });

    const antes = await retrato();
    expect(antes[''].orders).toHaveLength(6);
    expect(antes[''].counts).toMatchObject({ total: 6, confirmed: 1, preparing: 1, ready: 1, cancelled: 1, expired: 1, delivered: 1 });

    // Pedidos do balcao em toda situacao, com o mesmo nome e os mesmos
    // produtos dos da loja (para cair na busca): pela rota e por INSERT.
    const a = await guardarNoCaixa({ items: [{ product_id: camiseta, quantity: 1, unit_price: 50 }], customer_name: 'Cliente Loja' });
    expect(a.status).toBe(201);
    const b = await guardarNoCaixa({ items: [{ product_id: caneca, quantity: 2, unit_price: 30 }], customer_name: 'Cliente Aurinha' });
    expect(b.status).toBe(201);
    await q(`UPDATE digital_orders SET status = 'preparing' WHERE id = $1`, [b.body.order.id]);
    await pedidoDaLoja({ status: 'ready', origem: 'balcao' });
    await pedidoDaLoja({ status: 'cancelled', origem: 'balcao', pagamento: 'expired' });
    await pedidoDaLoja({ status: 'delivered', origem: 'balcao' });

    const depois = await retrato();
    expect(depois).toEqual(antes);
  });
});

describe('acoes do Canal no pedido do balcao', () => {
  test('PATCH /status e saida para entrega recusam, sem mudar nada e sem avisar a cliente', async () => {
    const r0 = await guardarNoCaixa({ items: [{ product_id: camiseta, quantity: 1, unit_price: 50 }] });
    const id = r0.body.order.id;
    const notify = require('../src/services/digitalOrderNotifications');
    const lojaEvents = require('../src/services/lojaEvents');
    notify.notifyStatusChange.mockClear();
    lojaEvents.emit.mockClear();
    for (const status of ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled']) {
      const r = await request(app).patch(`${CANAL}/${id}/status`).send({ status });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PEDIDO_DO_BALCAO');
    }
    await q(`UPDATE digital_orders SET status = 'ready' WHERE id = $1`, [id]);
    const s = await request(app).post(`${CANAL}/${id}/out-for-delivery`).send({});
    expect(s.status).toBe(409);
    expect(s.body.code).toBe('PEDIDO_DO_BALCAO');
    const { rows: [o] } = await q(
      `SELECT status, payment_status, stock_deducted, transaction_id, delivered_at, cancelled_at FROM digital_orders WHERE id = $1`, [id]);
    expect(o).toMatchObject({ status: 'ready', payment_status: 'pending', stock_deducted: false, delivered_at: null, cancelled_at: null });
    // B4a: o pedido do balcao tem a conta "Pedido a receber" desde que foi
    // guardado. O Canal nao a quita (quitarNaEntrega) nem a estorna.
    expect(o.transaction_id).not.toBeNull();
    const { rows: [conta] } = await q(`SELECT status::text AS status FROM transactions WHERE id = $1`, [o.transaction_id]);
    expect(conta.status).toBe('pending');
    expect(notify.notifyStatusChange).not.toHaveBeenCalled();
    expect(lojaEvents.emit).not.toHaveBeenCalled();
  });

  test('pedido da loja segue andando pelo PATCH /status, como hoje', async () => {
    const id = await pedidoDaLoja({ status: 'confirmed', pagamento: 'paid' });
    const r = await request(app).patch(`${CANAL}/${id}/status`).send({ status: 'preparing' });
    expect(r.status).toBe(200);
    expect(r.body.order.status).toBe('preparing');
    const aurinha = await pedidoDaLoja({ status: 'preparing', origem: 'aurinha' });
    const r2 = await request(app).patch(`${CANAL}/${aurinha}/status`).send({ status: 'ready' });
    expect(r2.status).toBe(200);
  });
});

describe('atribuicao da loja online', () => {
  test("origem 'balcao' ou 'orcamento' vinda da loja nao e gravada", async () => {
    const { lerAtribuicao, gravarAtribuicao } = require('../src/services/atribuicaoDoPedido');
    const id = await pedidoDaLoja({ status: 'pending_payment' });
    const db = require('../src/config/database');
    for (const origem of ['balcao', 'BALCAO', ' orcamento ']) {
      await gravarAtribuicao(db, { orderId: id, companyId: loja, atribuicao: lerAtribuicao({ origem }) });
    }
    await gravarAtribuicao(db, { orderId: id, companyId: loja, atribuicao: lerAtribuicao({ origem: 'aurinha' }) });
    const { rows: [o] } = await q(`SELECT origem FROM digital_orders WHERE id = $1`, [id]);
    expect(o.origem).toBe('aurinha');
    const r = await request(app).get(`${CANAL}?status=pending_payment`);
    expect(r.body.orders.map((x) => x.id)).toContain(id);
  });
});
