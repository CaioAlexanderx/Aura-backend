// ============================================================
// AURA. — access_codes aceita tipo manual e plano personalizado
// (Postgres real, 11/09/2026)
//
// O CASO REAL: em producao access_codes ainda tinha os CHECKs da 019
// (type IN payment/trial/referral/promo, plan IN essencial/negocio/expansao).
// O Gestao Aura oferece "Manual", a rota aceita 'manual' e 'personalizado',
// e o INSERT estourava 23514 -> 500.
//
// O que este arquivo cobre:
//   1. depois das migrations, os dois CHECKs tem o nome padrao e a uniao dos
//      valores (os antigos continuam valendo)
//   2. toda combinacao que o painel manda passa pela rota e grava de verdade
//   3. o outro lado: valor fora da lista continua barrado pelo banco
//   4. o caminho de producao: banco com os CHECKs da 019 -> a rota devolve 400
//      dizendo o que falta; aplicada a 327, o mesmo POST vira 201
//   5. rodar a 327 de novo nao duplica nada
//   6. CHECK antigo com outro nome faz a 327 falhar alto, nao passar calada
//   7. quem le o codigo depois (checkout e cadastro) nao tropeca em
//      'manual' / 'personalizado' — o cadastro copia o plano do codigo para
//      companies.plan (enum plan_type), que tambem precisou do valor novo
//
// Mesmo padrao de credito.desfazerLancamentoSemParcelaOrfa.test.js: conecta
// direto no Postgres, tudo dentro de UMA transacao revertida no afterAll.
// O db mockado do jest.setup e redirecionado para essa mesma conexao, para
// que a rota e o servico de cupom falem com o banco de verdade.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const adminAccessCodes = require('../src/routes/adminAccessCodes');
const { validateCoupon } = require('../src/services/checkoutCoupon');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const MIGRATION_327 = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '327_access_codes_tipo_manual_e_plano_personalizado.sql'),
  'utf8'
);

// O que o AccessCodesCard.tsx (aura-app) oferece + o que a rota aceita.
const TIPOS_DO_PAINEL = ['trial', 'promo', 'manual'];
const PLANOS_DA_ROTA = ['essencial', 'negocio', 'expansao', 'personalizado'];

// Os CHECKs como a 019 criou — o estado de producao antes da 327.
const CHECK_TYPE_019 = "CHECK (type IN ('payment','trial','referral','promo'))";
const CHECK_PLAN_019 = "CHECK (plan IN ('essencial','negocio','expansao'))";

const SECRET = 'aura-test-secret-2026';
const admin = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

let pool;
let client;
let db;
let seq = 0;

const app = express();
app.use(express.json());
app.use('/admin', adminAccessCodes);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(err.statusCode || err.status || 500).json({ error: err.message });
});

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  db = require('../src/config/database');
});

