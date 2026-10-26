// ============================================================
// AURA. — Contas pendentes (tq-113, 26/10/2026) — Postgres real
//
// Decisão do Caio (opção B): a conta continua nascendo antes da confirmação
// do e-mail; quem não confirma sai das listas e, depois de 7 dias, tem a
// empresa desativada (nunca apagada). Confirmar o e-mail depois reabre.
// O que este arquivo cobre, com o SQL de verdade:
//   1. o job desativa SÓ a pendente com mais de 7 dias, sem venda, sem
//      pagamento, sem assinatura, fora Karatê/sandbox/interna e única
//      empresa do dono;
//   2. o lead: criado a partir do usuário quando falta; o que já existe
//      ganha o motivo; audit_log por empresa;
//   3. rodar de novo não faz nada; kill switch e dry-run não desativam;
//   4. confirmar o e-mail (código de 6 dígitos) reabre a desativada pelo
//      job, limpa o motivo do lead e grava o audit_log; empresa desativada
//      à mão nunca é reaberta;
//   5. a pendente fica fora do universo do painel e da lista de clientes.
//
// Mesmo padrão de corrigirEmail.banco.test.js: tudo numa transação revertida
// no afterAll; BEGIN/COMMIT/ROLLBACK das rotinas viram SAVEPOINT.
// ============================================================
'use strict';

