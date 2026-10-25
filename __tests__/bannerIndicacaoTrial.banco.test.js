// ============================================================
// AURA. Banner de indicacao no teste: so depois da 1a venda -- Postgres real
//
// Item 15 (24/10/2026, aprovado pelo Caio): o convite de indicacao so sai para
// empresa com pelo menos 1 venda NAO cancelada. Aqui o SQL de buscarFatos e a
// volta inteira do job rodam no banco de verdade (o db do app e desviado para
// a mesma conexao), dentro de UMA transacao revertida no afterAll:
//   1. empresa sem nenhuma venda nao recebe
//   2. empresa so com venda cancelada nao recebe
//   3. empresa com 1 venda valida recebe UMA vez (a segunda volta nao repete)
//   4. quem ja tem o banner (mesma dedupe_key) nao ganha outro
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let db;

const semVenda = uuid();
const soCancelada = uuid();
const comVenda = uuid();
const jaTinhaBanner = uuid();
const todas = [semVenda, soCancelada, comVenda, jaTinhaBanner];

async function criarEmpresa(id, nome) {
  const dono = uuid();
  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name, email_verified)
     VALUES ($1, $2, 'x', $3, true)`,
    [dono, `dono-${dono}@example.test`, nome]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, trial_ends_at)
     VALUES ($1, $2, $3, $3, NOW() + interval '5 days')`,
    [id, dono, nome]
  );
}

const venda = (empresa, status) => client.query(
  `INSERT INTO sales (id, company_id, total_amount, status) VALUES ($1, $2, 50, $3)`,
  [uuid(), empresa, status]
);

async function bannersDe(empresa) {
  const { rows } = await client.query(
    `SELECT title, body, cta_label, cta_route FROM app_notifications WHERE dedupe_key = $1`,
    ['indicacao-trial:' + empresa]
  );
  return rows;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));

  await criarEmpresa(semVenda, 'Sem Venda Fixture');
  await criarEmpresa(soCancelada, 'So Cancelada Fixture');
  await criarEmpresa(comVenda, 'Com Venda Fixture');
  await criarEmpresa(jaTinhaBanner, 'Ja Tinha Banner Fixture');

  await venda(soCancelada, 'cancelled');
  await venda(soCancelada, 'cancelled');
  await venda(comVenda, 'cancelled');
  await venda(comVenda, 'completed');
  await venda(jaTinhaBanner, 'completed');
  await client.query(
    `INSERT INTO app_notifications (type, title, target_company_id, dedupe_key)
     VALUES ('banner', 'Indique um lojista e ganhe seu mes gratis', $1, $2)`,
    [jaTinhaBanner, 'indicacao-trial:' + jaTinhaBanner]
  );
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('banner de indicacao so depois da 1a venda (Postgres real)', () => {
  test('buscarFatos: tem_venda ignora venda cancelada', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    const fatos = await svc.buscarFatos(client, new Date());
    const por = Object.fromEntries(fatos.filter((f) => todas.includes(f.company_id)).map((f) => [f.company_id, f]));
    expect(por[semVenda].tem_venda).toBe(false);
    expect(por[soCancelada].tem_venda).toBe(false);
    expect(por[comVenda].tem_venda).toBe(true);
    expect(por[jaTinhaBanner].ja_tem_banner).toBe(true);
  });

  test('a volta cria o banner so para quem tem venda valida, e uma vez so', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    const notifications = require('../src/services/appNotifications');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const agora = Date.now();

    await svc.tickBannerIndicacaoTrial({ db: client, notifications, now: agora, env: {} });
    await svc.tickBannerIndicacaoTrial({ db: client, notifications, now: agora + 3600000, env: {} });
    log.mockRestore();

    expect(await bannersDe(semVenda)).toHaveLength(0);
    expect(await bannersDe(soCancelada)).toHaveLength(0);

    const novo = await bannersDe(comVenda);
    expect(novo).toHaveLength(1);
    expect(novo[0]).toMatchObject({
      title: 'Conhece outro lojista que ia gostar da Aura?',
      body: 'Indique e ganhe um mês grátis quando ele assinar.',
      cta_label: 'Gerar meu código',
      cta_route: '/configuracoes?foco=indicacao',
    });

    // Quem ja tinha o banner antigo continua com ele, sem um segundo.
    const antigo = await bannersDe(jaTinhaBanner);
    expect(antigo).toHaveLength(1);
    expect(antigo[0].title).toBe('Indique um lojista e ganhe seu mes gratis');
  });
});
