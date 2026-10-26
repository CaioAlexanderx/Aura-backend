// ============================================================
// Empresa nova nasce com e-mail (tq-41b, 26/10/2026) — Postgres real
//
// O tq-41 (#905) fez o cadastro gravar o e-mail do dono em companies.email.
// Aqui, os outros caminhos que criam empresa:
//   1. segunda empresa (POST /me/companies): sem e-mail no formulário (ou só
//      com espaço), nasce com users.email do dono; com e-mail, o do formulário
//   2. federação (POST /karate/federation/setup, formulário sem e-mail):
//      nasce com o e-mail de quem criou; se quem criou é da equipe Aura
//      (is_staff) fica NULL, como antes
// Dojô criado pela federação ou pela importação NÃO entra: o dono dele é um
// usuário de sistema (ver o PR). Empresas antigas não são preenchidas.
// Tudo dentro de UMA transação revertida no afterAll.
// ============================================================
'use strict';

jest.mock('../src/utils/multicnpjBilling', () => ({
  ...jest.requireActual('../src/utils/multicnpjBilling'),
  calculateMulticnpjValue: jest.fn().mockResolvedValue(null),
  safeSyncSubscriptionValue: jest.fn().mockResolvedValue({ synced: false, reason: 'no_subscription' }),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let app;

async function q(sql, params) {
  return client.query(sql, params);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  // Cada consulta da rota num SAVEPOINT: as best-effort que falham no schema
  // do CI (audit) não abortam a transação do teste.
  let qn = 0;
  let fila = Promise.resolve();
  async function noSavepoint(sql, params) {
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
  db.query.mockImplementation((sql, params) => {
    const p = fila.then(() => noSavepoint(sql, params));
    fila = p.catch(() => {});
    return p;
  });
  let sp = 0;
  db.connect.mockImplementation(async () => ({
    query: (sql, params) => {
      const s = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (s === 'BEGIN')    { sp += 1; return client.query(`SAVEPOINT rota_${sp}`); }
      if (s === 'COMMIT')   { return client.query(`RELEASE SAVEPOINT rota_${sp}`); }
      if (s === 'ROLLBACK') { return client.query(`ROLLBACK TO SAVEPOINT rota_${sp}`); }
      return client.query(sql, params);
    },
    release: () => {},
  }));

  // O INSERT da segunda empresa grava companies.address, coluna que o banco
  // de produção tem e o schema montado pelas migrations não. Só nesta
  // transação (some no ROLLBACK).
  await q(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS address TEXT`);

  app = express();
  app.use(express.json());
  app.use('/api/v1/me/companies', require('../src/routes/userCompanies'));
  app.use('/api/v1/karate', require('../src/routes/karateFederation'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function novoUsuario({ staff = false } = {}) {
  const id = uuid();
  const email = staff ? `fixture-41b-${id}@getaura.com.br` : `fixture-41b-${id}@example.test`;
  await q(
    `INSERT INTO users (id, email, password_hash, full_name, is_staff) VALUES ($1, $2, 'x', 'Fixture 41b', $3)`,
    [id, email, staff]
  );
  return { id, email, auth: { Authorization: `Bearer ${jwt.sign({ id, role: 'client' }, 'aura-test-secret-2026', { expiresIn: '1h' })}` } };
}

async function donoComPrincipal() {
  const dono = await novoUsuario();
  await q(
    `INSERT INTO companies (owner_id, legal_name, plan, is_primary, is_active) VALUES ($1, 'Fixture 41b Principal', 'negocio', true, true)`,
    [dono.id]
  );
  return dono;
}

async function emailDa(id) {
  const { rows } = await q('SELECT email FROM companies WHERE id = $1', [id]);
  return rows[0].email;
}

describe('POST /me/companies (segunda empresa)', () => {
  test('sem e-mail no formulário: nasce com o e-mail do dono', async () => {
    const dono = await donoComPrincipal();
    const res = await request(app).post('/api/v1/me/companies').set(dono.auth).send({ legal_name: 'Filial Centro' });
    expect(res.status).toBe(201);
    expect(await emailDa(res.body.company.id)).toBe(dono.email);
  });

  test('e-mail só com espaço conta como vazio', async () => {
    const dono = await donoComPrincipal();
    const res = await request(app).post('/api/v1/me/companies').set(dono.auth).send({ legal_name: 'Filial Sul', email: '   ' });
    expect(res.status).toBe(201);
    expect(await emailDa(res.body.company.id)).toBe(dono.email);
  });

  test('com e-mail no formulário: fica o do formulário', async () => {
    const dono = await donoComPrincipal();
    const res = await request(app).post('/api/v1/me/companies').set(dono.auth)
      .send({ legal_name: 'Filial Norte', email: ' filial@loja.test ' });
    expect(res.status).toBe(201);
    expect(await emailDa(res.body.company.id)).toBe('filial@loja.test');
  });

  test('a empresa principal (antiga) não é tocada', async () => {
    const dono = await novoUsuario();
    const { rows } = await q(
      `INSERT INTO companies (owner_id, legal_name, plan, is_primary, is_active) VALUES ($1, 'Fixture 41b Antiga', 'negocio', true, true) RETURNING id`,
      [dono.id]
    );
    await request(app).post('/api/v1/me/companies').set(dono.auth).send({ legal_name: 'Filial Leste' }).expect(201);
    expect(await emailDa(rows[0].id)).toBeNull();
  });
});

describe('POST /karate/federation/setup', () => {
  test('nasce com o e-mail de quem criou', async () => {
    const quem = await novoUsuario();
    const slug = `fed-41b-${quem.id.slice(0, 8)}`;
    const res = await request(app).post('/api/v1/karate/federation/setup').set(quem.auth).send({ name: 'Federação 41b', slug });
    expect(res.status).toBe(201);
    expect(await emailDa(res.body.id)).toBe(quem.email);
  });

  test('criada pela equipe Aura: e-mail fica NULL, como antes', async () => {
    const equipe = await novoUsuario({ staff: true });
    const slug = `fed-41b-staff-${equipe.id.slice(0, 8)}`;
    const res = await request(app).post('/api/v1/karate/federation/setup').set(equipe.auth).send({ name: 'Federação 41b Staff', slug });
    expect(res.status).toBe(201);
    expect(await emailDa(res.body.id)).toBeNull();
  });
});
