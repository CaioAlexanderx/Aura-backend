// ============================================================
// Card t1-02: contador de erro na ponta do lojista (5xx e EMAXCONNSESSION por
// minuto) — contador em memória, flush por minuto, leitura do bloco
// Plataforma. Nada de banco por requisição; dormente sem a tabela.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const db = require('../../src/config/database');
const svc = require('../../src/services/errosPorMinuto');
const { errosPorMinuto } = require('../../src/middleware/errosPorMinuto');

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0); // 14/10/2026 12:00:00 UTC (09:00 BRT)
const MIN = 60000;

beforeEach(() => {
  svc._reiniciar();
  delete process.env.ERROS_POR_MINUTO;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  db.query.mockReset();
});
afterEach(() => jest.restoreAllMocks());

describe('contadores', () => {
  test('conta respostas e 5xx por minuto', () => {
    svc.registrarResposta(200, T0 + 1000);
    svc.registrarResposta(404, T0 + 2000);
    svc.registrarResposta(500, T0 + 3000);
    svc.registrarResposta(503, T0 + MIN + 1000);
    expect([...svc._minutos.entries()].map(([ms, c]) => [ms - T0, c])).toEqual([
      [0, { requisicoes: 3, erros_5xx: 1, emaxconnsession: 0 }],
      [MIN, { requisicoes: 1, erros_5xx: 1, emaxconnsession: 0 }],
    ]);
  });

  test('só erro do pooler conta como EMAXCONNSESSION', () => {
    svc.registrarErro(Object.assign(new Error('x'), { code: 'EMAXCONNSESSION' }), T0);
    svc.registrarErro(new Error('error: EMAXCONNSESSION max clients reached in session mode'), T0);
    svc.registrarErro(new Error('(EMAXCONN) max clients reached in pool mode'), T0);
    svc.registrarErro(new Error('duplicate key value violates unique constraint'), T0);
    svc.registrarErro(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), T0);
    svc.registrarErro(null, T0);
    expect(svc._minutos.get(T0).emaxconnsession).toBe(3);
  });

  test('kill switch ERROS_POR_MINUTO=off: nada é contado nem lido', async () => {
    process.env.ERROS_POR_MINUTO = 'off';
    svc.registrarResposta(500, T0);
    svc.registrarErro(new Error('EMAXCONNSESSION'), T0);
    expect(svc._minutos.size).toBe(0);
    expect(await svc.resumo({ db, agora: new Date(T0) })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
    expect(svc.iniciar()).toBe(false);
  });
});

describe('observarPool', () => {
  function fakePool() {
    return {
      query: jest.fn(async (sql) => {
        if (sql === 'falha') throw new Error('EMAXCONNSESSION max clients reached in session mode');
        if (sql === 'outra') throw new Error('syntax error');
        return { rows: [{ ok: 1 }] };
      }),
      connect: jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'EMAXCONNSESSION' }); }),
    };
  }

  test('sucesso: devolve o mesmo resultado e não conta nada', async () => {
    const pool = fakePool();
    svc.observarPool(pool);
    await expect(pool.query('select 1')).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(svc._minutos.size).toBe(0);
  });

  test('falha: conta o EMAXCONNSESSION e devolve a MESMA rejeição ao chamador', async () => {
    const pool = fakePool();
    svc.observarPool(pool);
    await expect(pool.query('falha')).rejects.toThrow('EMAXCONNSESSION');
    await expect(pool.query('outra')).rejects.toThrow('syntax error');
    await expect(pool.connect()).rejects.toMatchObject({ code: 'EMAXCONNSESSION' });
    const total = [...svc._minutos.values()].reduce((s, c) => s + c.emaxconnsession, 0);
    expect(total).toBe(2);
  });

  test('é idempotente e não mexe em chamada com callback', () => {
    const cb = jest.fn();
    const original = jest.fn(() => undefined);
    const pool = { query: original, connect: jest.fn() };
    expect(svc.observarPool(pool)).toBe(true);
    expect(svc.observarPool(pool)).toBe(false);
    expect(pool.query('select 1', cb)).toBeUndefined();
    expect(original).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledWith('select 1', cb);
  });
});

