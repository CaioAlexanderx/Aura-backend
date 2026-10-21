// ============================================================
// AURA. -- Porta de entrada 1/5 (tq-66, 21/10/2026): WhatsApp validado,
// handshake AURA-XXXX e origem do cadastro com `ref`.
//
//   1. validarCelular: DDD da Anatel + 9 + 8 digitos, +55/0 opcionais, fixo recusado
//   2. POST /auth/register: conta nova de varejo exige o WhatsApp (400 com code);
//      convite, entrada em empresa existente pelo CNPJ e dojo nao exigem
//   3. users.phone recebe o celular normalizado; companies.phone o telefone da
//      loja (company_phone) ou o de sempre
//   4. handshake criado na transacao, codigo AURA-XXXX, colisao sorteia outro,
//      tabela ausente nao derruba o cadastro; resposta com link wa.me e
//      confirmacao_automatica false
//   5. confirmacao manual so para staff (rota propria e "Registrar contato")
//   6. origem.ref sanitizado e gravado em companies.signup_origin
//   7. fluxo de CPF (#880) e de CNPJ seguem iguais com o WhatsApp
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const whatsapp = require('../src/services/whatsappCadastro');
const handshakeSvc = require('../src/services/signupHandshake');

const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();
const CID = '00000000-0000-0000-0000-000000000001';
const FED = '11111111-1111-4111-8111-111111111111';

// ── 1. regra do celular ──────────────────────────────────────
describe('validarCelular', () => {
  test.each([
    ['11987654321', '11987654321'],
    ['(11) 98765-4321', '11987654321'],
    ['+55 11 98765-4321', '11987654321'],
    ['5511987654321', '11987654321'],
    ['011987654321', '11987654321'],
    ['55 (55) 99123-4567', '55991234567'],   // DDD 55 (RS) com +55
    ['55991234567', '55991234567'],          // DDD 55 sem +55: nao confunde com o pais
    ['(98) 98111-2233', '98981112233'],
  ])('aceita %s', (entrada, numero) => {
    const r = whatsapp.validarCelular(entrada);
    expect(r).toEqual({ ok: true, numero, e164: `55${numero}` });
  });

  test.each([
    ['1133334444', 'WHATSAPP_FIXO'],            // fixo, 10 digitos
    ['(11) 3333-4444', 'WHATSAPP_FIXO'],
    ['+55 11 3333-4444', 'WHATSAPP_FIXO'],
    ['11 2333 44445', 'WHATSAPP_FIXO'],         // 11 digitos sem o 9
    ['20987654321', 'WHATSAPP_DDD_INVALID'],    // DDD 20 nao existe
    ['10987654321', 'WHATSAPP_DDD_INVALID'],
    ['00987654321', 'WHATSAPP_DDD_INVALID'],
    ['1198765432', 'WHATSAPP_INVALID'],         // celular antigo sem o 9
    ['119876543210', 'WHATSAPP_INVALID'],       // 12 digitos
    ['119876', 'WHATSAPP_INVALID'],
    ['11999999999', 'WHATSAPP_INVALID'],        // 9 + oito iguais
    ['11 98765-4321 ramal 2', 'WHATSAPP_INVALID'],
    [{ n: '11987654321' }, 'WHATSAPP_INVALID'],
    ['', 'WHATSAPP_REQUIRED'],
    ['  ', 'WHATSAPP_REQUIRED'],
    [null, 'WHATSAPP_REQUIRED'],
    [undefined, 'WHATSAPP_REQUIRED'],
  ])('recusa %p com %s', (entrada, code) => {
    const r = whatsapp.validarCelular(entrada);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(code);
    expect(r.error).toBe(whatsapp.ERROS[code]);
  });

  test('lista de DDDs tem os 67 codigos da Anatel', () => {
    expect(whatsapp.DDDS_VALIDOS.size).toBe(67);
    for (const fora of ['20', '23', '25', '26', '29', '30', '36', '39', '40', '50', '52', '56', '57', '58', '59', '60', '70', '72', '76', '78', '80', '90']) {
      expect(whatsapp.DDDS_VALIDOS.has(fora)).toBe(false);
    }
  });

  test('numero da Aura: AURA_WHATSAPP com padrao 5511956305269', () => {
    expect(whatsapp.numeroDaAura({})).toBe('5511956305269');
    expect(whatsapp.numeroDaAura({ AURA_WHATSAPP: '+55 (21) 99876-5432' })).toBe('5521998765432');
    expect(whatsapp.numeroDaAura({ AURA_WHATSAPP: 'lixo' })).toBe('5511956305269');
    const link = whatsapp.linkDoHandshake('AURA-K7QP', {});
    expect(link.startsWith('https://wa.me/5511956305269?text=')).toBe(true);
    expect(decodeURIComponent(link.split('text=')[1])).toContain('AURA-K7QP');
  });

  test('obrigatoriedade DESLIGADA por padrao: so WHATSAPP_OBRIGATORIO_NO_CADASTRO=true liga', () => {
    expect(whatsapp.exigidoNoCadastro({})).toBe(false);
    expect(whatsapp.exigidoNoCadastro({ WHATSAPP_OBRIGATORIO_NO_CADASTRO: '' })).toBe(false);
    expect(whatsapp.exigidoNoCadastro({ WHATSAPP_OBRIGATORIO_NO_CADASTRO: 'false' })).toBe(false);
    expect(whatsapp.exigidoNoCadastro({ WHATSAPP_OBRIGATORIO_NO_CADASTRO: 'talvez' })).toBe(false);
    expect(whatsapp.exigidoNoCadastro({ WHATSAPP_OBRIGATORIO_NO_CADASTRO: 'true' })).toBe(true);
    expect(whatsapp.exigidoNoCadastro({ WHATSAPP_OBRIGATORIO_NO_CADASTRO: ' TRUE ' })).toBe(true);
    expect(whatsapp.exigidoNoCadastro({ WHATSAPP_OBRIGATORIO_NO_CADASTRO: '1' })).toBe(true);
  });
});

