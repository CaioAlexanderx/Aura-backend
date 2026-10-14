// ============================================================
// AURA. -- GET/PUT /companies/:id/checkin (14/10/2026)
//
// Check-in do prospect: 3 perguntas em chip depois da escolha da frente.
//   1. GET: habilitado (interruptor, data de corte, sem resposta nem "pulou")
//   2. GET: exibido uma vez só em audit_log (carimbo condicional)
//   3. PUT: gravação parcial por chave, contrato { checkin }
//   4. PUT: validação, staff 403, migration 384 pendente
//
// Mock por CONTEUDO DO SQL (marcadores `-- checkin:*`), nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

let db;
let router;
let requireAuth;
let requireCompanyAccess;

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const token = (extra = {}) => ({ Authorization: `Bearer ${jwt.sign({ id: 'u-dono', role: 'user', ...extra }, SECRET, { expiresIn: '1h' })}` });
const dono = token();
const staff = token({ role: 'admin' });

const AMBIENTE = ['CHECKIN_ENABLED', 'CHECKIN_DESDE', 'CHECKIN_LIMIAR_PRODUTO_24H'];
let guardado;

beforeEach(() => {
  guardado = Object.fromEntries(AMBIENTE.map((k) => [k, process.env[k]]));
  AMBIENTE.forEach((k) => delete process.env[k]);
  process.env.CHECKIN_DESDE = '2026-10-01';
  jest.resetModules();
  db = require('../../src/config/database');
  db.query.mockReset();
  router = require('../../src/routes/checkin');
  ({ requireAuth, requireCompanyAccess } = require('../../src/middleware/auth'));
});

afterEach(() => {
  AMBIENTE.forEach((k) => { if (guardado[k] === undefined) delete process.env[k]; else process.env[k] = guardado[k]; });
});

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/checkin', router);
  app.use('/api/v1/companies/:id', scoped);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  return app;
}

// empresa: linha de checkin:empresa. membro: false => 403 no acesso.
function mockBanco({ empresa = {}, membro = true, exibidoRowCount = 1, erroEmpresa = null, existe = true } = {}) {
  const visto = { exibido: [], gravar: [], audit: [] };
  const linha = { created_at: '2026-10-14T12:00:00.000Z', checkin: null, eh_dojo: false, ...empresa };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/SELECT 'owner' AS role/i.test(s)) return Promise.resolve({ rows: membro ? [{ role: 'owner' }] : [] });
    if (/-- checkin:empresa/.test(s)) {
      if (erroEmpresa) return Promise.reject(erroEmpresa);
      return Promise.resolve({ rows: existe ? [linha] : [] });
    }
    if (/-- checkin:exibido/.test(s)) { visto.exibido.push(params); return Promise.resolve({ rowCount: exibidoRowCount, rows: [] }); }
    if (/-- checkin:gravar/.test(s)) {
      visto.gravar.push(params);
      const delta = JSON.parse(params[1]);
      return Promise.resolve({ rowCount: 1, rows: [{ checkin: { ...(linha.checkin || {}), ...delta } }] });
    }
    if (/INSERT INTO audit_log/i.test(s)) { visto.audit.push(params); return Promise.resolve({ rows: [] }); }
    return Promise.resolve({ rows: [] });
  });
  return visto;
}

const url = `/api/v1/companies/${cid}/checkin`;
const acoes = (visto) => visto.audit.map((p) => p[2]);

describe('GET /checkin', () => {
  test('cadastro novo sem resposta: habilitado e registra checkin.exibido', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ habilitado: true, respondido: false, pulou: false, versao: 1, respostas: null });
    expect(visto.exibido).toHaveLength(1);
    expect(visto.exibido[0][0]).toBe(cid);
    expect(acoes(visto)).toEqual(['checkin.exibido']);
    expect(visto.audit[0][1]).toBe(cid);
  });

  test('já exibida antes (carimbo condicional não grava): nenhum evento novo', async () => {
    const visto = mockBanco({ exibidoRowCount: 0, empresa: { checkin: { exibido_em: '2026-10-14T12:01:00.000Z' } } });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.body.habilitado).toBe(true);
    expect(acoes(visto)).toEqual([]);
  });

  test('respondeu: devolve as respostas, não habilita e não registra exibição', async () => {
    const visto = mockBanco({
      empresa: { checkin: { comeco: 'vender', onde_anota: 'caderno', produtos_faixa: 'ate_50', respondido_em: '2026-10-14T12:05:00.000Z', pulou: false } },
    });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.body).toEqual({
      habilitado: false, respondido: true, pulou: false, versao: 1,
      respostas: { comeco: 'vender', onde_anota: 'caderno', produtos_faixa: 'ate_50' },
    });
    expect(visto.exibido).toHaveLength(0);
    expect(acoes(visto)).toEqual([]);
  });

  test('pulou: pulou true e não habilita', async () => {
    mockBanco({ empresa: { checkin: { pulou: true, respondido_em: '2026-10-14T12:05:00.000Z' } } });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.body).toMatchObject({ habilitado: false, respondido: false, pulou: true, respostas: null });
  });

  test('interruptor CHECKIN_ENABLED=false: não habilita e não registra', async () => {
    process.env.CHECKIN_ENABLED = 'false';
    const visto = mockBanco();
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.body.habilitado).toBe(false);
    expect(visto.exibido).toHaveLength(0);
  });

  test('empresa criada antes de CHECKIN_DESDE: não habilita', async () => {
    mockBanco({ empresa: { created_at: '2026-09-20T12:00:00.000Z' } });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.body.habilitado).toBe(false);
  });

  test('staff em modo admin lê o estado, mas a tela nunca habilita nem é registrada', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).get(url).set(staff);
    expect(res.status).toBe(200);
    expect(res.body.habilitado).toBe(false);
    expect(visto.exibido).toHaveLength(0);
    expect(acoes(visto)).toEqual([]);
  });

  test('quem não é da empresa → 403', async () => {
    mockBanco({ membro: false });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.status).toBe(403);
  });

  test('migration 384 pendente (42703): habilitado false, o app segue ao Painel', async () => {
    mockBanco({ erroEmpresa: Object.assign(new Error('column c.checkin does not exist'), { code: '42703' }) });
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ habilitado: false, respondido: false, pulou: false, versao: 1, respostas: null });
  });

  test('falha ao carimbar a exibição não derruba a leitura', async () => {
    mockBanco();
    const base = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => (/-- checkin:exibido/.test(sql)
      ? Promise.reject(new Error('timeout')) : base(sql, params)));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(buildApp()).get(url).set(dono);
    expect(res.status).toBe(200);
    expect(res.body.habilitado).toBe(true);
    console.warn.mockRestore();
  });
});

