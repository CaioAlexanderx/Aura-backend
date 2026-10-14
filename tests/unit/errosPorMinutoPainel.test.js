// ============================================================
// Card t1-02: o bloco Plataforma lê os últimos 60 minutos de erro na ponta do
// lojista (indicadores, série por minuto, detalhe.erros) e a rota devolve o
// `erros` ao vivo — mesmo padrão do campo `canary`. Sem a tabela, tudo sai
// como antes.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const fake = require('../helpers/fakePainelDb');
const plataforma = require('../../src/services/painelBlocos/plataforma');
const router = require('../../src/routes/adminPainel');

const MIN = 60000;
const staff = jwt.sign({ id: fake.USER, role: 'admin' }, 'aura-test-secret-2026');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin/painel', router);
  // eslint-disable-next-line no-unused-vars
  a.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return a;
}

// Minutos fechados relativos ao relógio fixo do teste (09:00 BRT de 13/10).
const minutoFechado = (n) => new Date(Math.floor(fake.AGORA.getTime() / MIN) * MIN - n * MIN);
const LINHAS = [
  { minuto: minutoFechado(20), requisicoes: '90', erros_5xx: '2', emaxconnsession: '2' },
  { minuto: minutoFechado(1), requisicoes: '110', erros_5xx: '0', emaxconnsession: '0' },
];

beforeEach(() => {
  jest.useFakeTimers({ now: fake.AGORA, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  db.query.mockReset();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('bloco plataforma', () => {
  const calcular = () => plataforma.calcular({ hoje: fake.HOJE, db });

  test('com dados: indicadores, séries e detalhe.erros', async () => {
    const dados = fake.dadosPadrao();
    dados.errosPorMinuto = LINHAS;
    fake.ligar(db.query, dados);
    const r = await calcular();

    const ind = (rotulo) => r.detalhe.indicadores.find((i) => i.rotulo === rotulo);
    expect(ind('Erros 5xx · 60 min').valor).toBe(2);
    expect(ind('Erros 5xx · 60 min').nota).toBe('200 requisições em 60 min · 1%');
    expect(ind('EMAXCONNSESSION · 60 min').valor).toBe(2);

    const serie = r.detalhe.series.find((s) => s.titulo === 'Erros 5xx por minuto · 60 min');
    expect(serie.pontos).toHaveLength(60);
    expect(serie.pontos.reduce((t, p) => t + p.valor, 0)).toBe(2);
    expect(r.detalhe.series.map((s) => s.titulo)).toContain('EMAXCONNSESSION por minuto · 60 min');
    expect(r.detalhe.erros).toMatchObject({ janela_min: 60, erros_5xx: 2, emaxconnsession: 2, requisicoes: 200 });
    // o resto do bloco (vendas) não muda
    expect(r.unidade).toBe('vendas ontem');
  });

  test('sem a tabela (migration pendente): bloco idêntico ao de antes', async () => {
    fake.ligar(db.query, fake.dadosPadrao()); // errosPorMinuto ausente → 42P01
    const r = await calcular();
    expect(r.detalhe.erros).toBeUndefined();
    expect(r.detalhe.indicadores.map((i) => i.rotulo).join('|')).not.toMatch(/5xx|EMAXCONN/);
    expect(r.detalhe.series.map((s) => s.titulo).join('|')).not.toMatch(/5xx|EMAXCONN/);
  });

  test('falha ao ler os erros não derruba o bloco', async () => {
    const dados = fake.dadosPadrao();
    fake.ligar(db.query, dados);
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (String(sql).includes('FROM erros_por_minuto')) throw new Error('conexão caiu');
      return original(sql, params);
    });
    const r = await calcular();
    expect(r.detalhe.erros).toBeUndefined();
    expect(r.valor).toBeDefined();
  });
});

describe('GET /admin/painel', () => {
  const get = (url) => request(app()).get('/admin/painel' + url).set('Authorization', 'Bearer ' + staff);

  test('/blocos/plataforma devolve o erros ao vivo', async () => {
    const dados = fake.dadosPadrao();
    dados.errosPorMinuto = LINHAS;
    fake.ligar(db.query, dados);
    const res = await get('/blocos/plataforma');
    expect(res.status).toBe(200);
    expect(res.body.erros).toMatchObject({ erros_5xx: 2, emaxconnsession: 2, requisicoes: 200 });
    expect(res.body.erros.serie_60m).toHaveLength(60);
  });

  test('/hoje põe o erros só no card da Plataforma', async () => {
    const dados = fake.dadosPadrao();
    dados.errosPorMinuto = LINHAS;
    fake.ligar(db.query, dados);
    const res = await get('/hoje');
    expect(res.status).toBe(200);
    const comErros = res.body.blocos.filter((b) => b.erros);
    expect(comErros.map((b) => b.id)).toEqual(['plataforma']);
  });

  test('dormente: nem /hoje nem /blocos/plataforma ganham o campo', async () => {
    fake.ligar(db.query, fake.dadosPadrao());
    const hoje = await get('/hoje');
    expect(hoje.body.blocos.some((b) => 'erros' in b)).toBe(false);
    const bloco = await get('/blocos/plataforma');
    expect('erros' in bloco.body).toBe(false);
  });
});
