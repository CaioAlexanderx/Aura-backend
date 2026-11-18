// ============================================================
// AURA. — "Nova data" do pedido guardado no Caixa (17/11/2026)
// Postgres real. PATCH /companies/:id/pedidos/:oid/data.
//
// O que este arquivo prova:
//   1. a data muda no pedido aberto (Aguardando, Separando, Pronto) e o
//      atrasado sai do topo e do numero de atrasados quando a data nova e
//      futura; hoje vale; null tira a data;
//   2. data que ja passou, data invalida e corpo sem a chave: 422, nada muda;
//   3. pedido concluido ou cancelado: 409, nada muda;
//   4. pedido de outra loja, da loja online ou id invalido: 404;
//   5. so muda a data: situacao, estoque, reserva e Financeiro intactos, sem
//      e-mail e sem sino (o atraso nunca libera a reserva, pendencia 5);
//   6. a trava PEDIDO_LIBERADO vale na rota nova.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => next(),
  requireCompanyAccess: () => (req, _res, next) => next(),
  requirePlan: () => (req, _res, next) => next(),
  requireRole: () => (req, _res, next) => next(),
}));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyStatusChange: jest.fn(async () => {}), notifyPaymentConfirmed: jest.fn(async () => {}),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const ID = { dono: uuid(), centro: uuid(), shopping: uuid(), vestido: uuid() };
const EMPRESAS = [ID.centro, ID.shopping];
const { hojeSP } = require('../src/services/pedidoBalcao');
const { lerReservas, reservadoDoProduto } = require('../src/services/reservaDoPedido');
const HOJE = hojeSP();
const dia = (n) => {
  const d = new Date(HOJE + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let pool;
let app;
let usuario;
let seq = 0;
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  const passos = [
    [`DELETE FROM transactions WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_sequences WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = ANY($1)`, [[ID.dono]]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

async function pedido({ empresa = ID.centro, nome, status = 'confirmed', promessa = null, origem = 'balcao', qtd = 1 }) {
  seq += 1;
  const id = uuid();
  await q(`INSERT INTO digital_orders (id, company_id, order_number, customer_name, customer_phone, subtotal, total, status, origem, promised_date)
           VALUES ($1, $2, $3, $4, '', 100, 100, $5, $6, $7::date)`,
  [id, empresa, 'DAT-' + String(seq).padStart(4, '0'), nome, status, origem, promessa]);
  await q(`INSERT INTO digital_order_items (order_id, product_id, product_name, unit_price, quantity, subtotal)
           VALUES ($1, $2, 'Vestido Midi Linho', 100, $3, 100 * $3)`, [id, ID.vestido, qtd]);
  return id;
}

async function linha(id) {
  const { rows } = await q(`SELECT status::text AS status, promised_date::text AS promised_date, stock_deducted
                              FROM digital_orders WHERE id = $1`, [id]);
  return rows[0];
}

const patch = (empresa, oid, body) => request(app).patch(`/companies/${empresa}/pedidos/${oid}/data`).send(body);

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Dono')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, is_primary) VALUES
             ($1, $3, 'Fixture Centro LTDA', 'Centro', true),
             ($2, $3, 'Fixture Shopping LTDA', 'Shopping', false)`,
  [ID.centro, ID.shopping, ID.dono]);
  await q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Vestido Midi Linho', 189.9, 9)`,
    [ID.vestido, ID.centro]);

  // Mesma ordem do private.js: o router do B3 primeiro, o da nova data depois.
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/pedidos', require('../src/routes/pedidosDoBalcao'));
  app.use('/companies/:id/pedidos', require('../src/routes/pedidoNovaData'));
});

beforeEach(() => {
  usuario = { id: ID.dono, role: 'client', is_staff: true };
  delete process.env.PEDIDO_LIBERADO;
  jest.clearAllMocks();
});

afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

describe('PATCH /companies/:id/pedidos/:oid/data', () => {
  test('atrasado com data nova futura sai do topo e do numero de atrasados', async () => {
    const atrasada = await pedido({ nome: 'Marina Duarte', promessa: dia(-3) });
    const outra = await pedido({ nome: 'Carla', promessa: dia(-1) });
    const antes = await request(app).get(`/companies/${ID.centro}/pedidos`);
    expect(antes.body.orders[0].id).toBe(atrasada);
    const atrasadosAntes = antes.body.kpis.atrasados;

    const r = await patch(ID.centro, atrasada, { promised_date: dia(5) });
    expect(r.status).toBe(200);
    expect(r.body.ja_estava).toBe(false);
    expect(r.body.order.id).toBe(atrasada);
    expect(r.body.order.promised_date).toBe(dia(5));
    expect((await linha(atrasada)).promised_date).toBe(dia(5));

    const depois = await request(app).get(`/companies/${ID.centro}/pedidos`);
    expect(depois.body.orders[0].id).toBe(outra);
    const nova = depois.body.orders.find((o) => o.id === atrasada);
    expect(nova.atrasado).toBe(false);
    expect(depois.body.kpis.atrasados).toBe(atrasadosAntes - 1);
  });

  test('vale em Separando e Pronto; hoje vale; null tira a data; mesma data responde ja_estava', async () => {
    const sep = await pedido({ nome: 'Julia', status: 'preparing', promessa: dia(2) });
    const pronto = await pedido({ nome: 'Ana', status: 'ready', promessa: dia(-1) });

    const a = await patch(ID.centro, sep, { promised_date: HOJE });
    expect(a.status).toBe(200);
    expect((await linha(sep)).promised_date).toBe(HOJE);
    expect((await linha(sep)).status).toBe('preparing');

    const b = await patch(ID.centro, pronto, { promised_date: null });
    expect(b.status).toBe(200);
    expect(b.body.order.promised_date).toBe(null);
    expect((await linha(pronto)).promised_date).toBe(null);
    expect((await linha(pronto)).status).toBe('ready');

    const c = await patch(ID.centro, sep, { promised_date: HOJE });
    expect(c.status).toBe(200);
    expect(c.body.ja_estava).toBe(true);
  });

  test('data que ja passou, invalida ou ausente: 422 e nada muda', async () => {
    const id = await pedido({ nome: 'Bia', promessa: dia(4) });
    for (const body of [{ promised_date: dia(-1) }, { promised_date: '2026-02-30' }, { promised_date: '20/11/2026' },
      { promised_date: 20261120 }, {}]) {
      const r = await patch(ID.centro, id, body);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('PEDIDO_DATA');
      expect(typeof r.body.error).toBe('string');
    }
    const passada = await patch(ID.centro, id, { promised_date: dia(-1) });
    expect(passada.body.error).toBe('A data em que ela vem buscar já passou. Escolha hoje ou um dia depois.');
    expect((await linha(id)).promised_date).toBe(dia(4));
  });

  test('pedido concluido ou cancelado: 409 e a data fica', async () => {
    const feito = await pedido({ nome: 'Concluida', status: 'delivered', promessa: dia(-5) });
    const cancelado = await pedido({ nome: 'Cancelada', status: 'cancelled', promessa: dia(-5) });
    const a = await patch(ID.centro, feito, { promised_date: dia(3) });
    expect(a.status).toBe(409);
    expect(a.body.code).toBe('PEDIDO_FECHADO');
    expect(a.body.status).toBe('delivered');
    const b = await patch(ID.centro, cancelado, { promised_date: dia(3) });
    expect(b.status).toBe(409);
    expect((await linha(feito)).promised_date).toBe(dia(-5));
    expect((await linha(cancelado)).promised_date).toBe(dia(-5));
  });

  test('outra loja, loja online e id invalido: 404', async () => {
    const doCentro = await pedido({ nome: 'Centro', promessa: dia(1) });
    const online = await pedido({ nome: 'Online', origem: null, promessa: dia(1) });
    const doShopping = await pedido({ empresa: ID.shopping, nome: 'Shopping', promessa: dia(1) });

    expect((await patch(ID.shopping, doCentro, { promised_date: dia(6) })).status).toBe(404);
    expect((await patch(ID.centro, online, { promised_date: dia(6) })).status).toBe(404);
    expect((await patch(ID.centro, 'nao-e-uuid', { promised_date: dia(6) })).status).toBe(404);
    expect((await linha(doCentro)).promised_date).toBe(dia(1));
    expect((await linha(online)).promised_date).toBe(dia(1));

    // A loja dona (no consolidado o app chama a loja do pedido).
    const r = await patch(ID.shopping, doShopping, { promised_date: dia(6) });
    expect(r.status).toBe(200);
    expect((await linha(doShopping)).promised_date).toBe(dia(6));
  });

  test('so muda a data: reserva, estoque, situacao e Financeiro intactos, sem e-mail nem sino', async () => {
    const id = await pedido({ nome: 'Reserva', promessa: dia(-4), qtd: 2 });
    const reservaAntes = reservadoDoProduto(await lerReservas(pool, ID.centro, [ID.vestido]), ID.vestido);
    expect(reservaAntes).toBeGreaterThanOrEqual(2);
    const tx = async () => Number((await q(`SELECT COUNT(*)::int AS n FROM transactions WHERE company_id = $1`, [ID.centro])).rows[0].n);
    const txAntes = await tx();

    const r = await patch(ID.centro, id, { promised_date: dia(10) });
    expect(r.status).toBe(200);

    const reservaDepois = reservadoDoProduto(await lerReservas(pool, ID.centro, [ID.vestido]), ID.vestido);
    expect(reservaDepois).toBe(reservaAntes);
    const l = await linha(id);
    expect(l.status).toBe('confirmed');
    expect(l.stock_deducted === true).toBe(false);
    const { rows: [p] } = await q(`SELECT stock_qty FROM products WHERE id = $1`, [ID.vestido]);
    expect(Number(p.stock_qty)).toBe(9);
    expect(await tx()).toBe(txAntes);

    const notify = require('../src/services/digitalOrderNotifications');
    expect(notify.notifyStatusChange).not.toHaveBeenCalled();
    expect(notify.notifyPaymentConfirmed).not.toHaveBeenCalled();
    const ev = require('../src/services/lojaEvents');
    expect(ev.emit).not.toHaveBeenCalled();
    expect(ev.emitLojaEvent).not.toHaveBeenCalled();
  });

  test('trava: lojista sem PEDIDO_LIBERADO recebe 404 e nada muda; com a trava ligada, grava', async () => {
    const id = await pedido({ nome: 'Trava', promessa: dia(2) });
    usuario = { id: ID.dono, role: 'client', is_staff: false };
    const r = await patch(ID.centro, id, { promised_date: dia(8) });
    expect(r.status).toBe(404);
    expect((await linha(id)).promised_date).toBe(dia(2));

    process.env.PEDIDO_LIBERADO = 'true';
    const ok = await patch(ID.centro, id, { promised_date: dia(8) });
    expect(ok.status).toBe(200);
    expect((await linha(id)).promised_date).toBe(dia(8));
  });

  test('so o router novo, sem o do B3 na frente, tambem trava', async () => {
    const id = await pedido({ nome: 'So o novo', promessa: dia(2) });
    const so = express();
    so.use(express.json());
    so.use((req, _res, next) => { req.user = { id: ID.dono, role: 'client', is_staff: false }; next(); });
    so.use('/companies/:id/pedidos', require('../src/routes/pedidoNovaData'));
    const r = await request(so).patch(`/companies/${ID.centro}/pedidos/${id}/data`).send({ promised_date: dia(8) });
    expect(r.status).toBe(404);
    expect((await linha(id)).promised_date).toBe(dia(2));
  });
});
