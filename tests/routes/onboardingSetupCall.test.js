// ============================================================
// AURA. -- GET/POST /companies/:id/onboarding/setup-call (18/10/2026, f2-04)
//
// Oferta "vamos configurar juntos" (20 min pelo WhatsApp) no Painel de quem
// acabou de se cadastrar.
//   1. regras puras (services/setupCall): quem vê e quem não vê
//   2. GET: disponivel, exibição registrada uma vez só
//   3. POST: solicitou / dispensou gravam o evento certo, uma vez por empresa
//   4. staff, conta que assina, cadastro antigo, filial e interruptor
//
// Mock por CONTEUDO DO SQL (marcadores `-- setupcall:*`), nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let db;
let router;
let requireAuth;
let requireCompanyAccess;
let regras;

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const token = (extra = {}) => ({ Authorization: `Bearer ${jwt.sign({ id: 'u-dono', role: 'user', ...extra }, SECRET, { expiresIn: '1h' })}` });
const dono = token();
const staff = token({ role: 'admin' });

const AGORA = new Date();
const dias = (n) => new Date(AGORA.getTime() - n * 86400000).toISOString();
const HA_2_DIAS = dias(2);
const HA_40_DIAS = dias(40);

let guardado;

beforeEach(() => {
  guardado = process.env.SETUP_CALL_ENABLED;
  delete process.env.SETUP_CALL_ENABLED;
  jest.resetModules();
  db = require('../../src/config/database');
  db.query.mockReset();
  router = require('../../src/routes/onboardingSetupCall');
  regras = require('../../src/services/setupCall');
  ({ requireAuth, requireCompanyAccess } = require('../../src/middleware/auth'));
});

afterEach(() => {
  if (guardado === undefined) delete process.env.SETUP_CALL_ENABLED; else process.env.SETUP_CALL_ENABLED = guardado;
});

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/onboarding/setup-call', router);
  app.use('/api/v1/companies/:id', scoped);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  return app;
}