describe('codigo do handshake', () => {
  test('formato AURA-XXXX, sem caracteres ambiguos', () => {
    for (let i = 0; i < 200; i += 1) {
      const c = handshakeSvc.gerarCodigo();
      expect(c).toMatch(handshakeSvc.CODIGO_RE);
      expect(c.slice(5)).not.toMatch(/[01OIL]/);
    }
  });
  test('normalizarCodigo aceita minusculas e espacos, recusa o resto', () => {
    expect(handshakeSvc.normalizarCodigo(' aura-k7qp ')).toBe('AURA-K7QP');
    expect(handshakeSvc.normalizarCodigo('AURA-K7Q')).toBeNull();
    expect(handshakeSvc.normalizarCodigo("AURA-K7QP'; --")).toBeNull();
    expect(handshakeSvc.normalizarCodigo(42)).toBeNull();
  });
});

// ── 2-4, 6, 7. POST /auth/register ───────────────────────────
describe('POST /auth/register -- WhatsApp e handshake (interruptor LIGADO)', () => {
  let app; let db;
  beforeAll(() => {
    ({ app } = require('../src/index'));
    db = require('../src/config/database');
  });
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
    process.env.WHATSAPP_OBRIGATORIO_NO_CADASTRO = 'true';
    delete process.env.AURA_WHATSAPP;
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => { delete process.env.WHATSAPP_OBRIGATORIO_NO_CADASTRO; });

  function banco({ empresaExistente = false, handshake = 'ok', federacao = false } = {}) {
    const chamadas = [];
    let colisoes = handshake === 'colide' ? 1 : 0;
    const client = { release: jest.fn() };
    client.query = jest.fn(async (sql, params) => {
      const s = limpo(sql);
      chamadas.push({ sql: s, params });
      if (s.startsWith('SELECT id FROM users WHERE email')) return { rows: [] };
      if (s.includes("vertical = 'karate_federation'")) return { rows: federacao ? [{ id: FED }] : [] };
      if (s.startsWith('SELECT id FROM companies WHERE cpf')) return { rows: [] };
      if (s.startsWith('INSERT INTO users')) {
        return { rows: [{ id: 'u1', name: 'Ana', email: 'ana@loja.com', role: 'client', is_staff: false, email_verified: true, created_at: new Date() }] };
      }
      if (s.includes('FROM companies WHERE cnpj')) {
        return { rows: empresaExistente ? [{ id: 'c-existente', legal_name: 'Loja X', plan: 'negocio' }] : [] };
      }
      if (s.startsWith('INSERT INTO companies')) {
        return { rows: [{ id: CID, legal_name: params[1], trade_name: params[1], plan: params[2], onboarding_step: 'cnpj', trial_ends_at: params[3], access_code_used: params[4], module_overrides: null, vertical: params[7], vertical_active: params[7], federation_id: params[8] }] };
      }
      if (s.startsWith('INSERT INTO signup_handshakes')) {
        if (handshake === 'sem_tabela') throw Object.assign(new Error('relation "signup_handshakes" does not exist'), { code: '42P01' });
        if (colisoes > 0) { colisoes -= 1; throw Object.assign(new Error('duplicate key value violates unique constraint "signup_handshakes_codigo_key"'), { code: '23505' }); }
        return { rows: [{ id: 'h1', codigo: params[2], whatsapp: params[3], estado: 'aguardando', confirmado_em: null, confirmado_via: null, criado_em: '2026-10-21T03:00:00.000Z' }] };
      }
      return { rows: [] };
    });
    db.connect.mockResolvedValueOnce(client);
    const achar = (prefixo) => chamadas.filter((c) => c.sql.startsWith(prefixo));
    return { chamadas, achar, sqls: () => chamadas.map((c) => c.sql) };
  }

  const cadastrar = (extra = {}) => request(app).post('/api/v1/auth/register').send({
    name: 'Ana', email: 'ana@loja.com', password: 'senha1234', company_name: 'Loja da Ana',
    terms_accepted: true, self_serve: true, ...extra,
  });

  test('celular valido: 201, users.phone normalizado, handshake na transacao e resposta com o contrato novo', async () => {
    const b = banco();
    const res = await cadastrar({ whatsapp: '+55 (11) 98765-4321' });

    expect(res.status).toBe(201);
    expect(b.achar('INSERT INTO users')[0].params[4]).toBe('11987654321');
    const ins = b.achar('INSERT INTO signup_handshakes');
    expect(ins).toHaveLength(1);
    expect(ins[0].params[0]).toBe(CID);
    expect(ins[0].params[1]).toBe('u1');
    expect(ins[0].params[2]).toMatch(/^AURA-[A-Z0-9]{4}$/);
    expect(ins[0].params[3]).toBe('11987654321');
    const ordem = (p) => b.sqls().findIndex((s) => s.startsWith(p));
    expect(ordem('SAVEPOINT signup_handshake')).toBeGreaterThan(ordem('INSERT INTO companies'));
    expect(ordem('RELEASE SAVEPOINT signup_handshake')).toBeLessThan(ordem('COMMIT'));

    const h = res.body.whatsapp_handshake;
    expect(h).toEqual({
      codigo: ins[0].params[2],
      estado: 'aguardando',
      whatsapp: '11987654321',
      whatsapp_aura: '5511956305269',
      link: expect.stringMatching(/^https:\/\/wa\.me\/5511956305269\?text=/),
      confirmacao_automatica: false,
      confirmado_em: null,
      confirmado_via: null,
      criado_em: '2026-10-21T03:00:00.000Z',
    });
    expect(decodeURIComponent(h.link)).toContain(h.codigo);
  });

  test('AURA_WHATSAPP muda o numero do link', async () => {
    process.env.AURA_WHATSAPP = '5521998765432';
    banco();
    const res = await cadastrar({ whatsapp: '11987654321' });
    expect(res.body.whatsapp_handshake.whatsapp_aura).toBe('5521998765432');
    expect(res.body.whatsapp_handshake.link).toMatch(/^https:\/\/wa\.me\/5521998765432\?/);
  });

  test('o `phone` de sempre (app e site atuais) vale como WhatsApp', async () => {
    const b = banco();
    const res = await cadastrar({ phone: '11987654321' });
    expect(res.status).toBe(201);
    expect(b.achar('INSERT INTO signup_handshakes')[0].params[3]).toBe('11987654321');
    // companies.phone segue recebendo o mesmo telefone de antes
    expect(b.achar('INSERT INTO companies')[0].params[6]).toBe('11987654321');
  });

  test('`whatsapp` prevalece sobre `phone`; company_phone (telefone da loja) vai para companies.phone', async () => {
    const b = banco();
    const res = await cadastrar({ whatsapp: '21998765432', phone: '1133334444', company_phone: '(11) 3333-4444' });
    expect(res.status).toBe(201);
    expect(b.achar('INSERT INTO users')[0].params[4]).toBe('21998765432');
    expect(b.achar('INSERT INTO companies')[0].params[6]).toBe('1133334444');
  });

  test('sem company_phone e sem phone: companies.phone recebe o WhatsApp (ninguem que le companies.phone perde dado)', async () => {
    const b = banco();
    await cadastrar({ whatsapp: '21998765432' });
    expect(b.achar('INSERT INTO companies')[0].params[6]).toBe('21998765432');
  });

  test.each([
    ['fixo', { whatsapp: '(11) 3333-4444' }, 'WHATSAPP_FIXO'],
    ['DDD que nao existe', { whatsapp: '20987654321' }, 'WHATSAPP_DDD_INVALID'],
    ['curto', { phone: '119876' }, 'WHATSAPP_INVALID'],
    ['ausente', {}, 'WHATSAPP_REQUIRED'],
  ])('conta nova de varejo com WhatsApp %s: 400, ROLLBACK, nenhuma empresa criada', async (_n, extra, code) => {
    const b = banco();
    const res = await cadastrar(extra);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(res.body.field).toBe('whatsapp');
    expect(res.body.error).toBe(whatsapp.ERROS[code]);
    expect(b.sqls()).toContain('ROLLBACK');
    expect(b.sqls()).not.toContain('COMMIT');
    expect(b.achar('INSERT INTO companies')).toHaveLength(0);
  });

  test('cadastro interno (sem self_serve) tambem exige: a regra e conta nova de varejo', async () => {
    banco();
    const res = await cadastrar({ self_serve: undefined });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WHATSAPP_REQUIRED');
  });

  test('convite (sem company_name): nao exige WhatsApp e nao cria handshake', async () => {
    const b = banco();
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Bia', email: 'bia@loja.com', password: 'senha1234', terms_accepted: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.no_company).toBe(true);
    expect(res.body.whatsapp_handshake).toBeNull();
    expect(b.achar('INSERT INTO signup_handshakes')).toHaveLength(0);
    expect(b.achar('INSERT INTO users')[0].params[4]).toBeNull();
  });

  test('convite com telefone fixo: grava como sempre, sem 400', async () => {
    const b = banco();
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'Bia', email: 'bia@loja.com', password: 'senha1234', terms_accepted: true, phone: '1133334444',
    });
    expect(res.status).toBe(201);
    expect(b.achar('INSERT INTO users')[0].params[4]).toBe('1133334444');
  });

  test('entrar numa empresa existente pelo CNPJ: nao exige WhatsApp nem cria handshake', async () => {
    const b = banco({ empresaExistente: true });
    const res = await cadastrar({ cnpj: '11222333000181' });
    expect(res.status).toBe(201);
    expect(res.body.joined_existing).toBe(true);
    expect(res.body.whatsapp_handshake).toBeNull();
    expect(b.achar('INSERT INTO signup_handshakes')).toHaveLength(0);
  });

  test('dojo: nao exige WhatsApp (como hoje) e nao cria handshake', async () => {
    const b = banco({ federacao: true });
    const res = await cadastrar({ self_serve: undefined, company_name: 'Dojo Kime', vertical: 'karate_dojo', federation_id: FED });
    expect(res.status).toBe(201);
    expect(res.body.whatsapp_handshake).toBeNull();
    expect(b.achar('INSERT INTO signup_handshakes')).toHaveLength(0);
  });

  test('WHATSAPP_OBRIGATORIO_NO_CADASTRO=false: volta ao comportamento antigo', async () => {
    process.env.WHATSAPP_OBRIGATORIO_NO_CADASTRO = 'false';
    const b = banco();
    const res = await cadastrar({ phone: '1133334444' });
    expect(res.status).toBe(201);
    expect(b.achar('INSERT INTO users')[0].params[4]).toBe('1133334444');
    expect(res.body.whatsapp_handshake).toBeNull();
  });

  test('codigo repetido (23505): sorteia outro e o cadastro segue', async () => {
    const b = banco({ handshake: 'colide' });
    const res = await cadastrar({ whatsapp: '11987654321' });
    expect(res.status).toBe(201);
    expect(b.achar('INSERT INTO signup_handshakes')).toHaveLength(2);
    expect(b.sqls()).toContain('ROLLBACK TO SAVEPOINT signup_handshake');
    expect(res.body.whatsapp_handshake.estado).toBe('aguardando');
  });

  test('migration 402 pendente (42P01): conta criada, whatsapp_handshake null, sem ROLLBACK geral', async () => {
    const b = banco({ handshake: 'sem_tabela' });
    const res = await cadastrar({ whatsapp: '11987654321' });
    expect(res.status).toBe(201);
    expect(res.body.whatsapp_handshake).toBeNull();
    expect(b.sqls()).toContain('ROLLBACK TO SAVEPOINT signup_handshake');
    expect(b.sqls()).toContain('COMMIT');
    expect(b.sqls()).not.toContain('ROLLBACK');
  });

  test('origem com ref: codigo de indicacao em maiusculas na signup_origin; ref invalido some', async () => {
    const b = banco();
    await cadastrar({ whatsapp: '11987654321', origem: { utm_source: 'Instagram', ref: 'ref-ana123', landing_page: '/r/x?email=a@b.com' } });
    const upd = b.achar('UPDATE companies SET signup_origin')[0];
    expect(JSON.parse(upd.params[1])).toEqual({ utm_source: 'instagram', landing_page: '/r/x', ref: 'REF-ANA123' });

    const b2 = banco();
    await request(app).post('/api/v1/auth/register').send({
      name: 'Ana', email: 'ana@loja.com', password: 'senha1234', company_name: 'Loja', terms_accepted: true,
      whatsapp: '11987654321', origem: { utm_source: 'google', ref: "REF-1'; DROP TABLE x;--" },
    });
    expect(JSON.parse(b2.achar('UPDATE companies SET signup_origin')[0].params[1])).toEqual({ utm_source: 'google' });
  });

  test('CPF (#880) com WhatsApp: CPF em companies.cpf, handshake criado', async () => {
    const b = banco();
    const res = await cadastrar({ cpf: '529.982.247-25', whatsapp: '11987654321' });
    expect(res.status).toBe(201);
    expect(b.achar('UPDATE companies SET cpf')[0].params[1]).toBe('52998224725');
    expect(b.achar('INSERT INTO companies')[0].params[5]).toBeNull();
    expect(res.body.whatsapp_handshake.codigo).toMatch(/^AURA-/);
  });

  test('CNPJ novo com WhatsApp: cnpj no INSERT como sempre, handshake criado', async () => {
    const b = banco();
    const res = await cadastrar({ cnpj: '11.222.333/0001-81', whatsapp: '11987654321' });
    expect(res.status).toBe(201);
    expect(b.achar('INSERT INTO companies')[0].params[5]).toBe('11222333000181');
    expect(res.body.whatsapp_handshake.estado).toBe('aguardando');
  });

  // ── Interruptor DESLIGADO (o padrao: variavel ausente) ───────
  // O site e o app atuais seguem cadastrando como hoje: vazio ou fixo nao
  // viram 400 e sao gravados como sempre. Celular valido ganha handshake.
  describe('interruptor DESLIGADO (variavel ausente = padrao)', () => {
    beforeEach(() => { delete process.env.WHATSAPP_OBRIGATORIO_NO_CADASTRO; });

    test('sem telefone nenhum: 201 como hoje, sem handshake', async () => {
      const b = banco();
      const res = await cadastrar();
      expect(res.status).toBe(201);
      expect(res.body.whatsapp_handshake).toBeNull();
      expect(b.achar('INSERT INTO users')[0].params[4]).toBeNull();
      expect(b.achar('INSERT INTO companies')[0].params[6]).toBeNull();
      expect(b.achar('INSERT INTO signup_handshakes')).toHaveLength(0);
    });

    test.each([
      ['fixo', '1133334444'],
      ['fixo com mascara', '(11) 3333-4444'],
      ['DDD inexistente', '20987654321'],
      ['curto', '119876'],
    ])('telefone %s: 201, gravado como veio (users e companies), sem handshake', async (_n, numero) => {
      const b = banco();
      const res = await cadastrar({ phone: numero });
      expect(res.status).toBe(201);
      expect(b.achar('INSERT INTO users')[0].params[4]).toBe(numero);
      expect(b.achar('INSERT INTO companies')[0].params[6]).toBe(numero);
      expect(res.body.whatsapp_handshake).toBeNull();
      expect(b.sqls()).not.toContain('ROLLBACK');
    });

    test('`whatsapp` fixo tambem nao vira 400', async () => {
      const b = banco();
      const res = await cadastrar({ whatsapp: '1133334444' });
      expect(res.status).toBe(201);
      expect(b.achar('INSERT INTO users')[0].params[4]).toBe('1133334444');
    });

    test('celular valido: normalizado em users.phone e handshake criado mesmo desligado', async () => {
      const b = banco();
      const res = await cadastrar({ phone: '(11) 98765-4321' });
      expect(res.status).toBe(201);
      expect(b.achar('INSERT INTO users')[0].params[4]).toBe('11987654321');
      // companies.phone segue recebendo o `phone` como veio, igual a hoje
      expect(b.achar('INSERT INTO companies')[0].params[6]).toBe('(11) 98765-4321');
      expect(res.body.whatsapp_handshake).toMatchObject({ estado: 'aguardando', confirmacao_automatica: false });
    });
  });
});