describe('PUT /checkin', () => {
  test('responde as 3 perguntas: grava, carimba no servidor e registra checkin.respondido', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).put(url).set(dono)
      .send({ comeco: 'vender', onde_anota: 'caderno', produtos_faixa: 'ate_50' });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['checkin']);
    expect(res.body.checkin).toMatchObject({ comeco: 'vender', onde_anota: 'caderno', produtos_faixa: 'ate_50', versao: 1, pulou: false });
    expect(res.body.checkin.respondido_em).toEqual(expect.any(String));
    expect(visto.gravar).toHaveLength(1);
    expect(visto.gravar[0][0]).toBe(cid);
    expect(acoes(visto)).toEqual(['checkin.respondido']);
  });

  test('só a chave que veio vai ao UPDATE (merge no banco)', async () => {
    const visto = mockBanco({ empresa: { checkin: { comeco: 'vender', versao: 1, respondido_em: '2026-10-14T12:05:00.000Z', pulou: false } } });
    const res = await request(buildApp()).put(url).set(dono).send({ onde_anota: 'planilha' });
    expect(res.status).toBe(200);
    expect(JSON.parse(visto.gravar[0][1])).toEqual({ onde_anota: 'planilha' });
    expect(res.body.checkin).toMatchObject({ comeco: 'vender', onde_anota: 'planilha' });
    expect(acoes(visto)).toEqual([]);
  });

  test('Pular: pulou true e evento checkin.pulou', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).put(url).set(dono).send({ pulou: true });
    expect(res.status).toBe(200);
    expect(res.body.checkin).toMatchObject({ pulou: true, versao: 1 });
    expect(acoes(visto)).toEqual(['checkin.pulou']);
  });

  test('falha de auditoria não derruba a gravação', async () => {
    mockBanco();
    const base = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => (/INSERT INTO audit_log/i.test(sql)
      ? Promise.reject(new Error('audit fora')) : base(sql, params)));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(buildApp()).put(url).set(dono).send({ comeco: 'vender' });
    expect(res.status).toBe(200);
    console.warn.mockRestore();
  });

  test.each([
    ['sem corpo', {}],
    ['chave da equipe', { como_chegou: 'indicacao' }],
    ['chave desconhecida', { comeco: 'a', foo: 1 }],
    ['texto longo', { comeco: 'x'.repeat(41) }],
    ['pulou não booleano', { pulou: 'true' }],
  ])('inválido (%s) → 400 e nada gravado', async (_n, body) => {
    const visto = mockBanco();
    const res = await request(buildApp()).put(url).set(dono).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CHECKIN_INVALID');
    expect(visto.gravar).toHaveLength(0);
    expect(visto.audit).toHaveLength(0);
  });

  test('staff → 403 (o check-in é do cliente)', async () => {
    const visto = mockBanco();
    const res = await request(buildApp()).put(url).set(staff).send({ comeco: 'vender' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CHECKIN_STAFF');
    expect(visto.gravar).toHaveLength(0);
  });

  test('migration 384 pendente → 503 MIGRATION_PENDING', async () => {
    mockBanco({ erroEmpresa: Object.assign(new Error('column c.checkin does not exist'), { code: '42703' }) });
    const res = await request(buildApp()).put(url).set(dono).send({ comeco: 'vender' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIGRATION_PENDING');
  });

  test('empresa que não existe → 404', async () => {
    mockBanco({ existe: false });
    const res = await request(buildApp()).put(url).set(dono).send({ comeco: 'vender' });
    expect(res.status).toBe(404);
  });
});