// empresa: linha de setupcall:empresa. gravaRowCount: 1 grava, 0 = já existia.
function mockBanco({ empresa = {}, membro = true, existe = true, gravaRowCount = 1, erroGravar = null } = {}) {
  const visto = { gravar: [] };
  const linha = {
    created_at: HA_2_DIAS, billing_status: 'trial', asaas_subscription_id: null,
    fora: false, solicitado: false, dispensado: false, ...empresa,
  };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/SELECT 'owner' AS role/i.test(s)) return Promise.resolve({ rows: membro ? [{ role: 'owner' }] : [] });
    if (/-- setupcall:empresa/.test(s)) return Promise.resolve({ rows: existe ? [linha] : [] });
    if (/-- setupcall:gravar/.test(s)) {
      if (erroGravar) return Promise.reject(erroGravar);
      visto.gravar.push(params);
      return Promise.resolve({ rowCount: gravaRowCount, rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  return visto;
}

const url = `/api/v1/companies/${cid}/onboarding/setup-call`;
const acoes = (visto) => visto.gravar.map((p) => p[2]);

describe('regras (services/setupCall)', () => {
  const base = { created_at: HA_2_DIAS, billing_status: 'trial', asaas_subscription_id: null, fora: false };

  test('cadastro novo, em teste, sem ação: disponível', () => {
    expect(regras.estado({ empresa: base, agora: AGORA })).toEqual({ disponivel: true, solicitado: false, dispensado: false });
  });

  test('billing ativo ou assinatura na Asaas: não aparece', () => {
    expect(regras.motivoDeFora({ empresa: { ...base, billing_status: 'active' }, agora: AGORA })).toBe('assina');
    expect(regras.motivoDeFora({ empresa: { ...base, asaas_subscription_id: 'sub_123' }, agora: AGORA })).toBe('assina');
  });

  test('cadastro com mais de 15 dias: não aparece; no limite ainda aparece', () => {
    expect(regras.motivoDeFora({ empresa: { ...base, created_at: HA_40_DIAS }, agora: AGORA })).toBe('antiga');
    const quinzeDias = dias(15);
    expect(regras.motivoDeFora({ empresa: { ...base, created_at: quinzeDias }, agora: AGORA })).toBeNull();
  });

  test('filial, staff, interruptor desligado e data inválida: não aparece', () => {
    expect(regras.motivoDeFora({ empresa: { ...base, fora: true }, agora: AGORA })).toBe('fora');
    expect(regras.motivoDeFora({ empresa: base, staff: true, agora: AGORA })).toBe('staff');
    expect(regras.motivoDeFora({ empresa: base, agora: AGORA, env: { SETUP_CALL_ENABLED: 'false' } })).toBe('desligado');
    expect(regras.motivoDeFora({ empresa: { ...base, created_at: null }, agora: AGORA })).toBe('antiga');
  });

  test('já pediu ou já dispensou: não aparece mais', () => {
    expect(regras.estado({ empresa: { ...base, solicitado: true }, agora: AGORA }).disponivel).toBe(false);
    expect(regras.estado({ empresa: { ...base, dispensado: true }, agora: AGORA })).toMatchObject({ disponivel: false, dispensado: true });
  });

  test('normalizarClique aceita só solicitou e dispensou', () => {
    expect(regras.normalizarClique({ acao: 'solicitou' })).toEqual({ acao: 'onboarding.setup_call_requested' });
    expect(regras.normalizarClique({ acao: 'dispensou' })).toEqual({ acao: 'onboarding.setup_call_dismissed' });
    expect(regras.normalizarClique({ acao: 'onboarding.setup_call_requested' }).erro).toBeTruthy();
    expect(regras.normalizarClique({}).erro).toBeTruthy();
    expect(regras.normalizarClique(null).erro).toBeTruthy();
    expect(regras.normalizarClique([]).erro).toBeTruthy();
  });
});

describe('GET /onboarding/setup-call', () => {
  test('cadastro novo: disponível e registra a exibição', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ disponivel: true, solicitado: false, dispensado: false });
    expect(acoes(visto)).toEqual(['onboarding.setup_call_shown']);
    expect(visto.gravar[0][1]).toBe(cid);
  });

  test('falha ao registrar a exibição não derruba a leitura', async () => {
    mockBanco({ erroGravar: new Error('banco fora') });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.status).toBe(200);
    expect(res.body.disponivel).toBe(true);
  });

  test('conta que assina: indisponível e sem registrar exibição', async () => {
    const visto = mockBanco({ empresa: { billing_status: 'active' } });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.body).toEqual({ disponivel: false, solicitado: false, dispensado: false });
    expect(visto.gravar).toHaveLength(0);
  });

  test('já dispensou: indisponível, dispensado true, sem nova exibição', async () => {
    const visto = mockBanco({ empresa: { dispensado: true } });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.body).toEqual({ disponivel: false, solicitado: false, dispensado: true });
    expect(visto.gravar).toHaveLength(0);
  });

  test('staff (modo admin): nunca disponível', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).get(url).set(staff);
    expect(res.body.disponivel).toBe(false);
    expect(visto.gravar).toHaveLength(0);
  });

  test('cadastro antigo e filial: indisponível', async () => {
    mockBanco({ empresa: { created_at: HA_40_DIAS } });
    expect((await request(buildApp()).get(url).set(dono)).body.disponivel).toBe(false);
    mockBanco({ empresa: { fora: true } });
    expect((await request(buildApp()).get(url).set(dono)).body.disponivel).toBe(false);
  });

  test('empresa inexistente: 404; quem não é membro: 403', async () => {
    mockBanco({ existe: false });
    expect((await request(buildApp()).get(url).set(dono)).status).toBe(404);
    mockBanco({ membro: false });
    expect((await request(buildApp()).get(url).set(dono)).status).toBe(403);
  });

  test('sem token: 401', async () => {
    mockBanco();
    expect((await request(buildApp()).get(url)).status).toBe(401);
  });
});

