// ============================================================
// AURA. Banner de indicação a cada 14 dias -- Postgres real
//
// 08/11/2026 (card b-mk-30): toda conta real, fora as exclusões, ganha um
// banner novo quando o último banner de indicação dela foi criado há 14 dias
// ou mais, mesmo que o anterior tenha sido lido ou dispensado. O texto segue
// a fase (BLACK50 só com cupom; fixo depois de 30/11). Vista e clique vão
// para audit_log; os contadores juntam tudo.
//
// O SQL e a volta inteira do job rodam no banco de verdade (o db do app é
// desviado para a mesma conexão), dentro de UMA transação revertida no
// afterAll. Dentro da transação NOW() é fixo: created_at de tudo o que o
// job cria é o instante `agora` lido no início. As voltas seguintes usam
// agora + N dias; os banners "antigos" nascem com created_at no passado.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const DIA = 24 * 3600 * 1000;

let pool;
let client;
let agora; // NOW() da transação

const nova = uuid();
const dispensou14 = uuid();
const recente13 = uuid();
const pagante = uuid();
const studio = uuid();
const karate = uuid();
const odonto = uuid();
const food = uuid();
const sandbox = uuid();
const interna = uuid();
const inativa = uuid();
const filial = uuid();
const donos = {};

async function criarEmpresa(id, nome, extra = {}) {
  const dono = uuid();
  donos[id] = dono;
  const email = extra.ownerEmail || `dono-${dono}@example.test`;
  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name, email_verified)
     VALUES ($1, $2, 'x', $3, true)`,
    [dono, email, nome]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, trial_ends_at,
                            billing_status, vertical_active, is_sandbox, is_active)
     VALUES ($1, $2, $3, $3, '2027-01-31T00:00:00Z', $4, $5, $6, $7)`,
    [id, dono, nome, extra.billingStatus || 'trial', extra.vertical || null, extra.sandbox === true, extra.ativa !== false]
  );
}

async function bannerAntigo(empresa, { chave, criadoEm }) {
  const { rows } = await client.query(
    `INSERT INTO app_notifications (type, title, target_company_id, dedupe_key, is_active, expires_at, created_at)
     VALUES ('banner', 'Black Friday: você indica, vocês dois ganham.', $1, $2, true, $3, $4)
     RETURNING id`,
    [empresa, chave, new Date(agora.getTime() + 60 * DIA), criadoEm]
  );
  return rows[0].id;
}

async function bannersDe(empresa) {
  const { rows } = await client.query(
    `SELECT id, title, body, cta_label, cta_route, dedupe_key, is_active, expires_at
       FROM app_notifications
      WHERE target_company_id = $1 AND dedupe_key LIKE 'indicacao%'
      ORDER BY created_at, dedupe_key`,
    [empresa]
  );
  return rows;
}

const ciclos = async (empresa) => (await bannersDe(empresa)).filter((b) => b.dedupe_key.startsWith('indicacao:'));

