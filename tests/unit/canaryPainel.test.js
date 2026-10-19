// ============================================================
// Bipe sintético no painel da Gestão Aura: o campo `canary` do bloco
// Plataforma, o alerta plataforma_caida e a exclusão da empresa de teste.
// ============================================================
'use strict';

const status = require('../../src/services/canaryStatus');
const plataforma = require('../../src/services/painelBlocos/plataforma');
const { calcularAlertas } = require('../../src/services/painelAlertas');

const COMPANY = 'b0463109-e68e-4d55-a2d4-40c8a758ae0b';
const USER = '5c19f573-0943-4263-beba-805456e32b13';
const HOJE = '2026-10-13';
const VAZIO = { lista: [], porId: new Map(), pagantes: [] };

const LOJA = '99999999-0000-0000-0000-000000000001';
const EMPRESAS = {
  lista: [{ company_id: LOJA, nome: 'Loja Real' }],
  porId: new Map([[LOJA, { company_id: LOJA, nome: 'Loja Real', telefone: null }]]),
  pagantes: [],
};

function ligar() {
  Object.assign(process.env, { CANARY_COMPANY_ID: COMPANY, CANARY_USER_ID: USER, CANARY_BARCODE: '789' });
}
function desligar() {
  for (const k of ['CANARY_COMPANY_ID', 'CANARY_USER_ID', 'CANARY_BARCODE', 'CANARY_ENABLED']) delete process.env[k];
}

const passosOk = [{ passo: 'bipe', ok: true, ms: 180 }, { passo: 'venda', ok: true, ms: 640 }];
const passosFalha = [{ passo: 'bipe', ok: true, ms: 180 }, { passo: 'venda', ok: false, ms: 15000, erro: 'sem resposta em 15000 ms' }];

// `ok`: de trás para a frente — o último elemento é a execução mais recente,
// 5 min atrás; cada anterior, 5 min antes.
function runsDe(oks, { agora = Date.now() } = {}) {
  const n = oks.length;
  return oks.map((okk, i) => ({
    started_at: new Date(agora - (n - i) * 5 * 60000),
    ok: okk,
    duracao_ms: okk ? 900 : 15200,
    erro: okk ? null : 'venda: sem resposta em 15000 ms',
    passos: okk ? passosOk : passosFalha,
  })).reverse(); // do mais novo para o mais antigo, como o SELECT
}

function makeDb({ runs = [], vendas = [], semTabela = false } = {}) {
  const sqls = [];
  return {
    sqls,
    query: jest.fn(async (sql) => {
      const s = sql.replace(/\s+/g, ' ');
      sqls.push(s);
      if (/FROM canary_runs/.test(s)) {
        if (semTabela) { const e = new Error('relation "canary_runs" does not exist'); e.code = '42P01'; throw e; }
        return { rows: s.includes('LIMIT 1') ? runs.slice(0, 1) : runs };
      }
      if (/FROM sales/.test(s) && /GROUP BY 1, 2/.test(s)) return { rows: vendas };
      return { rows: [] };
    }),
  };
}

