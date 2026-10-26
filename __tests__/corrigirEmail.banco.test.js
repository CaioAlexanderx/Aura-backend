// ============================================================
// AURA. — Corrigir o e-mail antes de confirmar (26/10/2026) — Postgres real
//
// Quem criou a conta com o e-mail errado nao tinha como corrigir: o botao
// da tela de confirmacao so saia, e recadastrar nao resolve (CNPJ entra como
// vendedor da empresa que ja existe; CPF da 409). POST /auth/corrigir-email
// troca o e-mail de quem ainda nao confirmou. O que este arquivo cobre:
//   1. troca com sucesso: users.email e companies.email (so das empresas de
//      que a pessoa e dona e que tinham o e-mail antigo), audit_log com o
//      antigo e o novo, verificacao nova enviada ao e-mail novo
//   2. link e codigo do e-mail antigo deixam de valer
//   3. e-mail ja confirmado: 409, nada muda
//   4. e-mail de outro usuario (ate com maiusculas diferentes): 409 sem
//      dizer de quem e, nada muda
//   5. formato invalido e dominio interno: 400, nada muda
//   6. envio do e-mail novo falhou: a troca vale e a resposta diz sent:false
//
// Mesmo padrao de caixa.comandas.banco.test.js: tudo dentro de UMA transacao
// revertida no afterAll; o client da rota delega ao da transacao do teste e
// troca BEGIN/COMMIT/ROLLBACK por SAVEPOINT.
// ============================================================
'use strict';

jest.mock('../src/services/mailer', () => ({
  ...jest.requireActual('../src/services/mailer'),
  sendVerificationLinkEmail: jest.fn(async () => ({ ok: true })),
}));

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
let app;
let mailer;

const tag = uuid().slice(0, 8);
const ana = { id: uuid(), email: `ana-${tag}@luciana.com` };            // digitou errado
const bia = { id: uuid(), email: `bia-${tag}@gmail.com` };              // ja confirmou
const caio = { id: uuid(), email: `caio-${tag}@gmail.com` };            // outro usuario
const lojaDaAna = uuid();       // dona, e-mail antigo (com maiusculas) -> troca
const outraDaAna = uuid();      // dona, outro e-mail -> fica
const lojaDoCaio = uuid();      // dono e o Caio, mesmo e-mail antigo -> fica

function bearer(u) {
  return { Authorization: `Bearer ${jwt.sign({ id: u.id, role: 'client' }, SECRET, { expiresIn: '1h' })}` };
}

