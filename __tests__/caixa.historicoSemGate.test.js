// ============================================================
// AURA. — Caixa: o historico de fechamentos nao depende da chave ligada
//
// 07/10/2026 (Luis Henrique, grupo de 2 lojas). A aba "Fechamentos de
// caixa" de Vendas pede GET /caixa/historico de cada empresa do grupo. A
// loja dele tinha um fechamento de 14/09 e a chave caixa_enabled desligada
// depois: a rota respondia 403 e a aba inteira virava "Erro ao carregar
// fechamentos". Leitura do que ja foi fechado nao e bloqueada pela chave
// (mesma regra do planLimit: gate so na escrita).
//
//   - getHistorico e getSessao: respondem com a chave desligada e nem
//     consultam pdv_settings;
//   - abrir continua barrado (403) com a chave desligada.
// ============================================================
'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn(), connect: jest.fn() }));

const pool = require('../src/config/database');
const caixaService = require('../src/services/caixaService');

const EMPRESA = '3a95021d-62e2-417c-8863-b9c4f0a5e155';
const SESSAO = { id: 's1', status: 'fechada', opened_at: '2026-09-14T15:50:37Z', total_geral: '350.00' };

beforeEach(() => {
  pool.query.mockReset();
  // A chave esta DESLIGADA: qualquer consulta ao gate devolve 'false'.
  pool.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/caixa_enabled/.test(s)) return Promise.resolve({ rows: [{ caixa_enabled: 'false' }] });
    if (/COUNT\(\*\)::int AS total/.test(s)) return Promise.resolve({ rows: [{ total: 1 }] });
    if (/FROM caixa_sessoes cs/.test(s)) return Promise.resolve({ rows: [SESSAO] });
    return Promise.resolve({ rows: [] });
  });
});

const consultouOGate = () => pool.query.mock.calls.some((c) => /caixa_enabled/.test(String(c[0])));

test('historico: devolve os fechamentos com a chave desligada', async () => {
  const r = await caixaService.getHistorico(EMPRESA, { limit: 50, offset: 0 });
  expect(r).toEqual({ sessoes: [SESSAO], total: 1 });
  expect(consultouOGate()).toBe(false);
});

test('detalhe da sessao: abre com a chave desligada', async () => {
  const s = await caixaService.getSessao(EMPRESA, 's1');
  expect(s.id).toBe('s1');
  expect(consultouOGate()).toBe(false);
});

test('abrir o caixa continua barrado com a chave desligada', async () => {
  await expect(caixaService.abrir(EMPRESA, 'u1', 100)).rejects.toMatchObject({ statusCode: 403 });
});