beforeEach(() => {
  desligar();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { desligar(); jest.restoreAllMocks(); });

describe('bloco Plataforma', () => {
  test('dormente: sai como antes, sem campo canary e sem consultar canary_runs', async () => {
    const db = makeDb();
    const bloco = await plataforma.calcular({ hoje: HOJE, db, empresas: VAZIO });
    expect(bloco.detalhe.canary).toBeUndefined();
    expect(bloco.detalhe.indicadores.map((i) => i.rotulo)).toEqual([
      'Vendas · 7 dias', 'Lojas vendendo · ontem', 'Lojas vendendo · 7 dias', 'Recorde',
    ]);
    expect(bloco.detalhe.series).toHaveLength(1);
    expect(db.sqls.some((s) => /canary_runs/.test(s))).toBe(false);
  });

  test('ligado e sem execuções: campo canary vazio, nunca erro', async () => {
    ligar();
    const bloco = await plataforma.calcular({ hoje: HOJE, db: makeDb(), empresas: VAZIO });
    const c = bloco.detalhe.canary;
    expect(c).toMatchObject({
      ativo: true, ultimo: null, ha_minutos: null, caido: false, falhas_seguidas: 0,
      disponibilidade_24h: { execucoes: 0, ok: 0, pct: null },
    });
    expect(c.serie_24h).toHaveLength(24);
    expect(c.serie_24h.every((p) => p.valor === null && p.execucoes === 0)).toBe(true);
    const ind = bloco.detalhe.indicadores.find((i) => i.rotulo === 'Caixa · disponibilidade 24h');
    expect(ind).toEqual({ rotulo: 'Caixa · disponibilidade 24h', valor: null, nota: 'sem execuções ainda' });
    expect(bloco.detalhe.series[1]).toEqual({ titulo: 'Bipe sintético · % ok por hora', tipo: 'linha', pontos: [] });
  });

  test('ligado com execuções: último resultado, há quanto tempo, disponibilidade e série', async () => {
    ligar();
    // 12 execuções, a 4ª mais recente falhou: 11 de 12.
    const oks = Array(12).fill(true);
    oks[8] = false;
    const bloco = await plataforma.calcular({ hoje: HOJE, db: makeDb({ runs: runsDe(oks) }), empresas: VAZIO });
    const c = bloco.detalhe.canary;
    expect(c.ultimo).toMatchObject({ ok: true, duracao_ms: 900, erro: null, passo_falho: null });
    expect(c.ultimo.passos).toEqual([{ passo: 'bipe', ok: true, ms: 180 }, { passo: 'venda', ok: true, ms: 640 }]);
    expect(c.ha_minutos).toBe(5);
    expect(c.caido).toBe(false);
    expect(c.disponibilidade_24h).toEqual({ execucoes: 12, ok: 11, pct: 91.7 });
    expect(c.serie_24h).toHaveLength(24);
    const comDados = c.serie_24h.filter((p) => p.execucoes > 0);
    expect(comDados.reduce((s, p) => s + p.execucoes, 0)).toBe(12);

    const ind = bloco.detalhe.indicadores.find((i) => i.rotulo === 'Caixa · disponibilidade 24h');
    expect(ind.valor).toBe(91.7);
    expect(ind.nota).toBe('11 de 12 execuções ok');
    expect(bloco.detalhe.series[1].pontos.length).toBe(comDados.length);
  });

  test('duas falhas seguidas: caido, com o passo que falhou', async () => {
    ligar();
    const runs = runsDe([true, true, false, false]);
    const r = await status.resumo({ db: makeDb({ runs }), agora: new Date() });
    expect(r.caido).toBe(true);
    expect(r.falhas_seguidas).toBe(2);
    expect(r.ultimo).toMatchObject({ ok: false, passo_falho: 'venda', erro: 'venda: sem resposta em 15000 ms' });
    expect(r.desde).toBe(runs[1].started_at.toISOString());
  });

  test('migration 378 pendente: bloco sai sem execuções, sem erro', async () => {
    ligar();
    const r = await status.resumo({ db: makeDb({ semTabela: true }), agora: new Date() });
    expect(r).toMatchObject({ ativo: true, ultimo: null, disponibilidade_24h: { execucoes: 0, pct: null } });
  });

  test('a venda sintética não entra nas vendas da plataforma (empresa de teste fora do universo)', async () => {
    ligar();
    const ontem = '2026-10-12';
    const vendas = [
      { company_id: LOJA, dia: ontem, vendas: '7' },
      { company_id: COMPANY, dia: ontem, vendas: '288' }, // a empresa do canário não está em EMPRESAS
    ];
    const bloco = await plataforma.calcular({ hoje: HOJE, db: makeDb({ vendas }), empresas: EMPRESAS });
    expect(bloco.valor).toBe(7);
    expect(JSON.stringify(bloco.lista)).not.toContain(COMPANY);
  });
});

describe('alerta plataforma_caida no painel', () => {
  test('entra em calcularAlertas com duas falhas seguidas — é o que o passo diário regrava', async () => {
    ligar();
    const db = makeDb({ runs: runsDe([true, false, false]) });
    const alertas = await calcularAlertas({ hoje: HOJE, db, empresas: VAZIO, agora: new Date() });
    const a = alertas.find((x) => x.tipo === 'plataforma_caida');
    expect(a).toMatchObject({ chave: 'canary', company_id: null, bloco: 'plataforma', verbo: 'Ver' });
    expect(a.titulo).toMatch(/Caixa fora do ar.*há 10 min/);
    expect(a.detalhe).toMatch(/venda: sem resposta em 15000 ms/);
    expect(a.detalhe).toMatch(/2 execuções seguidas/);
    expect(alertas[0]).toBe(a); // o mais importante primeiro
  });

  test('uma falha só, ou tudo ok: sem alerta', async () => {
    ligar();
    for (const oks of [[true, true, false], [true, true, true]]) {
      const alertas = await calcularAlertas({ hoje: HOJE, db: makeDb({ runs: runsDe(oks) }), empresas: VAZIO, agora: new Date() });
      expect(alertas.find((x) => x.tipo === 'plataforma_caida')).toBeUndefined();
    }
  });

  test('dormente: não consulta canary_runs e não alerta', async () => {
    const db = makeDb({ runs: runsDe([false, false, false]) });
    const alertas = await calcularAlertas({ hoje: HOJE, db, empresas: VAZIO, agora: new Date() });
    expect(alertas.find((x) => x.tipo === 'plataforma_caida')).toBeUndefined();
    expect(db.sqls.some((s) => /canary_runs/.test(s))).toBe(false);
  });

  test('falha ao ler o canário não derruba os outros alertas', async () => {
    ligar();
    const db = makeDb({ runs: runsDe([false, false]) });
    const original = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, p) => {
      if (/FROM canary_runs/.test(sql)) throw new Error('conexão caiu');
      return original(sql, p);
    });
    const alertas = await calcularAlertas({ hoje: HOJE, db, empresas: VAZIO, agora: new Date() });
    expect(Array.isArray(alertas)).toBe(true);
    expect(alertas.find((x) => x.tipo === 'plataforma_caida')).toBeUndefined();
  });
});

