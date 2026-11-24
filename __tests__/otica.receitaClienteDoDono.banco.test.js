// ============================================================
// AURA ÓTICA — Receita de cliente cadastrado em outra loja do mesmo dono
// (p-213, 23/11/2026) — Postgres real
//
// A lista de clientes do app é do DONO (owner-scope, customers.js): na loja
// A aparece o cliente cadastrado na loja B. A receita validava o cliente
// com company_id = loja atual, então escolher na loja A um cliente da loja
// B dava 404 "Cliente nao encontrado nesta empresa".
//
// Regra (a mesma do PATCH/DELETE de clientes e do crediário): o cliente do
// dono vale em qualquer loja dele. A receita nasce na loja onde foi aviada
// (company_id = loja atual); só a checagem do cliente passa a olhar o dono.
//
// O que este arquivo trava:
//   1. loja A cria receita para cliente da loja B (mesmo dono) -> 201
//   2. cliente de OUTRO dono continua 404 (isolamento de tenant)
//   3. cliente da própria loja segue funcionando
//   4. a receita criada aparece no GET da loja A com o nome do cliente
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
    'DELETE FROM optical_prescriptions WHERE company_id = ANY($1)',
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
      [id, `fixture-${id}@example.test`, `Fixture Otica ${nome}`]);
  }
  const otica = JSON.stringify({ otica_enabled: true });
  await q(`INSERT INTO companies (id, owner_id, legal_name, pdv_settings) VALUES ($1, $2, 'Fixture Otica A', $3::jsonb)`,
    [ID.lojaA, ID.dono, otica]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id, pdv_settings)
           VALUES ($1, $2, 'Fixture Otica B', $3, $4::jsonb)`, [ID.lojaB, ID.dono, ID.lojaA, otica]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, pdv_settings) VALUES ($1, $2, 'Fixture Otica de Fora', $3::jsonb)`,
    [ID.deFora, ID.outroDono, otica]);
  await q(`INSERT INTO customers (id, company_id, name) VALUES
             ($1, $4, 'Cliente da Loja A'), ($2, $5, 'Cliente da Loja B'), ($3, $6, 'Cliente de Fora')`,
    [ID.clienteA, ID.clienteB, ID.clienteDeFora, ID.lojaA, ID.lojaB, ID.deFora]);

  app = express();
  app.use(express.json());
  app.use('/companies/:id/otica', require('../src/routes/otica'));
});

afterAll(async () => {
  await limpar();
  await pool.end();
});

const receita = (loja, customerId) => request(app)
  .post(`/companies/${loja}/otica/prescriptions`)
  .send({ customer_id: customerId, issued_at: '2026-11-20', od_sph: -1.25, oe_sph: -1 });

describe('receita de cliente de outra loja do mesmo dono (p-213)', () => {
  it('loja A cria receita para o cliente cadastrado na loja B', async () => {
    const r = await receita(ID.lojaA, ID.clienteB);
    expect({ status: r.status, error: r.body.error }).toEqual({ status: 201, error: undefined });
    expect(r.body.prescription).toMatchObject({
      company_id: ID.lojaA, customer_id: ID.clienteB, customer_name: 'Cliente da Loja B',
    });
  });

  it('cliente de outro dono continua 404', async () => {
    const r = await receita(ID.lojaA, ID.clienteDeFora);
    expect(r.status).toBe(404);
    const { rows } = await q(
      'SELECT COUNT(*)::int AS n FROM optical_prescriptions WHERE customer_id = $1', [ID.clienteDeFora]);
    expect(rows[0].n).toBe(0);
  });

  it('cliente da própria loja segue funcionando', async () => {
    const r = await receita(ID.lojaA, ID.clienteA);
    expect(r.status).toBe(201);
  });

  it('a receita do cliente da loja B aparece na lista da loja A', async () => {
    const r = await request(app).get(`/companies/${ID.lojaA}/otica/prescriptions?customer_id=${ID.clienteB}`);
    expect(r.status).toBe(200);
    expect(r.body.prescriptions.map((p) => p.customer_name)).toEqual(['Cliente da Loja B']);
  });
});