beforeEach(() => {
  db.query.mockImplementation((sql, params) => client.query(sql, params));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

// ── helpers ──────────────────────────────────────────────────────────────

// Codigo unico que respeita o CODE_REGEX da rota (A-Z, 0-9, hifen, 3-20).
function novoCodigo() {
  seq += 1;
  return `T327-${seq}-${uuid().slice(0, 6).toUpperCase()}`;
}

async function checksDeTypeEPlan() {
  const { rows } = await client.query(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.conrelid = 'access_codes'::regclass
        AND c.contype = 'c'
        AND a.attname IN ('type', 'plan')
      ORDER BY c.conname`
  );
  return rows;
}

// Roda fn num SAVEPOINT e sempre volta para antes dele: o erro esperado de um
// passo nao aborta a transacao do arquivo inteiro.
async function isolado(fn) {
  await client.query('SAVEPOINT t327');
  try {
    return await fn();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT t327');
  }
}

async function erroDe(sql, params) {
  return isolado(async () => {
    try {
      await client.query(sql, params);
      return null;
    } catch (e) {
      return e;
    }
  });
}

// Volta access_codes ao estado da 019. NOT VALID porque os codigos manuais que
// este arquivo ja gravou na transacao nao passariam na validacao — em producao
// eles nao existem, e o que importa aqui e o INSERT novo ser barrado.
async function voltarParaOs019() {
  await client.query(
    `ALTER TABLE access_codes DROP CONSTRAINT access_codes_type_check;
     ALTER TABLE access_codes DROP CONSTRAINT access_codes_plan_check;
     ALTER TABLE access_codes ADD CONSTRAINT access_codes_type_check ${CHECK_TYPE_019} NOT VALID;
     ALTER TABLE access_codes ADD CONSTRAINT access_codes_plan_check ${CHECK_PLAN_019} NOT VALID;`
  );
}

// POST pela rota de verdade. Um INSERT barrado pelo CHECK aborta a transacao;
// o SAVEPOINT desfaz so ele, e o cenario seguinte nao herda o erro.
async function postCodigo(extra) {
  await client.query('SAVEPOINT t327_post');
  let res;
  try {
    res = await request(app).post('/admin/access-codes').set(admin).send({
      code: novoCodigo(), type: 'manual', plan: 'negocio', trial_days: 30, ...extra,
    });
  } finally {
    await client.query(
      res && res.status === 201 ? 'RELEASE SAVEPOINT t327_post' : 'ROLLBACK TO SAVEPOINT t327_post'
    );
  }
  return res;
}

// ── 1. schema ────────────────────────────────────────────────────────────

describe('schema de access_codes depois das migrations', () => {
  test('dois CHECKs, nome padrao, com os valores novos e os antigos', async () => {
    const checks = await checksDeTypeEPlan();
    expect(checks.map((c) => c.conname)).toEqual(['access_codes_plan_check', 'access_codes_type_check']);

    const type = checks.find((c) => c.conname === 'access_codes_type_check').def;
    for (const v of ['payment', 'trial', 'referral', 'promo', 'manual']) expect(type).toContain(`'${v}'`);

    const plan = checks.find((c) => c.conname === 'access_codes_plan_check').def;
    for (const v of PLANOS_DA_ROTA) expect(plan).toContain(`'${v}'`);
  });
});

// ── 2 e 3. o que entra e o que continua barrado ──────────────────────────

describe('POST /admin/access-codes contra o banco', () => {
  test.each(TIPOS_DO_PAINEL.flatMap((t) => PLANOS_DA_ROTA.map((p) => [t, p])))(
    'tipo %s + plano %s grava (201)',
    async (type, plan) => {
      const res = await postCodigo({ type, plan });
      expect(res.status).toBe(201);
      expect(res.body.code).toMatchObject({ type, plan });

      const { rows } = await client.query('SELECT type, plan FROM access_codes WHERE id = $1', [res.body.code.id]);
      expect(rows[0]).toEqual({ type, plan });
    }
  );

  test('os tipos que so o sistema cria (payment, referral) continuam valendo', async () => {
    for (const type of ['payment', 'referral']) {
      const err = await erroDe(
        `INSERT INTO access_codes (code, type, plan) VALUES ($1, $2, 'essencial')`,
        [novoCodigo(), type]
      );
      expect(err).toBeNull();
    }
  });

  test('tipo e plano fora da lista continuam barrados pelo banco', async () => {
    const tipo = await erroDe(
      `INSERT INTO access_codes (code, type, plan) VALUES ($1, 'cortesia', 'negocio')`,
      [novoCodigo()]
    );
    expect(tipo).toMatchObject({ code: '23514', constraint: 'access_codes_type_check' });

    const plano = await erroDe(
      `INSERT INTO access_codes (code, type, plan) VALUES ($1, 'manual', 'premium')`,
      [novoCodigo()]
    );
    expect(plano).toMatchObject({ code: '23514', constraint: 'access_codes_plan_check' });
  });
});

// ── 4. o caminho de producao ─────────────────────────────────────────────

describe('banco com os CHECKs da 019 (producao antes da 327)', () => {
  test('manual vira 400 que aponta a 327; aplicada a 327, o mesmo POST vira 201', async () => {
    await isolado(async () => {
      await voltarParaOs019();

      const antes = await postCodigo({ type: 'manual', plan: 'negocio' });
      expect(antes.status).toBe(400);
      expect(antes.body.error).toMatch(/migration 327/);

      const antesPlano = await postCodigo({ type: 'promo', plan: 'personalizado', trial_days: 0, discount_pct: 10 });
      expect(antesPlano.status).toBe(400);

      await client.query(MIGRATION_327);

      const depois = await postCodigo({ type: 'manual', plan: 'personalizado' });
      expect(depois.status).toBe(201);
    });
  });
});

// ── 5 e 6. a migration em si ─────────────────────────────────────────────

describe('migration 327', () => {
  test('rodar de novo nao duplica nem afrouxa os CHECKs', async () => {
    const antes = await checksDeTypeEPlan();
    await client.query(MIGRATION_327);
    await client.query(MIGRATION_327);
    expect(await checksDeTypeEPlan()).toEqual(antes);
  });

  test('CHECK antigo com outro nome faz a migration falhar com o nome dele', async () => {
    const err = await isolado(async () => {
      await client.query(
        `ALTER TABLE access_codes ADD CONSTRAINT access_codes_tipo_legado ${CHECK_TYPE_019} NOT VALID`
      );
      try {
        await client.query(MIGRATION_327);
        return null;
      } catch (e) {
        return e;
      }
    });
    expect(err).not.toBeNull();
    expect(err.message).toMatch(/access_codes_tipo_legado/);
  });
});

// ── 7. quem le o codigo depois ───────────────────────────────────────────

describe('leitores de access_codes', () => {
  test('checkout aceita cupom manual de dias gratis', async () => {
    const res = await postCodigo({ type: 'manual', plan: 'personalizado', trial_days: 30 });
    expect(res.status).toBe(201);

    const cupom = await validateCoupon(res.body.code.code, uuid());
    expect(cupom).toMatchObject({ valid: true, type: 'manual', trial_days: 30 });
  });

  test('cadastro grava plan=personalizado do codigo na empresa', async () => {
    // auth.js /register copia access_codes.plan para companies.plan, que e o
    // enum plan_type. Sem 'personalizado' no enum o cadastro quebra (22P02).
    const { rows: [{ planos }] } = await client.query('SELECT enum_range(NULL::plan_type)::text[] AS planos');
    expect(planos).toEqual(['essencial', 'negocio', 'expansao', 'personalizado']);

    const userId = uuid();
    await client.query(
      `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture 327')`,
      [userId, `fixture-${userId}@example.test`]
    );
    const err = await erroDe(
      `INSERT INTO companies (owner_id, legal_name, plan) VALUES ($1, 'Fixture 327', 'personalizado')`,
      [userId]
    );
    expect(err).toBeNull();
  });
});
