// ============================================================
// AURA — OS de cliente cadastrado em outra loja do mesmo dono
// (24/11/2026) — Postgres real
//
// A lista de clientes do app é do DONO (owner-scope, customers.js): na loja
// A aparece o cliente cadastrado na loja B. O POST /service-orders validava
// o cliente com company_id = loja atual, então abrir na loja A uma OS (de
// reparo ou de ótica) para um cliente da loja B dava 404 "Cliente nao
// encontrado nesta empresa". Mesma regra da receita (Aura-backend#1100).
//
// O que este arquivo trava:
//   1. loja A abre OS de reparo e de ótica para cliente da loja B -> 201,
//      com a OS nascendo na loja A (company_id);
//   2. cliente de OUTRO dono continua 404, sem gravar OS;
//   3. cliente da própria loja segue funcionando;
//   4. a OS aberta aparece na lista da loja A com o nome do cliente.
// ============================================================
'use strict';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = req.user || { id: null }; next(); },
  requireCompanyAccess: () => (_req, _res, next) => next(),
  requirePlan: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(120000);

const ID = {
  dono: uuid(), outroDono: uuid(),
  lojaA: uuid(), lojaB: uuid(), deFora: uuid(),
  clienteA: uuid(), clienteB: uuid(), clienteDeFora: uuid(),
};
const EMPRESAS = [ID.lojaA, ID.lojaB, ID.deFora];

let pool;
let app;
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  for (const sql of [
    'DELETE FROM service_order_items WHERE service_order_id IN (SELECT id FROM service_orders WHERE company_id = ANY($1))',
    'DELETE FROM service_orders WHERE company_id = ANY($1)',
    'DELETE FROM customers WHERE company_id = ANY($1)',
    'DELETE FROM companies WHERE id = ANY($1)',
  ]) {
    try { await q(sql, [EMPRESAS]); } catch (_) { /* tabela ausente: nada a limpar */ }
  }
  try { await q('DELETE FROM users WHERE id = ANY($1)', [[ID.dono, ID.outroDono]]); } catch (_) { /* idem */ }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 4 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  await limpar();
  for (const [id, nome] of [[ID.dono, 'Dono'], [ID.outroDono, 'Outro']]) {
    await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', $3)`,
      [id, `fixture-${id}@example.test`, `Fixture OS ${nome}`]);
  }
  const ligado = JSON.stringify({ os_enabled: true, otica_enabled: true });
  await q(`INSERT INTO companies (id, owner_id, legal_name, pdv_settings) VALUES ($1, $2, 'Fixture OS A', $3::jsonb)`,
    [ID.lojaA, ID.dono, ligado]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id, pdv_settings)
           VALUES ($1, $2, 'Fixture OS B', $3, $4::jsonb)`, [ID.lojaB, ID.dono, ID.lojaA, ligado]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, pdv_settings) VALUES ($1, $2, 'Fixture OS de Fora', $3::jsonb)`,
    [ID.deFora, ID.outroDono, ligado]);
  await q(`INSERT INTO customers (id, company_id, name) VALUES
             ($1, $4, 'Cliente da Loja A'), ($2, $5, 'Cliente da Loja B'), ($3, $6, 'Cliente de Fora')`,
    [ID.clienteA, ID.clienteB, ID.clienteDeFora, ID.lojaA, ID.lojaB, ID.deFora]);

  app = express();
  app.use(express.json());
  app.use('/companies/:id/service-orders', require('../src/routes/serviceOrders'));
});

afterAll(async () => {
  await limpar();
  await pool.end();
});

const OPTICAL = {
  prescription: { od: { sph: -1.25 }, oe: { sph: -1 } },
  lens: { type: 'pronta', brand: 'Marca X', design: '', material: '1,56', treatments: [] },
  frame: { source: 'cliente', product_id: null, description: 'Armação do cliente' },
  use: 'longe',
};

const abrirReparo = (loja, customerId) => request(app)
  .post(`/companies/${loja}/service-orders`)
  .send({ customer_id: customerId, reported_issue: 'Tela trincada', equipment_type: 'Celular' });

const abrirOtica = (loja, customerId) => request(app)
  .post(`/companies/${loja}/service-orders`)
  .send({ kind: 'otica', customer_id: customerId, optical: OPTICAL });

const osDoCliente = async (customerId) =>
  (await q('SELECT company_id, kind FROM service_orders WHERE customer_id = $1 ORDER BY created_at', [customerId])).rows;

describe('OS de cliente de outra loja do mesmo dono', () => {
  it('loja A abre OS de reparo para o cliente cadastrado na loja B, e a OS é da loja A', async () => {
    const r = await abrirReparo(ID.lojaA, ID.clienteB);
    expect({ status: r.status, error: r.body.error }).toEqual({ status: 201, error: undefined });
    expect(r.body.order).toMatchObject({
      company_id: ID.lojaA, customer_id: ID.clienteB, customer_name: 'Cliente da Loja B', kind: 'reparo',
    });
  });

  it('loja A abre OS de ótica para o cliente cadastrado na loja B', async () => {
    const r = await abrirOtica(ID.lojaA, ID.clienteB);
    expect({ status: r.status, error: r.body.error }).toEqual({ status: 201, error: undefined });
    expect(r.body.order).toMatchObject({ company_id: ID.lojaA, customer_id: ID.clienteB, kind: 'otica' });
  });

  it('cliente de outro dono continua 404, sem gravar OS (reparo e ótica)', async () => {
    const r1 = await abrirReparo(ID.lojaA, ID.clienteDeFora);
    const r2 = await abrirOtica(ID.lojaA, ID.clienteDeFora);
    expect([r1.status, r2.status]).toEqual([404, 404]);
    expect(r1.body.error).toBe('Cliente nao encontrado nesta empresa');
    expect(await osDoCliente(ID.clienteDeFora)).toEqual([]);
  });

  it('a outra loja do dono não abre OS para cliente de fora', async () => {
    const r = await abrirReparo(ID.lojaB, ID.clienteDeFora);
    expect(r.status).toBe(404);
  });

  it('cliente da própria loja segue funcionando', async () => {
    const r = await abrirReparo(ID.lojaA, ID.clienteA);
    expect(r.status).toBe(201);
    expect(r.body.order.company_id).toBe(ID.lojaA);
  });

  it('a OS do cliente da loja B aparece na lista da loja A com o nome dele', async () => {
    const r = await request(app).get(`/companies/${ID.lojaA}/service-orders?customer_id=${ID.clienteB}`);
    expect(r.status).toBe(200);
    expect(r.body.orders.map((o) => o.customer_name)).toEqual(['Cliente da Loja B', 'Cliente da Loja B']);
    expect(await osDoCliente(ID.clienteB)).toEqual([
      { company_id: ID.lojaA, kind: 'reparo' }, { company_id: ID.lojaA, kind: 'otica' },
    ]);
  });
});