// ── 5. confirmacao manual (staff) ────────────────────────────
describe('Gestao Aura: confirmar handshake', () => {
  const SECRET = 'aura-test-secret-2026';
  const ADMIN = 'bbbbbbbb-0000-4000-8000-000000000001';
  const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001';
  const staff = { Authorization: `Bearer ${jwt.sign({ id: ADMIN, role: 'admin' }, SECRET)}` };
  const cliente = { Authorization: `Bearer ${jwt.sign({ id: ADMIN, role: 'client', company: COMPANY }, SECRET)}` };
  let db; let router;

  beforeEach(() => {
    jest.resetModules();
    db = require('../src/config/database');
    db.query.mockReset();
    router = require('../src/routes/adminPainel');
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  function app() {
    const a = express();
    a.use(express.json());
    a.use('/admin/painel', router);
    // eslint-disable-next-line no-unused-vars
    a.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
    return a;
  }

  const linha = (extra = {}) => ({
    id: 'h1', company_id: COMPANY, codigo: 'AURA-K7QP', whatsapp: '11987654321', estado: 'confirmado',
    confirmado_em: '2026-10-21T04:00:00.000Z', confirmado_via: 'staff', criado_em: '2026-10-21T03:00:00.000Z', ...extra,
  });

  function mock({ atualiza = true, existe = true, jaConfirmado = false, semTabela = false } = {}) {
    const visto = [];
    db.query.mockImplementation(async (sql, params) => {
      const s = limpo(sql);
      visto.push({ sql: s, params });
      if (semTabela && s.includes('signup_handshakes')) throw Object.assign(new Error('relation "signup_handshakes" does not exist'), { code: '42P01' });
      if (s.includes('-- handshake:confirmar')) return { rows: atualiza ? [linha()] : [] };
      if (s.includes('-- handshake:atual')) return { rows: existe ? [linha(jaConfirmado ? {} : { estado: 'aguardando', confirmado_em: null, confirmado_via: null })] : [] };
      if (s.includes('-- handshake:lista')) return { rows: [{ ...linha({ estado: 'aguardando', confirmado_em: null, confirmado_via: null }), empresa: 'Loja da Ana', pessoa: 'Ana' }] };
      if (/^SELECT id FROM companies WHERE id = \$1/.test(s)) return { rows: [{ id: params[0] }] };
      if (s.includes('-- contato:nota')) return { rows: [{ id: 42, created_at: '2026-10-21T04:00:00.000Z' }] };
      return { rows: [] };
    });
    return visto;
  }

  test('sem token: 401; cliente (nao staff): 403 e nada e atualizado', async () => {
    const visto = mock();
    expect((await request(app()).post('/admin/painel/handshakes/AURA-K7QP/confirmar')).status).toBe(401);
    const r = await request(app()).post('/admin/painel/handshakes/AURA-K7QP/confirmar').set(cliente);
    expect(r.status).toBe(403);
    expect(visto.some((v) => v.sql.includes('signup_handshakes'))).toBe(false);
  });

  test('staff confirma pelo codigo: UPDATE so em aguardando, com quem confirmou e via staff', async () => {
    const visto = mock();
    const r = await request(app()).post('/admin/painel/handshakes/aura-k7qp/confirmar').set(staff);
    expect(r.status).toBe(200);
    const upd = visto.find((v) => v.sql.includes('-- handshake:confirmar'));
    expect(upd.sql).toContain("estado = 'aguardando'");
    expect(upd.params).toEqual(['AURA-K7QP', ADMIN, 'staff']);
    expect(r.body).toMatchObject({ codigo: 'AURA-K7QP', estado: 'confirmado', confirmado_via: 'staff', company_id: COMPANY, ja_confirmado: false, confirmacao_automatica: false });
  });

  test('confirmar de novo e idempotente: 200 com ja_confirmado true', async () => {
    mock({ atualiza: false, jaConfirmado: true });
    const r = await request(app()).post('/admin/painel/handshakes/AURA-K7QP/confirmar').set(staff);
    expect(r.status).toBe(200);
    expect(r.body.ja_confirmado).toBe(true);
  });

  test('codigo que nao existe: 404; formato errado: 400; tabela ausente: 503', async () => {
    mock({ atualiza: false, existe: false });
    expect((await request(app()).post('/admin/painel/handshakes/AURA-ZZZZ/confirmar').set(staff)).status).toBe(404);
    expect((await request(app()).post('/admin/painel/handshakes/XPTO/confirmar').set(staff)).status).toBe(400);
    mock({ semTabela: true });
    const r = await request(app()).post('/admin/painel/handshakes/AURA-K7QP/confirmar').set(staff);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('MIGRATION_PENDING');
  });

  test('"Registrar contato" com confirma_whatsapp confirma o handshake da empresa', async () => {
    const visto = mock();
    const r = await request(app()).post('/admin/painel/contatos').set(staff).send({
      company_id: COMPANY, canal: 'whatsapp', resultado: 'respondeu', body: 'Mandou o AURA-K7QP', confirma_whatsapp: true,
    });
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(42);
    expect(r.body.whatsapp_handshake).toMatchObject({ codigo: 'AURA-K7QP', estado: 'confirmado', ja_confirmado: false });
    const upd = visto.find((v) => v.sql.includes('-- handshake:confirmar'));
    expect(upd.params).toEqual([COMPANY, ADMIN, 'staff']);
  });

  test('"Registrar contato" sem confirma_whatsapp nao toca no handshake; com lead ou valor errado da 400', async () => {
    const visto = mock();
    const r = await request(app()).post('/admin/painel/contatos').set(staff).send({
      company_id: COMPANY, canal: 'whatsapp', resultado: 'respondeu', body: 'Conversamos',
    });
    expect(r.status).toBe(201);
    expect(r.body).not.toHaveProperty('whatsapp_handshake');
    expect(visto.some((v) => v.sql.includes('signup_handshakes'))).toBe(false);

    const lead = await request(app()).post('/admin/painel/contatos').set(staff).send({
      lead_id: COMPANY, canal: 'whatsapp', resultado: 'respondeu', body: 'x', confirma_whatsapp: true,
    });
    expect(lead.status).toBe(400);
    const tipo = await request(app()).post('/admin/painel/contatos').set(staff).send({
      company_id: COMPANY, canal: 'whatsapp', resultado: 'respondeu', body: 'x', confirma_whatsapp: 'sim',
    });
    expect(tipo.status).toBe(400);
  });

  test('lista dos aguardando, so para staff', async () => {
    mock();
    expect((await request(app()).get('/admin/painel/handshakes').set(cliente)).status).toBe(403);
    const r = await request(app()).get('/admin/painel/handshakes').set(staff);
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('aguardando');
    expect(r.body.handshakes[0]).toMatchObject({ codigo: 'AURA-K7QP', empresa: 'Loja da Ana', pessoa: 'Ana', company_id: COMPANY });
    expect((await request(app()).get('/admin/painel/handshakes?estado=x').set(staff)).status).toBe(400);
  });

  test('confirmarHandshake via whatsapp (para o webhook futuro): confirmado_por null', async () => {
    const visto = mock();
    const r = await handshakeSvc.confirmarHandshake(db, { codigo: 'AURA-K7QP', via: 'whatsapp' });
    expect(r.ja_confirmado).toBe(false);
    expect(visto.find((v) => v.sql.includes('-- handshake:confirmar')).params).toEqual(['AURA-K7QP', null, 'whatsapp']);
  });
});