async function emailDe(userId) {
  const { rows } = await client.query('SELECT email FROM users WHERE id = $1', [userId]);
  return rows[0].email;
}
async function emailDaLoja(companyId) {
  const { rows } = await client.query('SELECT email FROM companies WHERE id = $1', [companyId]);
  return rows[0].email;
}
async function codigos(userId) {
  const { rows } = await client.query(
    `SELECT type, code, destination FROM verification_codes WHERE user_id = $1 ORDER BY type`, [userId]
  );
  return rows;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
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
  mailer = require('../src/services/mailer');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name, email_verified) VALUES
       ($1, $2, 'x', 'Ana Teste', false),
       ($3, $4, 'x', 'Bia Teste', true),
       ($5, $6, 'x', 'Caio Teste', false)`,
    [ana.id, ana.email, bia.id, bia.email, caio.id, caio.email]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, email) VALUES
       ($1, $4, 'Loja da Ana', $6),
       ($2, $4, 'Outra da Ana', 'financeiro-${tag}@lojadaana.com.br'),
       ($3, $5, 'Loja do Caio', $7)`,
    [lojaDaAna, outraDaAna, lojaDoCaio, ana.id, caio.id, ana.email.toUpperCase(), ana.email]
  );
  // Pendentes do e-mail antigo: o link e o codigo de 6 digitos.
  await client.query(
    `INSERT INTO verification_codes (user_id, type, code, destination, expires_at, created_at) VALUES
       ($1, 'email', $2, $3, NOW() + INTERVAL '1 hour', NOW() - INTERVAL '5 minutes'),
       ($1, 'email_otp', '123456', $3, NOW() + INTERVAL '1 hour', NOW() - INTERVAL '5 minutes')`,
    [ana.id, `token-antigo-${tag}`, ana.email]
  );

  app = express();
  app.use(express.json());
  app.use('/auth', require('../src/routes/verification'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

beforeEach(() => {
  mailer.sendVerificationLinkEmail.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

describe('POST /auth/corrigir-email', () => {
  const novo = `ana-${tag}@gmail.com`;

  test('1. troca o e-mail do usuario e da loja que tinha o antigo, e envia a confirmacao nova', async () => {
    const r = await request(app).post('/auth/corrigir-email').set(bearer(ana))
      .send({ email: `  Ana-${tag}@Gmail.COM ` });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sent).toBe(true);
    expect(r.body.user).toMatchObject({ id: ana.id, email: novo, email_verified: false });

    expect(await emailDe(ana.id)).toBe(novo);
    expect(await emailDaLoja(lojaDaAna)).toBe(novo);
    // Outra loja da Ana (outro e-mail) e a loja de outro dono ficam como estavam.
    expect(await emailDaLoja(outraDaAna)).toBe(`financeiro-${tag}@lojadaana.com.br`);
    expect(await emailDaLoja(lojaDoCaio)).toBe(ana.email);

    // A confirmacao nova foi para o e-mail novo, pelo mesmo caminho do reenvio.
    expect(mailer.sendVerificationLinkEmail).toHaveBeenCalledTimes(1);
    expect(mailer.sendVerificationLinkEmail.mock.calls[0][0]).toBe(novo);
    const cods = await codigos(ana.id);
    expect(cods.map((c) => c.type).sort()).toEqual(['email', 'email_otp']);
    expect(cods.every((c) => c.destination === novo)).toBe(true);

    const { rows: audit } = await client.query(
      `SELECT company_id, metadata FROM audit_log WHERE user_id = $1 AND action = 'corrigir_email'`, [ana.id]
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].company_id).toBe(lojaDaAna);
    expect(audit[0].metadata).toMatchObject({
      email_antigo: ana.email,
      email_novo: novo,
      empresas: [lojaDaAna],
      codigos_invalidados: 2,
    });
  });

  test('2. o link e o codigo do e-mail antigo nao valem mais', async () => {
    const cods = await codigos(ana.id);
    expect(cods.find((c) => c.code === `token-antigo-${tag}`)).toBeUndefined();
    expect(cods.find((c) => c.code === '123456' && c.destination === ana.email)).toBeUndefined();

    const link = await request(app).get(`/auth/confirm-email/token-antigo-${tag}`);
    expect(link.status).toBe(302);
    expect(link.headers.location).toMatch(/verify_error=invalid/);

    const otpNovo = cods.find((c) => c.type === 'email_otp').code;
    const codigoVelho = otpNovo === '123456' ? '654321' : '123456';
    const otp = await request(app).post('/auth/verify-email').set(bearer(ana)).send({ code: codigoVelho });
    expect(otp.status).toBe(400);
    expect(otp.body.valid).toBe(false);

    const { rows } = await client.query('SELECT email_verified FROM users WHERE id = $1', [ana.id]);
    expect(rows[0].email_verified).toBe(false);
  });

  test('3. e-mail ja confirmado: 409 e nada muda', async () => {
    const r = await request(app).post('/auth/corrigir-email').set(bearer(bia))
      .send({ email: `bia-nova-${tag}@gmail.com` });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('EMAIL_JA_CONFIRMADO');
    expect(r.body.error).toMatch(/já está confirmado/);
    expect(await emailDe(bia.id)).toBe(bia.email);
    expect(mailer.sendVerificationLinkEmail).not.toHaveBeenCalled();
  });

  test('4. e-mail de outro usuario: 409 sem dizer de quem e, e nada muda', async () => {
    const r = await request(app).post('/auth/corrigir-email').set(bearer(caio))
      .send({ email: novo.toUpperCase() });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('EMAIL_EM_USO');
    const corpo = JSON.stringify(r.body);
    expect(corpo).not.toContain(ana.id);
    expect(corpo).not.toContain('Ana');
    expect(await emailDe(caio.id)).toBe(caio.email);
    expect(await emailDaLoja(lojaDoCaio)).toBe(ana.email);
    expect(mailer.sendVerificationLinkEmail).not.toHaveBeenCalled();
  });

  test.each([
    ['sem arroba', 'caio.gmail.com'],
    ['sem dominio', 'caio@'],
    ['sem ponto no dominio', 'caio@gmail'],
    ['com espaco no meio', 'caio silva@gmail.com'],
    ['ponto no fim', 'caio@gmail.'],
    ['vazio', ''],
    ['nao e texto', 12345],
  ])('5. formato invalido (%s): 400 e nada muda', async (_nome, email) => {
    const r = await request(app).post('/auth/corrigir-email').set(bearer(caio)).send({ email });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('EMAIL_INVALIDO');
    expect(await emailDe(caio.id)).toBe(caio.email);
  });

  test('5b. dominio interno da Aura: 400 e nada muda', async () => {
    const r = await request(app).post('/auth/corrigir-email').set(bearer(caio))
      .send({ email: `caio-${tag}@getaura.com.br` });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('EMAIL_DOMINIO_RESERVADO');
    expect(await emailDe(caio.id)).toBe(caio.email);
  });

  test('5c. o mesmo e-mail de agora: 400', async () => {
    const r = await request(app).post('/auth/corrigir-email').set(bearer(caio)).send({ email: caio.email });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('EMAIL_IGUAL');
  });

  test('6. envio do e-mail novo falhou: a troca vale e a resposta diz sent:false', async () => {
    mailer.sendVerificationLinkEmail.mockRejectedValueOnce(new Error('provedor fora'));
    const corrigido = `caio-${tag}@hotmail.com`;
    const r = await request(app).post('/auth/corrigir-email').set(bearer(caio)).send({ email: corrigido });
    expect(r.status).toBe(200);
    expect(r.body.sent).toBe(false);
    expect(r.body.reason).toBe('provider_error');
    expect(r.body.user.email).toBe(corrigido);
    expect(await emailDe(caio.id)).toBe(corrigido);
    // Envio falho nao deixa codigo valido no banco (issueVerification apaga).
    expect(await codigos(caio.id)).toEqual([]);
  });

  test('sem token: 401', async () => {
    const r = await request(app).post('/auth/corrigir-email').send({ email: 'x@y.com' });
    expect(r.status).toBe(401);
  });
});
