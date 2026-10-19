// ============================================================
// AURA. pdv_settings da conta nova — migration 399 — Postgres real
//
// Decisao do Caio (19/10/2026): conta nova nasce com o controle de caixa, o
// vendedor obrigatorio e o cliente obrigatorio DESLIGADOS ("bloqueador
// gigantesco da primeira venda"). O default da coluna manda: nenhum INSERT de
// companies grava pdv_settings. O que este arquivo prova:
//   1. empresa criada como o cadastro cria (colunas de auth.js) e como o
//      "adicionar CNPJ" cria (userCompanies.js) nasce com as tres chaves false
//      e crediario_enabled true
//   2. a migration roda de novo sem erro e NAO mexe em empresa existente:
//      quem ja salvou caixa_enabled=true continua com true
//   3. os INSERTs de cadastro do varejo nao gravam pdv_settings (se um dia
//      gravarem, tem que ser desligado — e este teste obriga a olhar)
// Tudo dentro de UMA transacao revertida no afterAll.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '399_pdv_settings_caixa_desligado_por_padrao.sql'),
  'utf8'
);

let pool;
let client;
const userId = uuid();

const lerSettings = async (id) => {
  const { rows } = await client.query('SELECT pdv_settings FROM companies WHERE id = $1', [id]);
  return rows[0].pdv_settings;
};

describe('pdv_settings — padrao da conta nova (migration 399), codigo', () => {
  test('3. os INSERTs de cadastro do varejo nao gravam pdv_settings (o default da coluna manda)', () => {
    for (const arquivo of ['auth.js', 'userCompanies.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', arquivo), 'utf8');
      const inserts = src.match(/INSERT INTO companies \([^`]*?\)\s*VALUES/g) || [];
      expect(inserts.length).toBeGreaterThan(0);
      for (const i of inserts) expect(i).not.toMatch(/pdv_settings/);
    }
  });

  test('3b. a migration troca so o default da coluna: nenhum UPDATE/DELETE de linha', () => {
    const sql = MIGRATION.replace(/--.*$/gm, '');
    expect(sql).toMatch(/SET DEFAULT/);
    expect(sql).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bINSERT\b/i);
  });
});

describe('pdv_settings — padrao da conta nova (migration 399), Postgres real', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture pdv_settings 399')`,
      [userId, `fixture-${userId}@example.test`]
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) await pool.end();
  });

  test('1a. empresa criada pelo cadastro (colunas de auth.js) nasce com as tres chaves desligadas', async () => {
    const { rows: [c] } = await client.query(
      `INSERT INTO companies (owner_id, legal_name, trade_name, plan, onboarding_step, trial_ends_at, access_code_used, cnpj, phone, vertical, vertical_active, federation_id, tax_regime)
       VALUES ($1, 'Fixture Cadastro', 'Fixture Cadastro', 'essencial', 'cnpj', NOW() + interval '7 days', NULL, NULL, NULL, NULL, NULL, NULL, 'simples_nacional'::tax_regime)
       RETURNING id`,
      [userId]
    );
    const s = await lerSettings(c.id);
    expect(s.caixa_enabled).toBe(false);
    expect(s.require_seller).toBe(false);
    expect(s.require_customer).toBe(false);
    expect(s.crediario_enabled).toBe(true);
  });

  test('1b. empresa criada pelo "adicionar CNPJ" (userCompanies.js) nasce igual', async () => {
    const { rows: [c] } = await client.query(
      `INSERT INTO companies (owner_id, legal_name, trade_name, is_primary, is_active, billing_status, onboarding_step)
       VALUES ($1, 'Fixture Filial', 'Fixture Filial', false, true, 'active', 'completed')
       RETURNING id`,
      [userId]
    );
    expect(await lerSettings(c.id)).toMatchObject({
      caixa_enabled: false, require_seller: false, require_customer: false, crediario_enabled: true,
    });
  });

  test('2. a migration roda de novo e nao mexe em empresa existente (quem salvou caixa_enabled=true continua com true)', async () => {
    const { rows: [c] } = await client.query(
      `INSERT INTO companies (owner_id, legal_name, pdv_settings)
       VALUES ($1, 'Fixture Salvou Caixa', '{"caixa_enabled": true, "require_seller": true, "require_customer": true}'::jsonb)
       RETURNING id`,
      [userId]
    );
    await client.query(MIGRATION);
    await client.query(MIGRATION); // idempotente
    expect(await lerSettings(c.id)).toEqual({ caixa_enabled: true, require_seller: true, require_customer: true });
  });
});
