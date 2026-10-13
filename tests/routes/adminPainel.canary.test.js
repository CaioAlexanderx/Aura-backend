// ============================================================
// /admin/painel + bipe sintético: o bloco Plataforma devolve o `canary` AO
// VIVO (o snapshot das 06h não diz "há quanto tempo"), e a resposta fica
// exatamente como era quando o canário está dormente.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const router = require('../../src/routes/adminPainel');

const COMPANY = 'b0463109-e68e-4d55-a2d4-40c8a758ae0b';
const USER = '5c19f573-0943-4263-beba-805456e32b13';
const staff = jwt.sign({ id: USER, role: 'admin' }, 'aura-test-secret-2026');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/painel', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const get = (url) => request(makeApp()).get('/admin/painel' + url).set('Authorization', 'Bearer ' + staff);

const PLATAFORMA = {
  valor: 12, unidade: 'vendas ontem', variacao: null, serie: [], resumo: '80 vendas em 7 dias', fonte: 'sales',
  lista: [],
  detalhe: { indicadores: [], listas: [], series: [], insight: null },
};

function runs(oks) {
  const agora = Date.now();
  return oks.map((okk, i) => ({
    started_at: new Date(agora - (oks.length - i) * 5 * 60000),
    ok: okk,
    duracao_ms: 900,
    erro: okk ? null : 'venda: HTTP 500',
    passos: [{ passo: 'venda', ok: okk, ms: 900 }],
  })).reverse();
}

function ligarBanco({ canaryRuns = [], canaryFalha = false } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/FROM painel_blocos_diarios/.test(s)) {
      return { rows: [{ bloco: 'plataforma', dados: PLATAFORMA, calculado_em: '2026-10-13T09:00:04.000Z' }] };
    }
    if (/FROM canary_runs/.test(s)) {
      if (canaryFalha) throw new Error('conexão caiu');
      return { rows: canaryRuns };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of ['CANARY_COMPANY_ID', 'CANARY_USER_ID', 'CANARY_BARCODE']) delete process.env[k];
  db.query.mockReset();
  jest.restoreAllMocks();
});
const ligar = () => Object.assign(process.env, { CANARY_COMPANY_ID: COMPANY, CANARY_USER_ID: USER, CANARY_BARCODE: '789' });

describe('canário dormente', () => {
  test('/hoje e /blocos/plataforma saem sem o campo canary e sem consultar canary_runs', async () => {
    ligarBanco({ canaryRuns: runs([false, false]) });
    const hoje = await get('/hoje');
    expect(hoje.status).toBe(200);
    expect(hoje.body.blocos[0].id).toBe('plataforma');
    expect(hoje.body.blocos[0].canary).toBeUndefined();

    const bloco = await get('/blocos/plataforma');
    expect(bloco.status).toBe(200);
    expect(bloco.body.canary).toBeUndefined();
    expect(db.query.mock.calls.some((c) => /canary_runs/.test(c[0]))).toBe(false);
  });
});

describe('canário ligado', () => {
  test('/hoje traz o canary ao vivo só no card da Plataforma', async () => {
    ligar();
    ligarBanco({ canaryRuns: runs([true, true, true, false]) });
    const res = await get('/hoje');
    expect(res.status).toBe(200);
    const p = res.body.blocos.find((b) => b.id === 'plataforma');
    expect(p.canary).toMatchObject({
      ativo: true, caido: false, ha_minutos: 5,
      ultimo: { ok: false, passo_falho: 'venda' },
      disponibilidade_24h: { execucoes: 4, ok: 3, pct: 75 },
    });
    expect(p.canary.serie_24h).toHaveLength(24);
    expect(res.body.blocos.filter((b) => b.canary)).toHaveLength(1);
  });

  test('/blocos/plataforma traz o canary ao vivo ao lado dos indicadores e séries', async () => {
    ligar();
    ligarBanco({ canaryRuns: runs([false, false]) });
    const res = await get('/blocos/plataforma');
    expect(res.status).toBe(200);
    expect(res.body.canary).toMatchObject({ caido: true, falhas_seguidas: 2, ultimo: { ok: false } });
    expect(res.body.valor).toBe(12);
  });

  test('falha ao ler o canário não derruba o painel: cai no snapshot gravado', async () => {
    ligar();
    ligarBanco({ canaryFalha: true });
    const res = await get('/blocos/plataforma');
    expect(res.status).toBe(200);
    expect(res.body.canary).toBeUndefined(); // o snapshot do teste não tinha canary
    expect(res.body.valor).toBe(12);
  });
});
