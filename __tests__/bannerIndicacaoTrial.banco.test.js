// ============================================================
// AURA. Banner de indicacao -- Postgres real
//
// Duas regras, escolhidas pelo relogio (emBlackFridayDaIndicacao):
//   - Depois do fim da campanha (30/11/2026): regra do teste (item 15,
//     24/10/2026): so empresa em teste e com pelo menos 1 venda NAO cancelada.
//   - Durante a Black Friday (29/10/2026, decisao do Caio: "mostre para todos
//     com conta"): toda empresa com login, em qualquer situacao de cobranca,
//     fora as exclusoes tecnicas, os shells Karate/Odonto/Food e quem ja
//     fechou o banner antigo.
// O SQL de buscarFatos e a volta inteira do job rodam no banco de verdade (o db
// do app e desviado para a mesma conexao), dentro de UMA transacao revertida
// no afterAll. O instante da volta e sempre passado explicitamente.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const NA_CAMPANHA = new Date('2026-11-02T12:00:00.000Z');
const DEPOIS_DA_CAMPANHA = new Date('2026-12-05T12:00:00.000Z');

let pool;
let client;
let db;

// Regra do teste (depois da campanha)
const semVenda = uuid();
const soCancelada = uuid();
const comVenda = uuid();
const jaTinhaBanner = uuid();
const todasDoTeste = [semVenda, soCancelada, comVenda, jaTinhaBanner];

// Campanha
const testeVencidoSemVenda = uuid();
const pagante = uuid();
const emAtraso = uuid();
const studio = uuid();
const karate = uuid();
const odonto = uuid();
const sandbox = uuid();
const interna = uuid();
const inativa = uuid();
const fechouAntigo = uuid();
const antigoNoAr = uuid();
const antigoVencidoNaoLido = uuid();
const todasDaCampanha = [
  testeVencidoSemVenda, pagante, emAtraso, studio, karate, odonto, sandbox,
  interna, inativa, fechouAntigo, antigoNoAr, antigoVencidoNaoLido,
];

async function criarEmpresa(id, nome, extra = {}) {
  const dono = uuid();
  const email = extra.ownerEmail || `dono-${dono}@example.test`;
  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name, email_verified)
     VALUES ($1, $2, 'x', $3, $4)`,
    [dono, email, nome, extra.emailVerificado !== false]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, trial_ends_at,
                            billing_status, vertical_active, is_sandbox, is_active)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)`,
    [
      id, dono, nome,
      extra.trialEndsAt === undefined ? '2027-01-31T00:00:00Z' : extra.trialEndsAt,
      extra.billingStatus || 'trial',
      extra.vertical || null,
      extra.sandbox === true,
      extra.ativa !== false,
    ]
  );
}

const venda = (empresa, status) => client.query(
  `INSERT INTO sales (id, company_id, total_amount, status) VALUES ($1, $2, 50, $3)`,
  [uuid(), empresa, status]
);

async function bannerAntigo(empresa, { ativo = true, expira = '2027-01-31T00:00:00Z' } = {}) {
  const { rows } = await client.query(
    `INSERT INTO app_notifications (type, title, target_company_id, dedupe_key, is_active, expires_at)
     VALUES ('banner', 'Indique um lojista e ganhe seu mes gratis', $1, $2, $3, $4)
     RETURNING id`,
    [empresa, 'indicacao-trial:' + empresa, ativo, expira]
  );
  return rows[0].id;
}

async function bannersDe(empresa, prefixo) {
  const { rows } = await client.query(
    `SELECT title, body, cta_label, cta_route, expires_at FROM app_notifications WHERE dedupe_key = $1`,
    [prefixo + empresa]
  );
  return rows;
}

