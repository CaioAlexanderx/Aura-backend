// ============================================================
// Empresa principal por dono — migration 404 e DELETE da última empresa
// Postgres real (INC-2026-10-22-01, tq-103, 22/10/2026)
//
// O que este arquivo prova, no banco do CI (todas as migrations aplicadas,
// inclusive a 404):
//   1. a 404 marca a empresa ATIVA mais antiga de quem não tem principal
//      ativa; não toca empresa inativa nem dono que já tem principal
//   2. a 404 é idempotente: a segunda execução não muda nenhuma linha
//   3. o INSERT do cadastro (colunas de auth.js, com is_primary) roda no
//      schema de verdade e a empresa nasce principal
//   4. o DELETE de verdade recusa a última empresa (409) e remove a segunda
//      (200) gravando audit_log com company_id da empresa removida
// Tudo dentro de UMA transação revertida no afterAll; cada teste do DELETE
// num SAVEPOINT próprio.
// ============================================================
'use strict';

jest.mock('../src/utils/multicnpjBilling', () => ({
  ...jest.requireActual('../src/utils/multicnpjBilling'),
  calculateMulticnpjValue: jest.fn().mockResolvedValue(null),
  safeSyncSubscriptionValue: jest.fn().mockResolvedValue({ synced: false, reason: 'no_subscription' }),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '404_companies_principal_por_dono.sql'),
  'utf8'
);

let pool;
let client;
let db;
let sp = 0;

async function novoDono(rotulo) {
  const id = uuid();
  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', $3)`,
    [id, `fixture-404-${rotulo}-${id}@example.test`, `Fixture 404 ${rotulo}`]
  );
  return id;
}

async function novaEmpresa(ownerId, { ativa = true, principal = false, criada }) {
  const id = uuid();
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, is_active, is_primary, created_at)
     VALUES ($1, $2, 'Fixture 404', $3, $4, $5)`,
    [id, ownerId, ativa, principal, criada]
  );
  return id;
}

async function estado(id) {
  const { rows } = await client.query('SELECT is_primary, is_active FROM companies WHERE id = $1', [id]);
  return rows[0];
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  db = require('../src/config/database');
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('migration 404 — principal para quem não tem', () => {
  const f = {};

  beforeAll(async () => {
    await client.query('SAVEPOINT m404');
    // A: duas ativas sem principal + uma inativa ainda mais antiga
    f.donoA = await novoDono('a');
    f.a0 = await novaEmpresa(f.donoA, { ativa: false, criada: '2026-01-01' });
    f.a1 = await novaEmpresa(f.donoA, { criada: '2026-02-01' });
    f.a2 = await novaEmpresa(f.donoA, { criada: '2026-03-01' });
    // B: já tem principal ativa (a mais nova) — não muda nada
    f.donoB = await novoDono('b');
    f.b1 = await novaEmpresa(f.donoB, { criada: '2026-01-01' });
    f.b2 = await novaEmpresa(f.donoB, { principal: true, criada: '2026-02-01' });
    // C: só empresa inativa — não muda nada
    f.donoC = await novoDono('c');
    f.c1 = await novaEmpresa(f.donoC, { ativa: false, criada: '2026-01-01' });
    // D: principal inativa + uma ativa — a ativa vira principal, a inativa fica
    f.donoD = await novoDono('d');
    f.d0 = await novaEmpresa(f.donoD, { ativa: false, principal: true, criada: '2026-01-01' });
    f.d1 = await novaEmpresa(f.donoD, { criada: '2026-02-01' });
    // E: única empresa, sem principal (o caso real)
    f.donoE = await novoDono('e');
    f.e1 = await novaEmpresa(f.donoE, { criada: '2026-05-01' });

    f.primeira = await client.query(MIGRATION);
    f.segunda = await client.query(MIGRATION);
  });

  afterAll(async () => {
    await client.query('ROLLBACK TO SAVEPOINT m404');
  });

  test('1a. marca a ativa mais antiga de quem não tem principal; a inativa fica como estava', async () => {
    expect(await estado(f.a0)).toEqual({ is_primary: false, is_active: false });
    expect(await estado(f.a1)).toEqual({ is_primary: true, is_active: true });
    expect(await estado(f.a2)).toEqual({ is_primary: false, is_active: true });
  });

  test('1b. o caso real: a única empresa ativa vira principal', async () => {
    expect(await estado(f.e1)).toEqual({ is_primary: true, is_active: true });
  });

  test('1c. dono que já tem principal ativa não muda', async () => {
    expect(await estado(f.b1)).toEqual({ is_primary: false, is_active: true });
    expect(await estado(f.b2)).toEqual({ is_primary: true, is_active: true });
  });

  test('1d. empresa inativa nunca é tocada', async () => {
    expect(await estado(f.c1)).toEqual({ is_primary: false, is_active: false });
    expect(await estado(f.d0)).toEqual({ is_primary: true, is_active: false });
    expect(await estado(f.d1)).toEqual({ is_primary: true, is_active: true });
  });

  test('2. idempotente: a segunda execução não muda nenhuma linha', async () => {
    expect(f.primeira.rowCount).toBeGreaterThanOrEqual(3); // A, D e E (+ o que o CI semeou)
    expect(f.segunda.rowCount).toBe(0);
  });

  test('2b. depois dela, nenhum dono com empresa ativa fica sem principal ativa', async () => {
    const { rows } = await client.query(
      `SELECT COUNT(DISTINCT c.owner_id)::int AS total
         FROM companies c
        WHERE c.is_active = true
          AND NOT EXISTS (SELECT 1 FROM companies p
                           WHERE p.owner_id = c.owner_id
                             AND p.is_active = true AND p.is_primary = true)`
    );
    expect(rows[0].total).toBe(0);
  });
});

describe('cadastro — INSERT com is_primary no schema de verdade', () => {
  test('3. a empresa do cadastro nasce principal', async () => {
    await client.query('SAVEPOINT cad404');
    try {
      const dono = await novoDono('cadastro');
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
      const m = src.match(/`(INSERT INTO companies \(owner_id, legal_name, trade_name, plan, onboarding_step[^`]*?)`/);
      expect(m).not.toBeNull();
      // Colunas e VALUES exatamente como o cadastro grava; o RETURNING vira
      // só id + is_primary (o schema do CI não tem todas as colunas que o
      // RETURNING do cadastro lê, como module_overrides).
      const insert = m[1].replace(/RETURNING[\s\S]*$/, 'RETURNING id, is_primary');
      expect(insert).toMatch(/tax_regime, is_primary\)/);
      const { rows: [c] } = await client.query(insert, [
        dono, 'Loja Fixture 404', 'negocio', null, null, null, null, null, null, null,
      ]);
      expect(c.is_primary).toBe(true);
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT cad404');
    }
  });
});

