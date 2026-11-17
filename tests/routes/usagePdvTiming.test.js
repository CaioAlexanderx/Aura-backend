// ============================================================
// POST /usage/pdv-timing — tempos da venda no Caixa, medidos no app
// (p-151, migration 455). Empresa e usuário vêm do token; reenvio não
// duplica (client_id); sem dado de cliente; telemetria nunca vira 500 por
// tabela ausente nem por payload estranho.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const router = require('../../src/routes/usagePdvTiming');
const { normalizarTempos } = router;

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000002';
const USER = 'bbbbbbbb-0000-4000-8000-000000000001';
const VENDA = 'cccccccc-0000-4000-8000-000000000003';
const sign = (payload) => jwt.sign(payload, 'aura-test-secret-2026');
const token = sign({ id: USER, role: 'client', company: COMPANY });
const AGORA = new Date('2026-11-17T12:00:00.000Z');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/usage', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const post = (body, t = token) => request(makeApp()).post('/usage/pdv-timing')
  .set('Authorization', 'Bearer ' + t).set('User-Agent', 'Chrome/157 Windows').send(body);
const tempo = (extra = {}) => ({ id: 't-1', at: '2026-11-17T11:59:00.000Z', sale_id: VENDA, atendimento_ms: 8200.4, espera_ms: 3100, ocioso_ms: 1500, itens: 2, entrada: 'leitor', ok: true, ...extra });

beforeAll(() => {
  jest.useFakeTimers({ now: AGORA, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
});
afterAll(() => jest.useRealTimers());
afterEach(() => db.query.mockReset());

describe('POST /usage/pdv-timing', () => {
  test('grava o lote com empresa e usuário do token', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const res = await post({ timings: [tempo()] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, gravadas: 1 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO pdv_sale_timings/);
    expect(sql).toMatch(/ON CONFLICT \(company_id, client_id\) DO NOTHING/);
    expect(params[0]).toBe(COMPANY);
    expect(params[1]).toBe(USER);
    expect(params[3]).toBe('Chrome/157 Windows');
    expect(JSON.parse(params[2])).toEqual([{
      client_id: 't-1', sale_id: VENDA, ocorreu_em: '2026-11-17T11:59:00.000Z',
      atendimento_ms: 8200, espera_ms: 3100, ocioso_ms: 1500, itens: 2, entrada: 'leitor', ok: true,
    }]);
  });

  test('payload estranho é 400 (sem tocar no banco)', async () => {
    for (const body of [{}, { timings: 'x' }, { timings: [null] }, { timings: [tempo({ id: '' })] }, { timings: [tempo({ at: 'ontem' })] }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  test('tabela ainda não criada (42P01): 200 com gravadas 0', async () => {
    db.query.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const res = await post({ timings: [tempo()] });
    expect(res.status).toBe(200);
    expect(res.body.gravadas).toBe(0);
  });

  test('staff em modo admin e token sem empresa não gravam', async () => {
    expect((await post({ timings: [tempo()] }, sign({ id: USER, role: 'admin', company: COMPANY }))).body.motivo).toBe('staff');
    expect((await post({ timings: [tempo()] }, sign({ id: USER, role: 'client' }))).body.motivo).toBe('sem_empresa');
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('normalizarTempos', () => {
  test('valores fora do aceito viram null; antigo some; repetido entra uma vez', () => {
    const { itens } = normalizarTempos({ timings: [
      tempo({ atendimento_ms: -1, espera_ms: 9e9, ocioso_ms: 'x', itens: 2.5, entrada: 'teclado', ok: 'sim', sale_id: 'nao-e-uuid' }),
      tempo(),
      tempo({ id: 't-velho', at: '2026-11-01T00:00:00.000Z' }),
    ] }, AGORA.getTime());
    expect(itens).toHaveLength(1);
    expect(itens[0]).toMatchObject({ atendimento_ms: null, espera_ms: null, ocioso_ms: null, itens: null, entrada: null, ok: null, sale_id: null });
  });
  test('no máximo 50 por chamada', () => {
    const muitos = Array.from({ length: 51 }, (_, i) => tempo({ id: 't-' + i }));
    expect(normalizarTempos({ timings: muitos }).erro).toMatch(/50/);
  });
});
