// ============================================================
// AURA. -- Lead do cadastro por etapa (porta de entrada 1/5, tq-66, 21/10/2026)
//
//   1. etapa 1 grava nome, e-mail, Termos e origem (upsert por e-mail) e
//      devolve lead_token; etapas 2 e 3 atualizam documento e WhatsApp
//      (sempre whatsapp_confirmado = false)
//   2. validacao: e-mail, Termos, CNPJ/CPF, WhatsApp (DDD), token
//   3. o lead nao cria conta nem usuario
//   4. limite por IP e por e-mail (429)
//   5. nada de dado pessoal no log
//   6. o register liga o lead pelo token (so com o mesmo e-mail) e herda a origem
//
// Mock por CONTEUDO DO SQL.
// ============================================================
const express = require('express');
const request = require('supertest');

const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();
const TOKEN = 'a'.repeat(48);

describe('POST /auth/signup-lead', () => {
  let db; let criarRouter;
  beforeEach(() => {
    jest.resetModules();
    db = require('../src/config/database');
    db.query.mockReset();
    ({ criarRouter } = require('../src/routes/signupLead'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  function app(opts) {
    const a = express();
    a.use(express.json());
    a.use('/auth', criarRouter(opts));
    return a;
  }

  function mock({ etapa1 = 'novo', atualiza = true, erro = null } = {}) {
    const visto = [];
    db.query.mockImplementation(async (sql, params) => {
      const s = limpo(sql);
      visto.push({ sql: s, params });
      if (erro) throw erro;
      if (s.includes('-- lead:etapa1')) return { rows: etapa1 === 'convertido' ? [] : [{ token: params[0], etapa: 1 }] };
      if (s.includes('-- lead:etapa2')) return { rows: atualiza ? [{ token: params[0], etapa: 2 }] : [] };
      if (s.includes('-- lead:etapa3')) return { rows: atualiza ? [{ token: params[0], etapa: 3 }] : [] };
      return { rows: [] };
    });
    return visto;
  }

  const etapa1 = (extra = {}) => ({
    etapa: 1, nome: 'Ana Souza', email: ' Ana@Loja.com ', terms_accepted: true, terms_version: 'v2',
    origem: { utm_source: 'Instagram', utm_campaign: 'outubro', referrer: 'https://l.instagram.com/x?u=1', landing_page: '/negocio?x=1', ref: 'ref-ana1', email: 'vaza@x.com' },
    ...extra,
  });

  test('etapa 1: upsert por e-mail com origem sanitizada; devolve lead_token; nenhuma conta criada', async () => {
    const visto = mock();
    const r = await request(app()).post('/auth/signup-lead').send(etapa1());
    expect(r.status).toBe(200);
    expect(r.body.lead_token).toMatch(/^[a-f0-9]{48}$/);
    expect(r.body).toMatchObject({ etapa: 1, whatsapp_confirmado: false });
    const q = visto.find((v) => v.sql.includes('-- lead:etapa1'));
    expect(q.sql).toContain('ON CONFLICT (email) DO UPDATE');
    expect(q.sql).toContain('WHERE signup_leads.convertido_em IS NULL');
    expect(q.params[1]).toBe('ana@loja.com');
    expect(q.params[2]).toBe('Ana Souza');
    expect(q.params[3]).toBe('v2');
    expect(JSON.parse(q.params[4])).toEqual({
      utm_source: 'instagram', utm_campaign: 'outubro', referrer: 'l.instagram.com', landing_page: '/negocio', ref: 'REF-ANA1',
    });
    // o lead nao cria conta nem usuario
    expect(visto.some((v) => /INSERT INTO (users|companies|company_members)/.test(v.sql))).toBe(false);
  });

  test('etapa 1 com e-mail que ja virou conta: 200 sem token (nao revela nada alem disso)', async () => {
    mock({ etapa1: 'convertido' });
    const r = await request(app()).post('/auth/signup-lead').send(etapa1());
    expect(r.status).toBe(200);
    expect(r.body.lead_token).toBeNull();
  });

  test.each([
    ['sem nome', { nome: '' }, 'LEAD_NAME_REQUIRED'],
    ['e-mail invalido', { email: 'ana@' }, 'LEAD_EMAIL_INVALID'],
    ['sem Termos', { terms_accepted: 'true' }, 'LEAD_TERMS_REQUIRED'],
    ['etapa errada', { etapa: 4 }, 'LEAD_INVALID'],
    ['token malformado', { lead_token: 'xyz' }, 'LEAD_TOKEN_INVALID'],
  ])('etapa 1 %s: 400 %s e nada gravado', async (_n, extra, code) => {
    const visto = mock();
    const r = await request(app()).post('/auth/signup-lead').send(etapa1(extra));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe(code);
    expect(visto).toHaveLength(0);
  });

  test('etapa 2: CNPJ valido atualiza o lead do token; CPF tambem', async () => {
    const visto = mock();
    const r = await request(app()).post('/auth/signup-lead').send({ etapa: 2, lead_token: TOKEN, cnpj: '11.222.333/0001-81', company_name: 'Loja da Ana' });
    expect(r.status).toBe(200);
    const q = visto.find((v) => v.sql.includes('-- lead:etapa2'));
    expect(q.sql).toContain('WHERE token = $1 AND convertido_em IS NULL');
    expect(q.params).toEqual([TOKEN, 'cnpj', '11222333000181', 'Loja da Ana']);

    const r2 = await request(app()).post('/auth/signup-lead').send({ etapa: 2, lead_token: TOKEN, cpf: '529.982.247-25' });
    expect(r2.status).toBe(200);
    expect(visto.filter((v) => v.sql.includes('-- lead:etapa2'))[1].params.slice(0, 3)).toEqual([TOKEN, 'cpf', '52998224725']);
  });

  test.each([
    ['sem token', { cnpj: '11222333000181' }, 'LEAD_TOKEN_REQUIRED'],
    ['CNPJ invalido', { lead_token: TOKEN, cnpj: '11222333000100' }, 'LEAD_CNPJ_INVALID'],
    ['CPF invalido', { lead_token: TOKEN, cpf: '11111111111' }, 'LEAD_CPF_INVALID'],
    ['sem documento', { lead_token: TOKEN }, 'LEAD_DOCUMENT_REQUIRED'],
  ])('etapa 2 %s: 400 %s', async (_n, extra, code) => {
    mock();
    const r = await request(app()).post('/auth/signup-lead').send({ etapa: 2, ...extra });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe(code);
  });

  test('etapa 3: WhatsApp validado (DDD + 9 + 8) e gravado como NAO confirmado', async () => {
    const visto = mock();
    const r = await request(app()).post('/auth/signup-lead').send({ etapa: 3, lead_token: TOKEN, whatsapp: '+55 (11) 98765-4321' });
    expect(r.status).toBe(200);
    expect(r.body.whatsapp_confirmado).toBe(false);
    const q = visto.find((v) => v.sql.includes('-- lead:etapa3'));
    expect(q.sql).toContain('whatsapp_confirmado = false');
    expect(q.params).toEqual([TOKEN, '11987654321']);
  });

  test.each([
    ['fixo', '1133334444', 'WHATSAPP_FIXO'],
    ['DDD inexistente', '20987654321', 'WHATSAPP_DDD_INVALID'],
    ['vazio', '', 'WHATSAPP_REQUIRED'],
  ])('etapa 3 com WhatsApp %s: 400 %s', async (_n, numero, code) => {
    mock();
    const r = await request(app()).post('/auth/signup-lead').send({ etapa: 3, lead_token: TOKEN, whatsapp: numero });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe(code);
  });

  test('token desconhecido ou lead ja convertido: 404', async () => {
    mock({ atualiza: false });
    const r = await request(app()).post('/auth/signup-lead').send({ etapa: 3, lead_token: TOKEN, whatsapp: '11987654321' });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('LEAD_NOT_FOUND');
  });

  test('migration 402 pendente: 503; erro do banco: 500 sem dado pessoal no log', async () => {
    mock({ erro: Object.assign(new Error('relation "signup_leads" does not exist'), { code: '42P01' }) });
    expect((await request(app()).post('/auth/signup-lead').send(etapa1())).status).toBe(503);

    mock({ erro: Object.assign(new Error('duplicate key value: (email)=(ana@loja.com) Ana Souza'), { code: 'XX000' }) });
    const r = await request(app()).post('/auth/signup-lead').send(etapa1());
    expect(r.status).toBe(500);
    const logado = console.error.mock.calls.flat().map(String).join(' ');
    expect(logado).not.toMatch(/ana@loja\.com|Ana Souza|11987654321/i);
    expect(JSON.stringify(r.body)).not.toMatch(/ana@loja/i);
  });

  test('limite por e-mail: a partir do limite, 429 para o mesmo e-mail (outro e-mail segue)', async () => {
    mock();
    const a = app({ porIp: 100, porEmail: 2 });
    expect((await request(a).post('/auth/signup-lead').send(etapa1())).status).toBe(200);
    expect((await request(a).post('/auth/signup-lead').send(etapa1())).status).toBe(200);
    const bloqueado = await request(a).post('/auth/signup-lead').send(etapa1({ email: 'ANA@loja.com' }));
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.code).toBe('LEAD_RATE_LIMITED');
    expect((await request(a).post('/auth/signup-lead').send(etapa1({ email: 'bia@loja.com' }))).status).toBe(200);
  });

  test('limite por IP: 429 mesmo trocando de e-mail', async () => {
    mock();
    const a = app({ porIp: 2, porEmail: 100 });
    expect((await request(a).post('/auth/signup-lead').send(etapa1({ email: 'a1@loja.com' }))).status).toBe(200);
    expect((await request(a).post('/auth/signup-lead').send(etapa1({ email: 'a2@loja.com' }))).status).toBe(200);
    expect((await request(a).post('/auth/signup-lead').send(etapa1({ email: 'a3@loja.com' }))).status).toBe(429);
  });
});

describe('POST /auth/register com lead_token', () => {
  let app; let db;
  const CID = '00000000-0000-0000-0000-000000000001';
  beforeAll(() => {
    jest.resetModules();
    ({ app } = require('../src/index'));
    db = require('../src/config/database');
  });
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  function banco({ leadOrigem = { utm_source: 'instagram', ref: 'REF-ANA1' }, achaLead = true, semTabela = false } = {}) {
    const chamadas = [];
    const client = { release: jest.fn() };
    client.query = jest.fn(async (sql, params) => {
      const s = limpo(sql);
      chamadas.push({ sql: s, params });
      if (s.startsWith('SELECT id FROM users WHERE email')) return { rows: [] };
      if (s.startsWith('INSERT INTO users')) return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client', is_staff: false, email_verified: true, created_at: new Date() }] };
      if (s.startsWith('INSERT INTO companies')) return { rows: [{ id: CID, legal_name: params[1], trade_name: params[1], plan: params[2], onboarding_step: 'cnpj', trial_ends_at: params[3], module_overrides: null }] };
      if (s.includes('-- lead:converter')) {
        if (semTabela) throw Object.assign(new Error('relation "signup_leads" does not exist'), { code: '42P01' });
        return { rows: achaLead ? [{ id: 'l1', origem: leadOrigem }] : [] };
      }
      if (s.startsWith('INSERT INTO signup_handshakes')) return { rows: [{ id: 'h1', codigo: params[2], whatsapp: params[3], estado: 'aguardando', criado_em: null }] };
      return { rows: [] };
    });
    db.connect.mockResolvedValueOnce(client);
    return { chamadas, achar: (p) => chamadas.filter((c) => c.sql.startsWith(p) || c.sql.includes(p)) };
  }

  const cadastrar = (extra = {}) => request(app).post('/api/v1/auth/register').send({
    name: 'Ana', email: 'Ana@Loja.com', password: 'senha1234', company_name: 'Loja da Ana',
    terms_accepted: true, self_serve: true, whatsapp: '11987654321', lead_token: TOKEN, ...extra,
  });

  test('liga o lead pelo token E pelo e-mail do cadastro, na transacao, e herda a origem do lead', async () => {
    const b = banco();
    const res = await cadastrar();
    expect(res.status).toBe(201);
    expect(res.body.lead_ligado).toBe(true);
    const conv = b.achar('-- lead:converter')[0];
    expect(conv.sql).toContain('WHERE token = $1 AND email = $2 AND convertido_em IS NULL');
    expect(conv.params).toEqual([TOKEN, 'ana@loja.com', CID, 'u1']);
    const upd = b.achar('UPDATE companies SET signup_origin')[0];
    expect(JSON.parse(upd.params[1])).toEqual({ utm_source: 'instagram', ref: 'REF-ANA1' });
  });

  test('origem no corpo prevalece sobre a do lead', async () => {
    const b = banco();
    await cadastrar({ origem: { utm_source: 'google' } });
    expect(JSON.parse(b.achar('UPDATE companies SET signup_origin')[0].params[1])).toEqual({ utm_source: 'google' });
  });

  test('token de outro e-mail (nao casa) ou tabela ausente: conta criada, lead_ligado false', async () => {
    banco({ achaLead: false });
    const r1 = await cadastrar();
    expect(r1.status).toBe(201);
    expect(r1.body.lead_ligado).toBe(false);

    const b = banco({ semTabela: true });
    const r2 = await cadastrar();
    expect(r2.status).toBe(201);
    expect(r2.body.lead_ligado).toBe(false);
    expect(b.chamadas.map((c) => c.sql)).toContain('ROLLBACK TO SAVEPOINT signup_lead');
    expect(b.chamadas.map((c) => c.sql)).toContain('COMMIT');
  });

  test('token malformado e ignorado sem query', async () => {
    const b = banco();
    const res = await cadastrar({ lead_token: 'nao-e-token' });
    expect(res.status).toBe(201);
    expect(b.achar('-- lead:converter')).toHaveLength(0);
  });

  test('convite (sem empresa) com lead_token: liga o lead ao usuario', async () => {
    const b = banco();
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Ana', email: 'ana@loja.com', password: 'senha1234', terms_accepted: true, lead_token: TOKEN,
    });
    expect(res.status).toBe(201);
    expect(b.achar('-- lead:converter')[0].params).toEqual([TOKEN, 'ana@loja.com', null, 'u1']);
    expect(b.achar('UPDATE companies SET signup_origin')).toHaveLength(0);
  });
});