const volta = async (instante) => {
  const svc = require('../src/services/bannerIndicacaoTrial');
  const notifications = require('../src/services/appNotifications');
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const r = await svc.tickBannerIndicacaoTrial({ db: client, notifications, now: instante.getTime(), env: {} });
    // A mesma volta repetida uma hora depois (reinício): não duplica.
    await svc.tickBannerIndicacaoTrial({ db: client, notifications, now: instante.getTime() + 3600000, env: {} });
    return r;
  } finally {
    log.mockRestore();
  }
};

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));

  const { rows: [r] } = await client.query('SELECT NOW() AS agora');
  agora = new Date(r.agora);

  // BLACK50 com 10 de 10 usos: a queda para o texto sem BLACK50.
  await client.query(`DELETE FROM access_codes WHERE code = 'BLACK50'`);
  await client.query(
    `INSERT INTO access_codes (code, type, plan, discount_pct, max_uses, uses, is_active, expires_at)
     VALUES ('BLACK50', 'promo', 'negocio', 50, 10, 10, true, '2026-12-01T02:59:59Z')`
  );

  await criarEmpresa(nova, 'Nova Fixture');
  await criarEmpresa(dispensou14, 'Dispensou Fixture');
  await criarEmpresa(recente13, 'Recente Fixture');
  await criarEmpresa(pagante, 'Pagante Fixture', { billingStatus: 'active' });
  await criarEmpresa(studio, 'Studio Fixture', { vertical: 'studio' });
  await criarEmpresa(karate, 'Karate Fixture', { vertical: 'karate_dojo' });
  await criarEmpresa(odonto, 'Odonto Fixture', { vertical: 'odonto' });
  await criarEmpresa(food, 'Food Fixture', { vertical: 'food' });
  await criarEmpresa(sandbox, 'Sandbox Fixture', { sandbox: true });
  await criarEmpresa(interna, 'Interna Fixture', { ownerEmail: `time-${uuid()}@getaura.com.br` });
  await criarEmpresa(inativa, 'Inativa Fixture', { ativa: false });
  await criarEmpresa(filial, 'Filial Fixture');
  await client.query('UPDATE companies SET billing_owner_company_id = $1 WHERE id = $2', [nova, filial]);

  // Banner da Black Friday criado há 14 dias e DISPENSADO: não bloqueia.
  const idDispensado = await bannerAntigo(dispensou14, {
    chave: 'indicacao-bf-2026:' + dispensou14, criadoEm: new Date(agora.getTime() - 14 * DIA),
  });
  await client.query(
    'INSERT INTO notification_reads (notification_id, company_id) VALUES ($1, $2)',
    [idDispensado, dispensou14]
  );
  // Banner criado há 13 dias, ainda no ar: espera o ciclo.
  await bannerAntigo(recente13, {
    chave: 'indicacao-bf-2026:' + recente13, criadoEm: new Date(agora.getTime() - 13 * DIA),
  });
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('banner de indicação a cada 14 dias (Postgres real)', () => {
  test('buscarFatos lê o último banner de indicação de cada empresa', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    const fatos = await svc.buscarFatos(client);
    const por = Object.fromEntries(fatos.map((f) => [f.company_id, f]));
    expect(por[nova].ultimo_banner_em).toBeNull();
    expect(new Date(por[dispensou14].ultimo_banner_em).getTime()).toBe(agora.getTime() - 14 * DIA);
    expect(por[filial].paga_por_outra).toBe(true);
    expect(por[inativa].empresa_inativa).toBe(true);
    expect(por[karate].shell).toBe('karate_dojo');
  });

  test('primeira volta: cria para contas reais, respeita exclusões e o ciclo', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    await volta(agora);

    for (const id of [nova, dispensou14, pagante, studio]) {
      expect(await ciclos(id)).toHaveLength(1);
    }
    for (const id of [recente13, karate, odonto, food, sandbox, interna, inativa, filial]) {
      expect(await ciclos(id)).toHaveLength(0);
    }

    const [b] = await ciclos(nova);
    expect(b.dedupe_key).toBe(svc.dedupeKeyDoCiclo(nova, agora));
    expect(b.is_active).toBe(true);
    expect(new Date(b.expires_at).getTime()).toBe(agora.getTime() + 14 * DIA);
    // BLACK50 esgotado (ou a Black Friday já passou): texto sem BLACK50.
    expect(b).toMatchObject({
      title: svc.BANNER.title, body: svc.BANNER.body,
      cta_label: 'Gerar meu código', cta_route: '/configuracoes?foco=indicacao',
    });
  });

  test('o banner anterior ainda ativo foi desligado; o de 13 dias, intocado', async () => {
    const antigo = (await bannersDe(dispensou14)).find((x) => x.dedupe_key.startsWith('indicacao-bf-2026:'));
    expect(antigo.is_active).toBe(false);
    const [doRecente] = await bannersDe(recente13);
    expect(doRecente.is_active).toBe(true);
  });

  test('dispensar o banner do ciclo não bloqueia o próximo; 13 dias depois ainda não', async () => {
    const [atual] = await ciclos(nova);
    await client.query(
      'INSERT INTO notification_reads (notification_id, company_id) VALUES ($1, $2)',
      [atual.id, nova]
    );

    await volta(new Date(agora.getTime() + 13 * DIA));
    expect(await ciclos(nova)).toHaveLength(1);
    // O banner de 13 dias atrás completou o ciclo nesta volta.
    expect(await ciclos(recente13)).toHaveLength(1);

    await volta(new Date(agora.getTime() + 14 * DIA));
    const depois = await ciclos(nova);
    expect(depois).toHaveLength(2);
    const anterior = depois.find((x) => x.id === atual.id);
    const proximo = depois.find((x) => x.id !== atual.id);
    expect(anterior.is_active).toBe(false);
    expect(proximo.is_active).toBe(true);
    expect(proximo.dedupe_key).toBe(require('../src/services/bannerIndicacaoTrial')
      .dedupeKeyDoCiclo(nova, new Date(agora.getTime() + 14 * DIA)));
  });

  test('o sininho reescreve o texto pela fase: sem BLACK50 com o cupom esgotado e em 01/12', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    svc._resetCacheForTests();
    const linhas = (await bannersDe(dispensou14))
      .map((x) => ({ id: x.id, title: 'velho', body: 'velho', dedupe_key: x.dedupe_key }));
    const NA_BF = Date.parse('2026-11-20T12:00:00Z');

    const esgotado = await svc.textoDosBannersNaLeitura(client, linhas, { now: NA_BF });
    expect(esgotado[0]).toMatchObject({ title: svc.BANNER.title, fase: 'sem_black50', campanha: 'indicacao' });

    await client.query(`UPDATE access_codes SET uses = 3 WHERE code = 'BLACK50'`);
    svc._resetCacheForTests();
    const comCupom = await svc.textoDosBannersNaLeitura(client, linhas, { now: NA_BF });
    expect(comCupom[0]).toMatchObject({ title: svc.BANNER_BLACK_FRIDAY.title, fase: 'black' });

    const dez = await svc.textoDosBannersNaLeitura(client, linhas, { now: Date.parse('2026-12-01T03:00:00Z') });
    expect(dez[0]).toMatchObject({ title: svc.BANNER.title, fase: 'fixo' });

    await client.query(`UPDATE access_codes SET uses = 10 WHERE code = 'BLACK50'`);
    svc._resetCacheForTests();
  });

  test('vista e clique vão para audit_log uma vez por usuário; contadores e indicação por envio', async () => {
    const svc = require('../src/services/bannerIndicacaoTrial');
    const [b] = await ciclos(pagante);
    const base = { companyId: pagante, userId: donos[pagante], notificationId: b.id };

    expect(await svc.registrarEvento(client, { ...base, evento: 'vista' })).toBe(true);
    expect(await svc.registrarEvento(client, { ...base, evento: 'vista' })).toBe(false);
    expect(await svc.registrarEvento(client, { ...base, evento: 'clique' })).toBe(true);
    // Banner de outra empresa não conta.
    expect(await svc.registrarEvento(client, { ...base, companyId: studio, evento: 'vista' })).toBe(false);

    const { rows: [linha] } = await client.query(
      `SELECT metadata FROM audit_log WHERE company_id = $1 AND action = 'indicacao.banner_clique'`,
      [pagante]
    );
    expect(linha.metadata).toMatchObject({ notification_id: b.id, ciclo: b.dedupe_key });

    // Cadastro por /r/CODIGO depois do clique: indicação atribuída ao banner.
    await client.query(
      `INSERT INTO referrals (referrer_id, referred_email, code, status, created_at)
       VALUES ($1, 'indicado@example.test', 'REF-TESTE1', 'completed', NOW() + INTERVAL '1 second')`,
      [donos[pagante]]
    );
    // Cadastro de quem nunca viu o banner: conta no total, não no banner.
    await client.query(
      `INSERT INTO referrals (referrer_id, referred_email, code, status, created_at)
       VALUES ($1, 'outro@example.test', 'REF-TESTE2', 'completed', NOW() + INTERVAL '1 second')`,
      [donos[studio]]
    );

    const c = await svc.contadores(client, {
      desde: new Date(agora.getTime() - DIA).toISOString(),
      ate: new Date(agora.getTime() + 30 * DIA).toISOString(),
    });
    expect(c.vistas.total).toBeGreaterThanOrEqual(1);
    expect(c.cliques_gerar_codigo.total).toBeGreaterThanOrEqual(1);
    expect(c.indicacoes.cadastros_por_link).toBeGreaterThanOrEqual(2);
    expect(c.indicacoes.depois_do_clique_no_banner).toBe(1);
    expect(c.indicacoes.depois_de_ver_o_banner).toBe(1);
    expect(c.black50).toMatchObject({ usos: 10, limite: 10, esgotado: true });
    expect(c.banners.criados).toBeGreaterThanOrEqual(5);
  });
});
