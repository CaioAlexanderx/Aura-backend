// ============================================================
// POST /usage/screens — telas visitadas enviadas pelo app.
//
// Empresa e usuário vêm do token. Upsert por (empresa, usuário, tela, dia);
// reenviar o mesmo lote não soma de novo. Payload estranho é 400, nunca 500.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const router = require('../../src/routes/usageScreens');

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000002';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
// Sem validade: o relógio do teste é fixo em 13/10/2026.
const sign = (payload) => jwt.sign(payload, 'aura-test-secret-2026');
const token = sign({ id: USER, role: 'client', company: COMPANY });

const AGORA = new Date('2026-10-13T12:00:00.000Z');
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'painel');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/usage', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}

const post = (body, t = token) => request(makeApp()).post('/usage/screens').set('Authorization', 'Bearer ' + t).send(body);
const view = (extra = {}) => ({ screen: 'pdv', count: 3, first_at: '2026-10-13T11:00:00.000Z', last_at: '2026-10-13T11:40:00.000Z', ...extra });

beforeAll(() => {
  jest.useFakeTimers({ now: AGORA, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
});
afterAll(() => jest.useRealTimers());
afterEach(() => db.query.mockReset());

describe('POST /usage/screens — upsert', () => {
  test('grava um lote com empresa e usuário do token', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 2 });
    const body = { views: [view(), view({ screen: 'estoque', count: 1, last_at: '2026-10-13T11:45:00.000Z' })] };
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gravadas: 2 });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(params[0]).toBe(COMPANY);
    expect(params[1]).toBe(USER);
    expect(JSON.parse(params[2])).toEqual([
      { screen: 'pdv', dia: '2026-10-13', views: 3, last_at: '2026-10-13T11:40:00.000Z' },
      { screen: 'estoque', dia: '2026-10-13', views: 1, last_at: '2026-10-13T11:45:00.000Z' },
    ]);
    expect(sql).toContain('ON CONFLICT (company_id, user_id, screen, dia) DO UPDATE');

    const arq = path.join(FIXTURES, 'usage.screens.json');
    const contrato = { requisicao: body, resposta: res.body };
    if (process.env.PAINEL_FIXTURES === 'write') fs.writeFileSync(arq, JSON.stringify(contrato, null, 2) + '\n');
    expect(contrato).toEqual(JSON.parse(fs.readFileSync(arq, 'utf8')));
  });

  test('idempotente: só soma quando o last_at do lote é maior que o gravado', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const res = await post({ views: [view()] });
    const sql = db.query.mock.calls[0][0].replace(/\s+/g, ' ');
    expect(sql).toContain('views = screen_views.views + EXCLUDED.views');
    expect(sql).toContain('WHERE EXCLUDED.last_at > screen_views.last_at');
    // lote repetido: o banco não toca em nenhuma linha
    expect(res.body).toEqual({ ok: true, gravadas: 0 });
  });

  test('a mesma tela duas vezes no lote vira uma linha só (soma e fica com o last_at maior)', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await post({ views: [view({ count: 2, last_at: '2026-10-13T10:00:00.000Z' }), view({ count: 5, last_at: '2026-10-13T11:00:00.000Z' })] });
    expect(JSON.parse(db.query.mock.calls[0][1][2])).toEqual([
      { screen: 'pdv', dia: '2026-10-13', views: 7, last_at: '2026-10-13T11:00:00.000Z' },
    ]);
  });

  test('o dia é o de Brasília: 01h UTC ainda é o dia anterior', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await post({ views: [view({ last_at: '2026-10-13T01:30:00.000Z' })] });
    expect(JSON.parse(db.query.mock.calls[0][1][2])[0].dia).toBe('2026-10-12');
  });

  test('sem last_at usa a hora do servidor; relógio adiantado também', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await post({ views: [{ screen: 'pdv', count: 1 }, { screen: 'estoque', count: 1, last_at: '2026-10-20T00:00:00.000Z' }] });
    const itens = JSON.parse(db.query.mock.calls[0][1][2]);
    expect(itens.map((i) => i.last_at)).toEqual([AGORA.toISOString(), AGORA.toISOString()]);
  });

  test('lista vazia é 200 sem ir ao banco', async () => {
    const res = await post({ views: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gravadas: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('POST /usage/screens — origem da visita (apos_login, t2-14)', () => {
  const sqlDe = (n = 0) => db.query.mock.calls[n][0].replace(/\s+/g, ' ');

  test('lote sem apos_login: SQL e itens exatamente como antes (não depende da coluna)', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await post({ views: [view()] });
    expect(sqlDe()).not.toContain('views_login');
    expect(JSON.parse(db.query.mock.calls[0][1][2])[0]).not.toHaveProperty('views_login');
  });

  test('apos_login > 0: grava views_login e soma junto com views', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 2 });
    const res = await post({ views: [view({ screen: 'painel', count: 3, apos_login: 1 }), view({ screen: 'pdv', count: 2 })] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gravadas: 2 });
    expect(sqlDe()).toContain('views_login = screen_views.views_login + EXCLUDED.views_login');
    expect(sqlDe()).toContain('WHERE EXCLUDED.last_at > screen_views.last_at'); // idempotência intacta
    expect(JSON.parse(db.query.mock.calls[0][1][2])).toEqual([
      { screen: 'painel', dia: '2026-10-13', views: 3, last_at: '2026-10-13T11:40:00.000Z', views_login: 1 },
      { screen: 'pdv', dia: '2026-10-13', views: 2, last_at: '2026-10-13T11:40:00.000Z' },
    ]);
  });

  test('apos_login 0 ou nulo equivale a ausente', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    expect((await post({ views: [view({ apos_login: 0 })] })).status).toBe(200);
    expect((await post({ views: [view({ apos_login: null })] })).status).toBe(200);
    for (const [sql] of db.query.mock.calls) expect(sql).not.toContain('views_login');
  });

  test('a mesma tela duas vezes no lote soma views e views_login (e views_login nunca passa de views)', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await post({ views: [view({ screen: 'painel', count: 1, apos_login: 1, last_at: '2026-10-13T10:00:00.000Z' }), view({ screen: 'painel', count: 4, apos_login: 0, last_at: '2026-10-13T11:00:00.000Z' })] });
    expect(JSON.parse(db.query.mock.calls[0][1][2])).toEqual([
      { screen: 'painel', dia: '2026-10-13', views: 5, last_at: '2026-10-13T11:00:00.000Z', views_login: 1 },
    ]);
  });

  test('migration 389 pendente (42703): regrava o lote sem a origem, a visita não se perde', async () => {
    const err = new Error('column "views_login" of relation "screen_views" does not exist');
    err.code = '42703';
    db.query.mockRejectedValueOnce(err).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await post({ views: [view({ screen: 'painel', count: 1, apos_login: 1 })] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gravadas: 1 });
    expect(db.query).toHaveBeenCalledTimes(2);
    expect(sqlDe(0)).toContain('views_login');
    expect(sqlDe(1)).not.toContain('views_login');
    expect(JSON.parse(db.query.mock.calls[1][1][2])[0]).toMatchObject({ screen: 'painel', views: 1 });
  });

  test('42703 num lote SEM origem não é engolido (é outro problema)', async () => {
    const err = new Error('column "x" does not exist');
    err.code = '42703';
    db.query.mockRejectedValue(err);
    const res = await post({ views: [view()] });
    expect(res.status).toBe(500);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['apos_login maior que count', { screen: 'painel', count: 1, apos_login: 2 }],
    ['apos_login negativo', { screen: 'painel', count: 1, apos_login: -1 }],
    ['apos_login quebrado', { screen: 'painel', count: 2, apos_login: 0.5 }],
    ['apos_login texto', { screen: 'painel', count: 2, apos_login: '1' }],
    ['apos_login booleano', { screen: 'painel', count: 2, apos_login: true }],
  ])('%s → 400', async (_nome, item) => {
    const res = await post({ views: [item] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/apos_login/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('normalizarViews expõe views_login só quando há origem', () => {
    const { normalizarViews } = require('../../src/routes/usageScreens');
    const { itens } = normalizarViews({ views: [{ screen: 'painel', count: 2, apos_login: 1 }, { screen: 'pdv', count: 1 }] }, AGORA.getTime());
    expect(itens.map((i) => i.views_login)).toEqual([1, undefined]);
  });
});

describe('POST /usage/screens — limites e payload inválido (400, nunca 500)', () => {
  test('50 itens passam, 51 não', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 50 });
    const lote = (n) => ({ views: Array.from({ length: n }, (_, i) => view({ screen: 'tela-' + i })) });
    expect((await post(lote(50))).status).toBe(200);
    db.query.mockClear();
    const res = await post(lote(51));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/50/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('screen com 64 caracteres passa, 65 não', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    expect((await post({ views: [view({ screen: 'x'.repeat(64) })] })).status).toBe(200);
    expect((await post({ views: [view({ screen: 'x'.repeat(65) })] })).status).toBe(400);
  });

  test.each([
    ['body vazio', {}],
    ['views não é lista', { views: 'pdv' }],
    ['views é objeto', { views: { screen: 'pdv', count: 1 } }],
    ['item nulo', { views: [null] }],
    ['item é lista', { views: [['pdv', 1]] }],
    ['screen ausente', { views: [{ count: 1 }] }],
    ['screen não é texto', { views: [{ screen: 42, count: 1 }] }],
    ['screen em branco', { views: [{ screen: '   ', count: 1 }] }],
    ['count ausente', { views: [{ screen: 'pdv' }] }],
    ['count zero', { views: [{ screen: 'pdv', count: 0 }] }],
    ['count negativo', { views: [{ screen: 'pdv', count: -3 }] }],
    ['count quebrado', { views: [{ screen: 'pdv', count: 1.5 }] }],
    ['count texto', { views: [{ screen: 'pdv', count: '3' }] }],
    ['count absurdo', { views: [{ screen: 'pdv', count: 10001 }] }],
    ['last_at lixo', { views: [{ screen: 'pdv', count: 1, last_at: 'ontem' }] }],
    ['last_at objeto', { views: [{ screen: 'pdv', count: 1, last_at: { a: 1 } }] }],
    ['last_at de meses atrás', { views: [{ screen: 'pdv', count: 1, last_at: '2026-01-01T00:00:00.000Z' }] }],
  ])('%s → 400', async (_nome, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('JSON que não é objeto → 400', async () => {
    const res = await request(makeApp()).post('/usage/screens')
      .set('Authorization', 'Bearer ' + token).set('Content-Type', 'application/json').send('[1,2,3]');
    expect(res.status).toBe(400);
  });
});

describe('POST /usage/screens — quem não grava', () => {
  test('sem token → 401', async () => {
    const res = await request(makeApp()).post('/usage/screens').send({ views: [view()] });
    expect(res.status).toBe(401);
  });

  test('token sem empresa (visão consolidada) → 200, nada gravado', async () => {
    const res = await post({ views: [view()] }, sign({ id: USER, role: 'client', company: null }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gravadas: 0, motivo: 'sem_empresa' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('staff em modo admin não conta como uso do cliente', async () => {
    const res = await post({ views: [view()] }, sign({ id: USER, role: 'admin', company: COMPANY }));
    expect(res.body).toEqual({ ok: true, gravadas: 0, motivo: 'staff' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a empresa do body é ignorada: vale a do token', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    await post({ company_id: 'outra', user_id: 'outro', views: [view()] });
    expect(db.query.mock.calls[0][1].slice(0, 2)).toEqual([COMPANY, USER]);
  });

  test('tabela ainda não criada (42P01) → 200, não derruba o app', async () => {
    const err = new Error('relation "screen_views" does not exist');
    err.code = '42P01';
    db.query.mockRejectedValue(err);
    const res = await post({ views: [view()] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gravadas: 0, motivo: 'indisponivel' });
  });

  test('erro de verdade no banco sobe (não é engolido)', async () => {
    db.query.mockRejectedValue(new Error('connection terminated'));
    const res = await post({ views: [view()] });
    expect(res.status).toBe(500);
  });
});