const volta = async (agora) => {
  const svc = require('../src/services/bannerIndicacaoTrial');
  const notifications = require('../src/services/appNotifications');
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await svc.tickBannerIndicacaoTrial({ db: client, notifications, now: agora.getTime(), env: {} });
    await svc.tickBannerIndicacaoTrial({ db: client, notifications, now: agora.getTime() + 3600000, env: {} });
  } finally {
    log.mockRestore();
  }
};

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));

  // ── regra do teste ──
  await criarEmpresa(semVenda, 'Sem Venda Fixture');
  await criarEmpresa(soCancelada, 'So Cancelada Fixture');
  await criarEmpresa(comVenda, 'Com Venda Fixture');
  await criarEmpresa(jaTinhaBanner, 'Ja Tinha Banner Fixture');
  await venda(soCancelada, 'cancelled');
  await venda(soCancelada, 'cancelled');
  await venda(comVenda, 'cancelled');
  await venda(comVenda, 'completed');
  await venda(jaTinhaBanner, 'completed');
  await bannerAntigo(jaTinhaBanner);

  // ── campanha ──
  await criarEmpresa(testeVencidoSemVenda, 'Teste Vencido Fixture', { trialEndsAt: '2026-10-01T00:00:00Z', emailVerificado: false });
  await criarEmpresa(pagante, 'Pagante Fixture', { billingStatus: 'active', trialEndsAt: null });
  await criarEmpresa(emAtraso, 'Em Atraso Fixture', { billingStatus: 'overdue', trialEndsAt: null });
  await criarEmpresa(studio, 'Studio Fixture', { vertical: 'studio' });
  await criarEmpresa(karate, 'Karate Fixture', { vertical: 'karate_dojo' });
  await criarEmpresa(odonto, 'Odonto Fixture', { vertical: 'odonto' });
  await criarEmpresa(sandbox, 'Sandbox Fixture', { sandbox: true });
  await criarEmpresa(interna, 'Interna Fixture', { ownerEmail: `time-${uuid()}@getaura.com.br` });
  await criarEmpresa(inativa, 'Inativa Fixture', { ativa: false });
  await criarEmpresa(fechouAntigo, 'Fechou Antigo Fixture');
  await criarEmpresa(antigoNoAr, 'Antigo No Ar Fixture');
  await criarEmpresa(antigoVencidoNaoLido, 'Antigo Vencido Fixture');

  const idFechado = await bannerAntigo(fechouAntigo, { ativo: true, expira: '2026-10-20T00:00:00Z' });
  await client.query(
    `INSERT INTO notification_reads (notification_id, company_id) VALUES ($1, $2)`,
    [idFechado, fechouAntigo]
  );
  await bannerAntigo(antigoNoAr, { ativo: true, expira: '2027-01-31T00:00:00Z' });
  await bannerAntigo(antigoVencidoNaoLido, { ativo: true, expira: '2026-10-20T00:00:00Z' });
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('banner de indicacao depois da campanha: so depois da 1a venda (Postgres real)', () => {
  test('buscarFatos: tem_venda ignora venda cancelada', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    const fatos = await svc.buscarFatos(client, DEPOIS_DA_CAMPANHA);
    const por = Object.fromEntries(fatos.filter((f) => todasDoTeste.includes(f.company_id)).map((f) => [f.company_id, f]));
    expect(por[semVenda].tem_venda).toBe(false);
    expect(por[soCancelada].tem_venda).toBe(false);
    expect(por[comVenda].tem_venda).toBe(true);
    expect(por[jaTinhaBanner].ja_tem_banner).toBe(true);
  });

  test('a volta cria o banner so para quem tem venda valida, e uma vez so', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    await volta(DEPOIS_DA_CAMPANHA);

    expect(await bannersDe(semVenda, 'indicacao-trial:')).toHaveLength(0);
    expect(await bannersDe(soCancelada, 'indicacao-trial:')).toHaveLength(0);

    const novo = await bannersDe(comVenda, 'indicacao-trial:');
    expect(novo).toHaveLength(1);
    const texto = svc.bannerVigente(DEPOIS_DA_CAMPANHA);
    expect(novo[0]).toMatchObject({
      title: texto.title,
      body: texto.body,
      cta_label: 'Gerar meu código',
      cta_route: '/configuracoes?foco=indicacao',
    });
    // Fora da campanha nada nasce com a chave da campanha.
    expect(await bannersDe(comVenda, 'indicacao-bf-2026:')).toHaveLength(0);

    // Quem ja tinha o banner antigo continua com ele, sem um segundo.
    const antigo = await bannersDe(jaTinhaBanner, 'indicacao-trial:');
    expect(antigo).toHaveLength(1);
    expect(antigo[0].title).toBe('Indique um lojista e ganhe seu mes gratis');
  });
});

describe('banner de indicacao na Black Friday: todos com conta (Postgres real)', () => {
  test('buscarFatos: banner antigo fechado, no ar e vencido sao lidos separados', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    const fatos = await svc.buscarFatos(client, NA_CAMPANHA);
    const por = Object.fromEntries(fatos.filter((f) => todasDaCampanha.includes(f.company_id)).map((f) => [f.company_id, f]));
    expect(por[fechouAntigo].fechou_banner_antigo).toBe(true);
    expect(por[antigoNoAr].fechou_banner_antigo).toBe(false);
    expect(por[antigoNoAr].banner_antigo_no_ar).toBe(true);
    expect(por[antigoVencidoNaoLido].banner_antigo_no_ar).toBe(false);
    expect(por[antigoVencidoNaoLido].fechou_banner_antigo).toBe(false);
    expect(por[inativa].empresa_inativa).toBe(true);
    expect(por[sandbox].is_sandbox).toBe(true);
    expect(por[karate].shell).toBe('karate_dojo');
    expect(por[studio].shell).toBe('studio');
  });

  test('a volta cria o banner da campanha para todos, menos exclusoes tecnicas, shells de fora e quem fechou', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    await volta(NA_CAMPANHA);
    const tem = async (id) => (await bannersDe(id, 'indicacao-bf-2026:')).length;

    // Recebem: teste vencido sem venda e sem e-mail verificado, pagante, em
    // atraso, Studio, quem tinha so o banner antigo ja vencido e quem nunca
    // teve venda.
    for (const id of [testeVencidoSemVenda, pagante, emAtraso, studio, antigoVencidoNaoLido, semVenda]) {
      expect(await tem(id)).toBe(1);
    }
    // Ficam de fora.
    for (const id of [karate, odonto, sandbox, interna, inativa, fechouAntigo, antigoNoAr]) {
      expect(await tem(id)).toBe(0);
    }

    const b = (await bannersDe(pagante, 'indicacao-bf-2026:'))[0];
    const texto = svc.bannerVigente(NA_CAMPANHA);
    expect(b).toMatchObject({
      title: texto.title,
      body: texto.body,
      cta_label: 'Gerar meu código',
      cta_route: '/configuracoes?foco=indicacao',
    });
    expect(new Date(b.expires_at).toISOString()).toBe(svc.FIM_BLACK_FRIDAY_INDICACAO.toISOString());

    // O banner antigo de quem o tem no ar nao foi tocado nem duplicado.
    expect(await bannersDe(antigoNoAr, 'indicacao-trial:')).toHaveLength(1);
  });
});