// As boas-vindas (fire-and-forget) não fazem parte deste teste.
jest.mock('../src/services/relacionamento', () => ({ aoConfirmarEmail: jest.fn(async () => null) }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';
const SECRET = 'aura-test-secret-2026';

let pool;
let client;
let db;
let limpeza;

const tag = uuid().slice(0, 8);
const AGORA = new Date();
const DIAS = (n) => new Date(AGORA.getTime() - n * 86400000).toISOString();

// Cada caso: um dono e (quase sempre) uma empresa.
function caso(nome, extra = {}) {
  return {
    nome,
    user: uuid(),
    company: uuid(),
    email: `${nome}-${tag}@exemplo.com.br`,
    verificado: false,
    staff: false,
    criadoHa: 10,
    empresa: {},
    ...extra,
  };
}
const C = {
  alvo: caso('alvo'),                                         // desativa (lead nasce aqui)
  comLead: caso('comlead'),                                   // desativa (lead já existe)
  recente: caso('recente', { criadoHa: 3 }),                  // menos de 7 dias
  confirmado: caso('confirmado', { verificado: true }),       // não é pendente
  comVenda: caso('comvenda'),
  comCobranca: caso('comcobranca'),
  comEvento: caso('comevento'),
  comAssinatura: caso('comassinatura', { empresa: { asaas_subscription_id: 'sub_x' } }),
  ativa: caso('ativa', { empresa: { billing_status: 'active' } }),
  sandbox: caso('sandbox', { empresa: { is_sandbox: true } }),
  staff: caso('staff', { staff: true }),
  interna: caso('interna', { email: `interna-${tag}@getaura.com.br` }),
  dojo: caso('dojo', { empresa: { vertical: 'karate_dojo' } }),
  duasLojas: caso('duaslojas'),
  manual: caso('manual'),                                     // desativada à mão: nunca reabre
};
const SEGUNDA_LOJA = uuid();

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
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
  limpeza = require('../src/services/limpezaPendentes');

  for (const c of Object.values(C)) {
    await client.query(
      `INSERT INTO users (id, email, password_hash, full_name, email_verified, is_staff, phone, created_at)
       VALUES ($1, $2, 'x', $3, $4, $5, '(11) 98765-4321', $6)`,
      [c.user, c.email, `Pessoa ${c.nome}`, c.verificado, c.staff, DIAS(c.criadoHa)]
    );
    const e = c.empresa;
    await client.query(
      `INSERT INTO companies (id, owner_id, legal_name, email, billing_status, is_sandbox, vertical,
                              asaas_subscription_id, signup_origin, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [c.company, c.user, `Loja ${c.nome}`, c.email, e.billing_status || 'trial', e.is_sandbox === true,
        e.vertical || null, e.asaas_subscription_id || null,
        JSON.stringify({ utm_source: 'instagram' }), DIAS(c.criadoHa)]
    );
  }
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, email, created_at) VALUES ($1, $2, 'Segunda loja', $3, $4)`,
    [SEGUNDA_LOJA, C.duasLojas.user, C.duasLojas.email, DIAS(9)]
  );
  await client.query('INSERT INTO sales (company_id, total_amount) VALUES ($1, 10)', [C.comVenda.company]);
  await client.query(
    `INSERT INTO assinatura_cobrancas (asaas_payment_id, company_id, status, due_date)
     VALUES ($1, $2, 'PENDING', CURRENT_DATE)`,
    [`pay_${tag}`, C.comCobranca.company]
  );
  await client.query(
    `INSERT INTO webhook_logs (company_id, provider, event, payload) VALUES ($1, 'asaas', 'PAYMENT_CREATED', '{}')`,
    [C.comEvento.company]
  );
  await client.query(
    `INSERT INTO signup_leads (token, email, nome, etapa, convertido_em, user_id, company_id)
     VALUES ($1, $2, 'Já era lead', 3, NOW(), $3, $4)`,
    [`${tag}`.padEnd(48, '0'), C.comLead.email, C.comLead.user, C.comLead.company]
  );
  // Desativada à mão pela equipe (sem desativada_por): a confirmação não reabre.
  await client.query('UPDATE companies SET is_active = false WHERE id = $1', [C.manual.company]);
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

async function empresa(id) {
  const { rows } = await client.query(
    'SELECT is_active, desativada_por, desativada_em FROM companies WHERE id = $1', [id]
  );
  return rows[0];
}
async function auditoria(companyId, action) {
  const { rows } = await client.query(
    'SELECT user_id, action, metadata FROM audit_log WHERE company_id = $1 AND action = $2', [companyId, action]
  );
  return rows;
}
async function lead(email) {
  const { rows } = await client.query('SELECT * FROM signup_leads WHERE email = $1', [email]);
  return rows[0];
}

describe('antes da limpeza: a definição única no Postgres', () => {
  // O esquema do CI não tem todas as colunas das consultas do painel e da
  // lista de clientes (billing_cycle e outras vêm de fora de migrations/);
  // as rotas são cobertas em tests/routes/adminSemPendentes.test.js. Aqui o
  // fragmento roda no banco de verdade.
  test('sqlContaPendente / semPendente / usuarioPendente / companyIdSemPendente', async () => {
    const cp = require('../src/utils/contaPendente');
    const todas = Object.values(C).map((c) => c.company);
    const { rows } = await client.query(
      `SELECT c.id FROM companies c WHERE c.id = ANY($1::uuid[]) AND ${cp.sqlContaPendente('c')}`, [todas]
    );
    const pendentes = rows.map((r) => r.id).sort();
    const esperadas = [C.alvo, C.comLead, C.recente, C.comVenda, C.comCobranca, C.comEvento,
      C.comAssinatura, C.ativa, C.dojo, C.duasLojas, C.manual].map((c) => c.company).sort();
    // fora: confirmado, sandbox, staff e interna
    expect(pendentes).toEqual(esperadas);

    const { rows: fora } = await client.query(
      `SELECT id FROM companies WHERE id = ANY($1::uuid[]) AND ${cp.semPendente()}`, [todas]
    );
    expect(fora.map((r) => r.id).sort())
      .toEqual([C.confirmado, C.sandbox, C.staff, C.interna].map((c) => c.company).sort());

    const { rows: u } = await client.query(
      `SELECT u.id FROM users u WHERE u.id = ANY($1::uuid[]) AND ${cp.usuarioPendente('u')}`,
      [[C.alvo.user, C.confirmado.user, C.staff.user]]
    );
    expect(u.map((r) => r.id)).toEqual([C.alvo.user]);

    const { rows: v } = await client.query(
      `SELECT COUNT(*)::int AS n FROM sales s WHERE s.company_id = ANY($1::uuid[]) AND ${cp.companyIdSemPendente('s.company_id')}`,
      [[C.comVenda.company]]
    );
    expect(v[0].n).toBe(0);
  });
});

describe('job de limpeza', () => {
  test('kill switch e dry-run não desativam ninguém', async () => {
    const off = await limpeza.rodarLimpeza({ pool: db, agora: AGORA, env: { LIMPEZA_PENDENTES_ENABLED: 'false' } });
    expect(off).toMatchObject({ ligado: false, desativadas: 0 });
    const seco = await limpeza.rodarLimpeza({ pool: db, agora: AGORA, env: { LIMPEZA_PENDENTES_DRY_RUN: 'true' } });
    expect(seco.dryRun).toBe(true);
    expect((await empresa(C.alvo.company)).is_active).toBe(true);
  });

  test('desativa só a pendente sem venda, pagamento nem assinatura, há mais de 7 dias', async () => {
    const resumo = await limpeza.rodarLimpeza({ pool: db, agora: AGORA, env: {} });
    expect(resumo.falhas).toBe(0);

    for (const c of [C.alvo, C.comLead]) {
      const e = await empresa(c.company);
      expect({ nome: c.nome, ...e, desativada_em: !!e.desativada_em })
        .toEqual({ nome: c.nome, is_active: false, desativada_por: 'conta_pendente', desativada_em: true });
    }
    for (const c of [C.recente, C.confirmado, C.comVenda, C.comCobranca, C.comEvento, C.comAssinatura,
      C.ativa, C.sandbox, C.staff, C.interna, C.dojo, C.duasLojas]) {
      const e = await empresa(c.company);
      expect({ nome: c.nome, is_active: e.is_active, desativada_por: e.desativada_por })
        .toEqual({ nome: c.nome, is_active: true, desativada_por: null });
    }
    expect((await empresa(SEGUNDA_LOJA)).is_active).toBe(true);
    // a desativada à mão continua como estava, sem marca do job
    expect(await empresa(C.manual.company)).toMatchObject({ is_active: false, desativada_por: null });

    // venda, cobrança e assinatura ficam no log, não no banco
    expect(resumo.mantidas).toMatchObject({
      tem_venda: expect.any(Number), tem_pagamento: expect.any(Number),
      assinatura_asaas: expect.any(Number), dono_com_mais_de_uma_empresa: expect.any(Number),
    });
  });

  test('lead criado a partir do usuário, com o motivo; o que já existia ganha o motivo', async () => {
    const novo = await lead(C.alvo.email);
    expect(novo).toMatchObject({
      nome: 'Pessoa alvo', whatsapp: '11987654321', etapa: 3, motivo: 'nao_confirmou_email',
      user_id: C.alvo.user, company_id: C.alvo.company,
    });
    expect(novo.origem).toEqual({ utm_source: 'instagram' });
    expect(novo.token).toMatch(/^[a-f0-9]{48}$/);

    const antigo = await lead(C.comLead.email);
    expect(antigo).toMatchObject({ nome: 'Já era lead', motivo: 'nao_confirmou_email' });
    // quem não foi desativado não ganha lead
    expect(await lead(C.comVenda.email)).toBeUndefined();
  });

  test('audit_log por empresa desativada', async () => {
    const a = await auditoria(C.alvo.company, 'conta_pendente.desativada');
    expect(a).toHaveLength(1);
    expect(a[0].user_id).toBe(C.alvo.user);
    expect(a[0].metadata).toMatchObject({ desativada_por: 'conta_pendente', lead_criado: true });
    expect((await auditoria(C.comLead.company, 'conta_pendente.desativada'))[0].metadata.lead_criado).toBe(false);
    expect(await auditoria(C.comVenda.company, 'conta_pendente.desativada')).toHaveLength(0);
  });

  test('rodar de novo não faz nada', async () => {
    const resumo = await limpeza.rodarLimpeza({ pool: db, agora: AGORA, env: {} });
    expect(resumo.desativadas).toBe(0);
    expect(await auditoria(C.alvo.company, 'conta_pendente.desativada')).toHaveLength(1);
  });
});

describe('confirmar o e-mail reabre a empresa desativada pelo job', () => {
  let app;
  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/auth', require('../src/routes/verification'));
  });
  const bearer = (userId) => ({ Authorization: `Bearer ${jwt.sign({ id: userId, role: 'client' }, SECRET, { expiresIn: '1h' })}` });
  async function codigo(userId) {
    await client.query(
      `INSERT INTO verification_codes (user_id, type, code, destination, expires_at)
       VALUES ($1, 'email_otp', '654321', 'x@x', NOW() + INTERVAL '1 hour')`,
      [userId]
    );
  }

  test('código de 6 dígitos: empresa volta, audit_log e lead sem motivo', async () => {
    await codigo(C.alvo.user);
    const r = await request(app).post('/auth/verify-email').set(bearer(C.alvo.user)).send({ code: '654321' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ valid: true, email_verified: true, empresa_reativada: true });
    expect(await empresa(C.alvo.company)).toMatchObject({ is_active: true, desativada_por: null, desativada_em: null });
    expect(await auditoria(C.alvo.company, 'conta_pendente.reativada')).toHaveLength(1);
    expect((await lead(C.alvo.email)).motivo).toBeNull();
  });

  test('empresa desativada à mão nunca é reaberta pela confirmação', async () => {
    await codigo(C.manual.user);
    const r = await request(app).post('/auth/verify-email').set(bearer(C.manual.user)).send({ code: '654321' });
    expect(r.status).toBe(200);
    expect(r.body.empresa_reativada).toBeUndefined();
    expect(await empresa(C.manual.company)).toMatchObject({ is_active: false, desativada_por: null });
  });

  test('link do e-mail também reabre', async () => {
    await client.query(
      `INSERT INTO verification_codes (user_id, type, code, destination, expires_at)
       VALUES ($1, 'email', $2, 'x@x', NOW() + INTERVAL '1 hour')`,
      [C.comLead.user, `link-${tag}`]
    );
    const r = await request(app).get(`/auth/confirm-email/link-${tag}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/email_verified=true/);
    expect((await empresa(C.comLead.company)).is_active).toBe(true);
  });
});
