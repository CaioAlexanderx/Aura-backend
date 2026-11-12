// ============================================================
// AURA. — Equipe só por fonte explícita (utils/equipeAura)
//
// Regra:
//   · o cadastro nunca marca is_staff: toda conta nova nasce fora da equipe
//     e recebe o e-mail de confirmação, qualquer que seja o domínio;
//   · login, /auth/me e refresh leem is_staff do banco: o domínio do e-mail
//     não eleva ninguém; conta que já é is_staff segue sendo;
//   · a lista AURA_STAFF_EMAILS promove, e só com e-mail confirmado; sem a
//     variável, ninguém é promovido.
// ============================================================
jest.mock('../src/services/cnpj', () => {
  const real = jest.requireActual('../src/services/cnpj');
  return { ...real, lookupCNPJ: jest.fn() };
});
jest.mock('../src/services/mailer', () => ({
  ...jest.requireActual('../src/services/mailer'),
  sendVerificationLinkEmail: jest.fn().mockResolvedValue({ ok: true }),
  sendSelfServeSignupNotification: jest.fn().mockResolvedValue({ ok: true }),
}));

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { fakeSegmentDb } = require('../tests/helpers/fakeSegmentDb');
const equipe = require('../src/utils/equipeAura');

const SECRET = 'aura-test-secret-2026';
const EMAIL_DOMINIO = 'pessoa@getaura.com.br';
const SENHA = 'senha-de-teste-123';
const HASH = bcrypt.hashSync(SENHA, 4);
const limpo = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const bearer = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, SECRET, { expiresIn: '1h' })}` });

let app, db, mailer;
beforeAll(() => {
  ({ app } = require('../src/index'));
  db = require('../src/config/database');
  mailer = require('../src/services/mailer');
});
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AURA_STAFF_EMAILS;
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.AURA_STAFF_EMAILS;
  jest.restoreAllMocks();
});

const esperarFila = () => new Promise((r) => setImmediate(r));
const updatesDeStaff = () => db.query.mock.calls.filter(([sql]) => /UPDATE users SET is_staff = true/.test(limpo(sql)));

// ── utils/equipeAura ────────────────────────────────────────
describe('utils/equipeAura', () => {
  test('lista: separada por vírgula, normalizada, sem lixo; vazia sem a variável', () => {
    expect(equipe.listaDaEquipe({})).toEqual([]);
    expect(equipe.listaDaEquipe({ AURA_STAFF_EMAILS: '' })).toEqual([]);
    expect(equipe.listaDaEquipe({ AURA_STAFF_EMAILS: ' A@getaura.com.br, ,b@x.com,a@getaura.com.br,lixo ' }))
      .toEqual(['a@getaura.com.br', 'b@x.com']);
    expect(equipe.estaNaLista('B@X.COM ', { AURA_STAFF_EMAILS: 'b@x.com' })).toBe(true);
    expect(equipe.estaNaLista(EMAIL_DOMINIO, {})).toBe(false);
  });

  test('sem a variável: nunca consulta nem promove', async () => {
    const conn = { query: jest.fn() };
    expect(await equipe.promoverSeDaLista(conn, 'u1', { env: {} })).toBe(false);
    expect(await equipe.promoverSeDaLista(conn, 'u1', { email: EMAIL_DOMINIO, env: {} })).toBe(false);
    expect(conn.query).not.toHaveBeenCalled();
  });

  test('e-mail fora da lista: não consulta', async () => {
    const conn = { query: jest.fn() };
    expect(await equipe.promoverSeDaLista(conn, 'u1', { email: EMAIL_DOMINIO, env: { AURA_STAFF_EMAILS: 'outra@getaura.com.br' } })).toBe(false);
    expect(conn.query).not.toHaveBeenCalled();
  });

  test('na lista: o UPDATE exige e-mail confirmado e o e-mail na lista', async () => {
    const conn = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'u1' }] }) };
    expect(await equipe.promoverSeDaLista(conn, 'u1', { email: EMAIL_DOMINIO, env: { AURA_STAFF_EMAILS: EMAIL_DOMINIO } })).toBe(true);
    const [sql, params] = conn.query.mock.calls[0];
    expect(limpo(sql)).toMatch(/email_verified = true/);
    expect(limpo(sql)).toMatch(/is_staff IS NOT TRUE/);
    expect(limpo(sql)).toMatch(/lower\(trim\(email\)\) = ANY\(\$2::text\[\]\)/);
    expect(params).toEqual(['u1', [EMAIL_DOMINIO]]);
  });

  test('UPDATE sem linha (não confirmado) ou com erro: não promove', async () => {
    const env = { AURA_STAFF_EMAILS: EMAIL_DOMINIO };
    expect(await equipe.promoverSeDaLista({ query: jest.fn().mockResolvedValue({ rows: [] }) }, 'u1', { env })).toBe(false);
    expect(await equipe.promoverSeDaLista({ query: jest.fn().mockRejectedValue(new Error('x')) }, 'u1', { env })).toBe(false);
  });
});

// ── POST /auth/register ─────────────────────────────────────
describe('POST /auth/register: o domínio do e-mail não marca equipe', () => {
  const corpo = (email) => ({
    name: 'Pessoa', email, password: 'senha1234',
    company_name: 'Loja Teste', phone: '11999990000',
    terms_accepted: true, self_serve: true, cnpj: '11222333000181',
  });

  async function cadastrar(email) {
    const fake = fakeSegmentDb();
    db.connect.mockResolvedValueOnce(fake.client);
    const res = await request(app).post('/api/v1/auth/register').send(corpo(email));
    await esperarFila();
    return { res, fake };
  }

  test.each([
    ['domínio da Aura', EMAIL_DOMINIO],
    ['domínio da Aura em maiúsculas', 'Pessoa@GetAura.com.br'],
    ['domínio comum', 'ana@loja.com'],
  ])('%s: nasce is_staff = false, token e resposta sem equipe, e-mail de confirmação enviado', async (_n, email) => {
    const { res, fake } = await cadastrar(email);
    expect(res.status).toBe(201);
    const ins = fake.calls.find((c) => /INSERT INTO users/.test(c.text));
    expect(ins.params[3]).toBe(false);
    expect(res.body.user.is_staff).toBe(false);
    expect(jwt.verify(res.body.token, SECRET).is_staff).toBe(false);
    expect(mailer.sendVerificationLinkEmail).toHaveBeenCalledTimes(1);
    expect(mailer.sendVerificationLinkEmail.mock.calls[0][0]).toBe(email.toLowerCase());
  });

  test('mesmo na lista AURA_STAFF_EMAILS: o cadastro não promove (e-mail ainda não confirmado)', async () => {
    process.env.AURA_STAFF_EMAILS = EMAIL_DOMINIO;
    const { res, fake } = await cadastrar(EMAIL_DOMINIO);
    expect(res.status).toBe(201);
    expect(fake.calls.find((c) => /INSERT INTO users/.test(c.text)).params[3]).toBe(false);
    expect(jwt.verify(res.body.token, SECRET).is_staff).toBe(false);
    expect(updatesDeStaff()).toHaveLength(0);
    expect(fake.calls.filter((c) => /is_staff = true/.test(c.text))).toHaveLength(0);
    expect(mailer.sendVerificationLinkEmail).toHaveBeenCalledTimes(1);
  });
});

// ── POST /auth/login ────────────────────────────────────────
describe('POST /auth/login: is_staff vem do banco', () => {
  function bancoDoLogin(usuario) {
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      if (/FROM users WHERE email = \$1/.test(s)) {
        return { rows: [{ id: 'u1', name: 'Pessoa', email: EMAIL_DOMINIO, password_hash: HASH, role: 'client', is_active: true, totp_enabled: false, ...usuario }] };
      }
      if (/UPDATE users SET is_staff = true/.test(s)) return { rows: [{ id: 'u1' }] };
      return { rows: [] };
    });
  }
  const entrar = () => request(app).post('/api/v1/auth/login').send({ email: EMAIL_DOMINIO, password: SENHA });

  test('domínio da Aura, is_staff false no banco, e-mail confirmado, sem lista: segue sem equipe', async () => {
    bancoDoLogin({ is_staff: false, email_verified: true });
    const res = await entrar();
    expect(res.status).toBe(200);
    expect(res.body.user.is_staff).toBe(false);
    expect(jwt.verify(res.body.token, SECRET).is_staff).toBe(false);
    expect(updatesDeStaff()).toHaveLength(0);
  });

  test('domínio da Aura, e-mail não confirmado, mesmo na lista: segue sem equipe', async () => {
    process.env.AURA_STAFF_EMAILS = EMAIL_DOMINIO;
    bancoDoLogin({ is_staff: false, email_verified: false });
    const res = await entrar();
    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.token, SECRET).is_staff).toBe(false);
    expect(updatesDeStaff()).toHaveLength(0);
  });

  test('conta que já é is_staff no banco: segue equipe, sem lista', async () => {
    bancoDoLogin({ is_staff: true, email_verified: true });
    const res = await entrar();
    expect(res.status).toBe(200);
    expect(res.body.user.is_staff).toBe(true);
    expect(jwt.verify(res.body.token, SECRET).is_staff).toBe(true);
    expect(updatesDeStaff()).toHaveLength(0);
  });

  test('na lista e com e-mail confirmado: promovida e o token sai com equipe', async () => {
    process.env.AURA_STAFF_EMAILS = `outra@getaura.com.br, ${EMAIL_DOMINIO.toUpperCase()}`;
    bancoDoLogin({ is_staff: false, email_verified: true });
    const res = await entrar();
    expect(res.status).toBe(200);
    expect(updatesDeStaff()).toHaveLength(1);
    expect(res.body.user.is_staff).toBe(true);
    expect(jwt.verify(res.body.token, SECRET).is_staff).toBe(true);
  });
});

// ── POST /auth/me ───────────────────────────────────────────
describe('POST /auth/me: is_staff do banco, nunca do domínio', () => {
  function bancoDoMe(usuario) {
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      if (s.includes('FROM users WHERE id')) return { rows: [{ id: 'u1', name: 'Pessoa', email: EMAIL_DOMINIO, role: 'client', email_verified: true, ...usuario }] };
      return { rows: [] };
    });
  }

  test('domínio da Aura com is_staff false: false', async () => {
    bancoDoMe({ is_staff: false });
    const res = await request(app).post('/api/v1/auth/me').set(bearer({ id: 'u1', role: 'client' }));
    expect(res.status).toBe(200);
    expect(res.body.user.is_staff).toBe(false);
  });

  test('conta is_staff no banco: true', async () => {
    bancoDoMe({ is_staff: true });
    const res = await request(app).post('/api/v1/auth/me').set(bearer({ id: 'u1', role: 'client', is_staff: true }));
    expect(res.status).toBe(200);
    expect(res.body.user.is_staff).toBe(true);
  });
});

// ── refresh (services/refreshDeSessao) ──────────────────────
describe('refresh: o token novo copia o is_staff do banco', () => {
  const s = require('../src/services/refreshDeSessao');
  const SEG = 'segredo-de-teste';

  async function refrescar(isStaff) {
    const linhas = [];
    const conn = {
      async query(sql, params) {
        if (/FROM refresh_tokens/.test(sql)) return { rows: linhas.filter((l) => l.token_hash === params[0] && l.user_id === params[1]) };
        if (/FROM users/.test(sql)) return { rows: [{ id: params[0], role: 'client', is_staff: isStaff, email: EMAIL_DOMINIO }] };
        if (/^INSERT INTO refresh_tokens/.test(sql)) {
          linhas.push({ id: 'l' + (linhas.length + 1), user_id: params[0], token_hash: params[1], expires_at: params[2], app_mode: params[5] || null, revoked: false });
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const req = { headers: { 'user-agent': 'teste' }, ip: '127.0.0.1' };
    const r = s.assinarRefresh({ id: 'u1' }, SEG, { deslizante: false });
    await s.gravarRefresh(conn, { userId: 'u1', token: r.token, expiresAt: r.expiresAt, req, appMode: null });
    let assinado = null;
    await s.processarRefresh({
      token: r.token, req, db: conn, secret: SEG,
      resolveDefaultContext: async () => ({ consolidated: false, primary: { id: 'c1' }, effectivePlan: 'negocio', count: 1 }),
      resolveKarateContext: () => ({ federation_id: null, karate_role: null, dojo_id: null }),
      signAccessToken: (p) => { assinado = p; return jwt.sign({ ...p, type: 'access' }, SEG, { expiresIn: '1h' }); },
    });
    return assinado;
  }

  test('domínio da Aura com is_staff false: token sem equipe', async () => {
    expect((await refrescar(false)).is_staff).toBe(false);
  });

  test('conta is_staff no banco: token com equipe', async () => {
    expect((await refrescar(true)).is_staff).toBe(true);
  });
});

// ── confirmação do e-mail ───────────────────────────────────
describe('POST /auth/verify-email: a lista promove só depois de confirmar', () => {
  function bancoDaConfirmacao() {
    db.query.mockImplementation(async (sql) => {
      const s = limpo(sql);
      if (/FROM verification_codes/.test(s)) {
        return { rows: [{ id: 'vc1', code: '654321', attempts: 0, max_attempts: 5, expires_at: new Date(Date.now() + 3600e3), verified_at: null }] };
      }
      if (/UPDATE users SET email_verified=true/.test(s)) return { rows: [{ id: 'u1' }] };
      if (/UPDATE users SET is_staff = true/.test(s)) return { rows: [{ id: 'u1' }] };
      return { rows: [] };
    });
  }
  const confirmar = () => request(app).post('/api/v1/auth/verify-email').set(bearer({ id: 'u1', role: 'client' })).send({ code: '654321' });

  test('sem a variável: confirma e não promove', async () => {
    bancoDaConfirmacao();
    const res = await confirmar();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: true, email_verified: true });
    expect(updatesDeStaff()).toHaveLength(0);
  });

  test('com a lista: a confirmação dispara a promoção (a trava fica no UPDATE)', async () => {
    process.env.AURA_STAFF_EMAILS = EMAIL_DOMINIO;
    bancoDaConfirmacao();
    const res = await confirmar();
    expect(res.status).toBe(200);
    const [[sql, params]] = updatesDeStaff();
    expect(limpo(sql)).toMatch(/email_verified = true/);
    expect(params).toEqual(['u1', [EMAIL_DOMINIO]]);
  });
});

// ── templates visuais do Studio (requireStaff próprio) ──────
describe('Studio /visual-templates: só is_staff do banco', () => {
  function appDoStudio() {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = { id: 'u1', role: 'client' }; next(); });
    a.use('/studio', require('../src/routes/studioVisualTemplates'));
    return a;
  }

  test('domínio da Aura com is_staff false: 403', async () => {
    db.query.mockImplementation(async (sql) => (/FROM users WHERE id/.test(limpo(sql))
      ? { rows: [{ email: EMAIL_DOMINIO, is_staff: false }] }
      : { rows: [] }));
    const res = await request(appDoStudio()).post('/studio/visual-templates').send({});
    expect(res.status).toBe(403);
  });

  test('is_staff no banco: passa do gate', async () => {
    db.query.mockImplementation(async (sql) => (/FROM users WHERE id/.test(limpo(sql))
      ? { rows: [{ is_staff: true }] }
      : { rows: [] }));
    const res = await request(appDoStudio()).post('/studio/visual-templates').send({});
    expect(res.status).not.toBe(403);
  });
});