describe('DELETE /me/companies/:id — Postgres real', () => {
  let app;
  let dono;
  let auth;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/v1/me/companies', require('../src/routes/userCompanies'));
  });

  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    db.query.mockImplementation((sql, params) => client.query(sql, params));
    sp += 1;
    await client.query(`SAVEPOINT del404_${sp}`);
    dono = await novoDono('del');
    auth = { Authorization: `Bearer ${jwt.sign({ id: dono, role: 'client' }, 'aura-test-secret-2026', { expiresIn: '1h' })}` };
  });

  afterEach(async () => {
    await client.query(`ROLLBACK TO SAVEPOINT del404_${sp}`);
    jest.restoreAllMocks();
  });

  test('4a. última empresa ativa: 409 LAST_COMPANY e continua ativa', async () => {
    const id = await novaEmpresa(dono, { criada: '2026-05-01' });
    const res = await request(app).delete(`/api/v1/me/companies/${id}`).set(auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LAST_COMPANY');
    expect(await estado(id)).toEqual({ is_primary: false, is_active: true });
  });

  test('4b. segunda empresa com principal ativa: 200, desativa e grava audit_log', async () => {
    const principal = await novaEmpresa(dono, { principal: true, criada: '2026-01-01' });
    const segunda = await novaEmpresa(dono, { criada: '2026-02-01' });
    const res = await request(app).delete(`/api/v1/me/companies/${segunda}`).set(auth);
    expect(res.status).toBe(200);
    expect(await estado(segunda)).toEqual({ is_primary: false, is_active: false });
    expect(await estado(principal)).toEqual({ is_primary: true, is_active: true });
    const { rows } = await client.query(
      `SELECT user_id, company_id FROM audit_log WHERE action = 'remove_company' AND company_id = $1`,
      [segunda]
    );
    expect(rows).toEqual([{ user_id: dono, company_id: segunda }]);
  });
});