describe('flush', () => {
  test('grava só os minutos fechados, em UMA consulta, e mantém o minuto corrente', async () => {
    svc.registrarResposta(200, T0 + 5000);
    svc.registrarResposta(500, T0 + 6000);
    svc.registrarResposta(200, T0 + MIN + 5000); // minuto seguinte: ainda aberto
    db.query.mockResolvedValue({ rows: [] });

    const r = await svc.flush({ db, agora: T0 + MIN + 20000 });
    expect(r.gravados).toBe(1);
    const insert = db.query.mock.calls.find((c) => /INSERT INTO erros_por_minuto/.test(c[0]));
    expect(insert).toBeDefined();
    expect(JSON.parse(insert[1][0])).toEqual([
      { minuto: new Date(T0).toISOString(), requisicoes: 2, erros_5xx: 1, emaxconnsession: 0 },
    ]);
    expect(insert[1][1]).toBe(svc.INSTANCIA);
    expect(insert[0]).toMatch(/ON CONFLICT \(minuto, instancia\) DO UPDATE/);
    expect([...svc._minutos.keys()]).toEqual([T0 + MIN]);
  });

  test('sem minuto fechado não consulta o banco', async () => {
    svc.registrarResposta(200, T0 + 1000);
    const r = await svc.flush({ db, agora: T0 + 30000 });
    expect(r.gravados).toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('tabela ausente (42P01): não lança, descarta e só tenta de novo em 10 min', async () => {
    const e = Object.assign(new Error('relation "erros_por_minuto" does not exist'), { code: '42P01' });
    db.query.mockRejectedValue(e);
    svc.registrarResposta(500, T0);
    const r1 = await svc.flush({ db, agora: T0 + MIN });
    expect(r1).toMatchObject({ gravados: 0, dormente: true });
    expect(svc._minutos.size).toBe(0);

    db.query.mockClear();
    svc.registrarResposta(500, T0 + 2 * MIN);
    const r2 = await svc.flush({ db, agora: T0 + 3 * MIN });
    expect(r2.dormente).toBe(true);
    expect(db.query).not.toHaveBeenCalled(); // espera os 10 min
    expect(svc._minutos.size).toBe(0);

    svc.registrarResposta(500, T0 + 11 * MIN);
    db.query.mockResolvedValue({ rows: [] });
    const r3 = await svc.flush({ db, agora: T0 + 12 * MIN });
    expect(r3.gravados).toBe(1);
  });

  test('falha de conexão: guarda o minuto e regrava somando, sem lançar', async () => {
    db.query.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    svc.registrarResposta(500, T0 + 1000);
    const r = await svc.flush({ db, agora: T0 + MIN + 1000 });
    expect(r.erro).toBe(true);
    expect(svc._minutos.get(T0)).toEqual({ requisicoes: 1, erros_5xx: 1, emaxconnsession: 0 });

    db.query.mockResolvedValue({ rows: [] });
    const r2 = await svc.flush({ db, agora: T0 + 2 * MIN });
    expect(r2.gravados).toBe(1);
    expect(svc._minutos.size).toBe(0);
  });

  test('retenção de 7 dias feita pelo próprio flush, no máximo uma vez por hora', async () => {
    db.query.mockResolvedValue({ rows: [] });
    svc.registrarResposta(200, T0);
    await svc.flush({ db, agora: T0 + MIN });
    const deletes = () => db.query.mock.calls.filter((c) => /DELETE FROM erros_por_minuto/.test(c[0]));
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0][1][0]).toEqual(new Date(T0 + MIN - 7 * 86400000));

    svc.registrarResposta(200, T0 + 2 * MIN);
    await svc.flush({ db, agora: T0 + 3 * MIN });
    expect(deletes()).toHaveLength(1);

    svc.registrarResposta(200, T0 + 61 * MIN);
    await svc.flush({ db, agora: T0 + 62 * MIN });
    expect(deletes()).toHaveLength(2);
  });
});