describe('empresa de teste fora do universo do painel (_base.SEM_INTERNAS)', () => {
  function carregarBase() {
    let base;
    jest.isolateModules(() => { base = require('../../src/services/painelBlocos/_base'); });
    return base;
  }

  test('sem CANARY_COMPANY_ID, as regras do e-mail interno, da conta de teste (is_sandbox) e do dojô', () => {
    // 19/10/2026 (decisão do Caio): dojô sai do universo do painel.
    expect(carregarBase().SEM_INTERNAS).toBe(
      `COALESCE(c.email, '') NOT ILIKE '%@getaura.com.br' AND c.is_sandbox IS NOT TRUE`
      + ` AND c.vertical IS DISTINCT FROM 'karate_dojo'`
    );
  });

  test('com CANARY_COMPANY_ID, a empresa de teste sai (a conta Aura tem e-mail @gmail.com)', () => {
    process.env.CANARY_COMPANY_ID = COMPANY.toUpperCase();
    const sql = carregarBase().SEM_INTERNAS;
    expect(sql).toContain(`NOT ILIKE '%@getaura.com.br'`);
    expect(sql).toContain(`AND c.id <> '${COMPANY}'::uuid`);
  });

  test('valor que não é UUID nunca vira SQL', () => {
    process.env.CANARY_COMPANY_ID = "x' OR '1'='1";
    expect(carregarBase().SEM_INTERNAS).not.toContain('OR');
  });

  test('carregarEmpresas aplica o filtro na consulta', async () => {
    process.env.CANARY_COMPANY_ID = COMPANY;
    const base = carregarBase();
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    await base.carregarEmpresas(db);
    expect(db.query.mock.calls[0][0]).toContain(`c.id <> '${COMPANY}'::uuid`);
  });
});