describe('POST /onboarding/setup-call', () => {
  test('solicitou: grava onboarding.setup_call_requested para a empresa e o usuário', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).post(url).set(dono).send({ acao: 'solicitou' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrado: true, acao: 'onboarding.setup_call_requested' });
    expect(visto.gravar).toHaveLength(1);
    const [userId, company, action, detail, metadata] = visto.gravar[0];
    expect([userId, company, action]).toEqual(['u-dono', cid, 'onboarding.setup_call_requested']);
    expect(detail).toMatch(/20 minutos/);
    expect(JSON.parse(metadata)).toEqual({ origem: 'painel', janela_dias: 15 });
  });

  test('dispensou: grava onboarding.setup_call_dismissed', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).post(url).set(dono).send({ acao: 'dispensou' });
    expect(res.body).toEqual({ registrado: true, acao: 'onboarding.setup_call_dismissed' });
    expect(acoes(visto)).toEqual(['onboarding.setup_call_dismissed']);
  });

  test('toque repetido: o banco não grava de novo e a rota diz registrado false', async () => {
    mockBanco({ gravaRowCount: 0 });
    const res = await request(buildApp()).post(url).set(dono).send({ acao: 'solicitou' });
    expect(res.status).toBe(200);
    expect(res.body.registrado).toBe(false);
  });

  test('o INSERT é condicional (WHERE NOT EXISTS) e usa só a tabela audit_log', async () => {
    mockBanco();
    await request(buildApp()).post(url).set(dono).send({ acao: 'solicitou' });
    const sqls = db.query.mock.calls.map((c) => String(c[0])).filter((s) => /setupcall:gravar/.test(s));
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toMatch(/INSERT INTO audit_log/);
    expect(sqls[0]).toMatch(/WHERE NOT EXISTS/);
  });

  test('corpo inválido: 400 e nada gravado', async () => {
    const visto = mockBanco();
    for (const corpo of [{}, { acao: 'abrir' }, { acao: 'onboarding.setup_call_requested' }, { acao: 5 }]) {
      const res = await request(buildApp()).post(url).set(dono).send(corpo);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SETUP_CALL_INVALID');
    }
    expect(visto.gravar).toHaveLength(0);
  });

  test('staff: 403 e nada gravado', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).post(url).set(staff).send({ acao: 'solicitou' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SETUP_CALL_STAFF');
    expect(visto.gravar).toHaveLength(0);
  });

  test('conta que assina: 200, registrado false com motivo, nada gravado', async () => {
    const visto = mockBanco({ empresa: { asaas_subscription_id: 'sub_9' } });
    const res = await request(buildApp()).post(url).set(dono).send({ acao: 'solicitou' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ registrado: false, acao: 'onboarding.setup_call_requested', motivo: 'assina' });
    expect(visto.gravar).toHaveLength(0);
  });

  test('interruptor desligado: não grava', async () => {
    process.env.SETUP_CALL_ENABLED = 'off';
    const visto = mockBanco();
    const res = await request(buildApp()).post(url).set(dono).send({ acao: 'dispensou' });
    expect(res.body.registrado).toBe(false);
    expect(res.body.motivo).toBe('desligado');
    expect(visto.gravar).toHaveLength(0);
  });

  test('empresa inexistente: 404; quem não é membro: 403; sem token: 401', async () => {
    mockBanco({ existe: false });
    expect((await request(buildApp()).post(url).set(dono).send({ acao: 'solicitou' })).status).toBe(404);
    mockBanco({ membro: false });
    expect((await request(buildApp()).post(url).set(dono).send({ acao: 'solicitou' })).status).toBe(403);
    mockBanco();
    expect((await request(buildApp()).post(url).send({ acao: 'solicitou' })).status).toBe(401);
  });
});
