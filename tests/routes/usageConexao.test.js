// ============================================================
// POST /usage/connection-failures — falhas de conexão anotadas pelo app
// (pedido que nem chegou ao servidor). Empresa e usuário vêm do token;
// reenvio não duplica (client_id); telemetria nunca vira 500 por tabela
// ausente nem por payload estranho.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const router = require('../../src/routes/usageConexao');
const { normalizarFalhas } = router;

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000002';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
const sign = (payload) => jwt.sign(payload, 'aura-test-secret-2026');
const token = sign({ id: USER, role: 'client', company: COMPANY });
const AGORA = new Date('2026-11-14T18:00:00.000Z');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/usage', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const post = (body, t = token) => request(makeApp()).post('/usage/connection-failures')
  .set('Authorization', 'Bearer ' + t).set('User-Agent', 'Chrome/157 Windows').send(body);
const falha = (extra = {}) => ({ id: 'f-1', at: '2026-11-14T17:10:00.000Z', method: 'post', path: '/companies/x/products?x=1', code: 'network', screen: 'estoque', online: false, attempts: 3, ...extra });

beforeAll(() => {
  jest.useFakeTimers({ now: AGORA, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
});
afterAll(() => jest.useRealTimers());
afterEach(() => db.query.mockReset());

describe('POST /usage/connection-failures', () => {
  test('grava o lote com empresa/usuário do token, path sem query e método em maiúscula', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 2 });
    const res = await post({ failures: [falha(), falha({ id: 'f-2', code: 'timeout', online: null, method: 'GET' })] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gravadas: 2 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(company_id, client_id\) DO NOTHING/);
    expect(params[0]).toBe(COMPANY);
    expect(params[1]).toBe(USER);
    expect(params[3]).toBe('Chrome/157 Windows');
    expect(JSON.parse(params[2])).toEqual([
      { client_id: 'f-1', ocorreu_em: '2026-11-14T17:10:00.000Z', method: 'POST', path: '/companies/x/products', code: 'network', screen: 'estoque', online: false, attempts: 3 },
      { client_id: 'f-2', ocorreu_em: '2026-11-14T17:10:00.000Z', method: 'GET', path: '/companies/x/products', code: 'timeout', screen: 'estoque', online: null, attempts: 3 },
    ]);
  });

  test('payload estranho é 400 (sem tocar no banco)', async () => {
    for (const body of [{}, { failures: 'x' }, { failures: [falha({ code: 'outro' })] }, { failures: [falha({ id: '' })] }, { failures: [falha({ at: 'ontem' })] }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  test('mais de 50 itens é 400', async () => {
    const res = await post({ failures: Array.from({ length: 51 }, (_, i) => falha({ id: 'f' + i })) });
    expect(res.status).toBe(400);
  });

  test('tabela ainda não criada (42P01) responde 200 com gravadas 0', async () => {
    db.query.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const res = await post({ failures: [falha()] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gravadas: 0, motivo: 'indisponivel' });
  });

  test('staff em modo admin não grava', async () => {
    const res = await post({ failures: [falha()] }, sign({ id: USER, role: 'admin', company: COMPANY }));
    expect(res.body).toEqual({ ok: true, gravadas: 0, motivo: 'staff' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('sem token é 401', async () => {
    const res = await request(makeApp()).post('/usage/connection-failures').send({ failures: [falha()] });
    expect(res.status).toBe(401);
  });
});

describe('normalizarFalhas', () => {
  const agora = AGORA.getTime();
  test('descarta falha com mais de 7 dias e id repetido no lote', () => {
    const r = normalizarFalhas({ failures: [falha({ at: '2026-11-01T10:00:00Z' }), falha({ id: 'a' }), falha({ id: 'a' })] }, agora);
    expect(r.itens.map((i) => i.client_id)).toEqual(['a']);
  });
  test('relógio do aparelho adiantado usa o do servidor', () => {
    const r = normalizarFalhas({ failures: [falha({ at: '2026-11-15T18:00:00Z' })] }, agora);
    expect(r.itens[0].ocorreu_em).toBe(AGORA.toISOString());
  });
  test('campos opcionais inválidos viram null', () => {
    const r = normalizarFalhas({ failures: [falha({ method: 'HACK', attempts: 99, online: 'sim', screen: 5 })] }, agora);
    expect(r.itens[0]).toMatchObject({ method: null, attempts: null, online: null, screen: null });
  });
});