describe('resumo (últimos 60 minutos)', () => {
  const agora = new Date(T0 + 30000);

  test('sem tabela: null, sem lançar', async () => {
    db.query.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    expect(await svc.resumo({ db, agora })).toBeNull();
  });

  test('sem linhas na janela: null (o bloco sai como antes)', async () => {
    db.query.mockResolvedValue({ rows: [] });
    expect(await svc.resumo({ db, agora })).toBeNull();
  });

  test('série de 60 pontos (minuto sem linha = zero) e totais da janela fechada', async () => {
    db.query.mockResolvedValue({
      rows: [
        { minuto: new Date(T0 - 30 * MIN), requisicoes: '120', erros_5xx: '4', emaxconnsession: '3' },
        { minuto: new Date(T0 - 1 * MIN), requisicoes: '80', erros_5xx: '1', emaxconnsession: '0' },
      ],
    });
    const r = await svc.resumo({ db, agora });
    expect(r.janela_min).toBe(60);
    expect(r.serie_60m).toHaveLength(60);
    expect(r.requisicoes).toBe(200);
    expect(r.erros_5xx).toBe(5);
    expect(r.emaxconnsession).toBe(3);
    expect(r.pct_5xx).toBe(2.5);
    expect(r.minutos_com_dados).toBe(2);
    // a janela termina no minuto fechado mais recente (11:59 UTC = 08:59 BRT)
    expect(r.serie_60m[59]).toMatchObject({ rotulo: '08:59', valor: 1, requisicoes: 80 });
    expect(r.serie_60m[30]).toMatchObject({ rotulo: '08:30', valor: 4, emaxconnsession: 3 });
    expect(r.serie_60m[0].rotulo).toBe('08:00');
    expect(r.serie_60m[0].valor).toBe(0);
    // os parâmetros são o recorte da janela, não NOW()
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).not.toMatch(/NOW\(\)/i);
    expect(params).toEqual([new Date(T0 - 60 * MIN), new Date(T0)]);
  });

  test('erro que não é tabela ausente propaga (quem chama decide)', async () => {
    db.query.mockRejectedValue(new Error('conexão caiu'));
    await expect(svc.resumo({ db, agora })).rejects.toThrow('conexão caiu');
  });
});

describe('middleware', () => {
  function app() {
    const a = express();
    a.use(errosPorMinuto());
    a.get('/api/v1/ok', (req, res) => res.json({ ok: true }));
    a.get('/api/v1/quebra', (req, res) => res.status(500).json({ error: 'x' }));
    a.get('/api/v1/instavel', (req, res) => res.status(503).json({ error: 'x' }));
    a.get('/api/v1/nao-achou', (req, res) => res.status(404).json({ error: 'x' }));
    a.get('/health', (req, res) => res.json({ status: 'ok' }));
    return a;
  }
  const totais = () => [...svc._minutos.values()].reduce(
    (s, c) => ({ requisicoes: s.requisicoes + c.requisicoes, erros_5xx: s.erros_5xx + c.erros_5xx }),
    { requisicoes: 0, erros_5xx: 0 }
  );
  const esperar = () => new Promise((r) => setImmediate(r));

  test('conta respostas e 5xx; ignora /health e OPTIONS; não consulta o banco', async () => {
    const a = app();
    await request(a).get('/api/v1/ok');
    await request(a).get('/api/v1/nao-achou');
    await request(a).get('/api/v1/quebra');
    await request(a).get('/api/v1/instavel');
    await request(a).get('/health');
    await request(a).options('/api/v1/ok');
    await esperar();
    expect(totais()).toEqual({ requisicoes: 4, erros_5xx: 2 });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('em teste não liga timer nem mexe no pool', () => {
    expect(svc.iniciar()).toBe(false);
  });
});

describe('migration 381', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '381_erros_por_minuto.sql'), 'utf8');
  test('idempotente, sem DROP, chave (minuto, instancia)', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS erros_por_minuto/);
    expect(sql).toMatch(/PRIMARY KEY \(minuto, instancia\)/);
    expect(sql).not.toMatch(/\bDROP\b/i);
    for (const col of ['requisicoes', 'erros_5xx', 'emaxconnsession']) expect(sql).toContain(col);
  });
});
