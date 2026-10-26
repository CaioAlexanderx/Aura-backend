// ============================================================
// Gestão Aura sem dojôs (decisão do Caio, 19/10/2026)
//
// "Eu não quero visualizar esses dojôs, eles são dados exclusivamente da
// federação." As listas, contagens, funis, alertas e métricas das rotas
// /admin/* e o universo do painel deixam de incluir empresas com
// companies.vertical = 'karate_dojo'. A federação continua aparecendo. A
// busca por id de um dojô continua funcionando (suporte).
//
// Banco de mentira que entende os filtros que importam aqui: aplica
// `vertical IS DISTINCT FROM 'karate_dojo'` e o filtro de federation_id
// quando eles estão no SQL. Assim a rota só "esconde" o dojô se a consulta
// dela pedir isso de verdade.
// ============================================================
'use strict';

jest.mock('../../src/services/custosMensais', () => ({
  custoDoMes: jest.fn(async () => ({
    total: null, mes: '2026-10', lancado: false, rotulo: 'sem custo lançado', itens: [],
    taxas_asaas: null, das: null, das_rotulo: null, das_obs: null,
    margem: null, margem_pct: null, receita_base: null, receita: null, receita_obs: null,
  })),
  marketingDosMeses: jest.fn(async () => ({ valor: null, meses_com_abertura: 0, meses_lancados: 0 })),
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const gestao = require('../../src/utils/empresasDaGestao');

const SECRET = 'aura-test-secret-2026';
const staff = jwt.sign({ id: 'bbbbbbbb-0000-4000-8000-000000000001', role: 'admin' }, SECRET);

const LOJA = '11111111-0000-4000-8000-000000000001';
const FEDERACAO = '22222222-0000-4000-8000-000000000002';
const DOJO = '33333333-0000-4000-8000-000000000003';
// Dojô sem federation_id: o filtro antigo (federation_id) não o pegava.
const DOJO_SOLTO = '44444444-0000-4000-8000-000000000004';

const base = {
  is_active: true, billing_status: 'active', billing_cycle: 'monthly', module_overrides: {},
  created_at: '2026-10-01T12:00:00.000Z', trial_ends_at: null, email: null, is_sandbox: false,
  billing_owner_company_id: null, asaas_subscription_id: null, cnpj: null, tax_regime: null,
  tx_count: 0, prod_count: 0, sales_count: 0, sale_count: 0, cust_count: 0, total_revenue: 0,
};
const EMPRESAS = [
  { ...base, id: LOJA, trade_name: 'Loja Varejo', plan: 'negocio', vertical: null, federation_id: null },
  { ...base, id: FEDERACAO, trade_name: 'Federação Cliente', plan: 'expansao', vertical: 'karate_federation', federation_id: null },
  { ...base, id: DOJO, trade_name: 'Dojô Filiado', plan: 'essencial', vertical: 'karate_dojo', federation_id: FEDERACAO },
  { ...base, id: DOJO_SOLTO, trade_name: 'Dojô Solto', plan: 'essencial', vertical: 'karate_dojo', federation_id: null },
];

const FRAGMENTO = /vertical IS DISTINCT FROM 'karate_dojo'/;
const FEDERACAO_FILTRO = /federation_id IS NULL OR (c\.)?federation_id = (c\.)?id/;

function universo(sql) {
  let lista = EMPRESAS;
  if (FRAGMENTO.test(sql)) lista = lista.filter((e) => e.vertical !== 'karate_dojo');
  if (FEDERACAO_FILTRO.test(sql)) lista = lista.filter((e) => !e.federation_id || e.federation_id === e.id);
  return lista;
}

const porPlano = (lista) => Object.values(lista.reduce((acc, e) => {
  const r = acc[e.plan] || (acc[e.plan] = { plan: e.plan, total: 0, paying: 0, trial: 0, overdue: 0, n: 0 });
  r.total += 1; r.n += 1; if (e.billing_status === 'active') r.paying += 1;
  return acc;
}, {}));

let consultas;
function responder(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ');
  consultas.push(s);
  // Uma empresa pelo id: nunca filtra (suporte abre o dojô pelo id).
  if (/FROM companies/.test(s) && /WHERE (c\.)?id ?= ?\$1/.test(s)) {
    return { rows: EMPRESAS.filter((e) => e.id === params[0]) };
  }
  if (/FROM users u WHERE/.test(s)) {
    // Donos: loja, federação e um dono só de dojô.
    return { rows: [{ n: s.includes('dojo_gestao') ? 2 : 3 }] };
  }
  if (!/FROM companies/.test(s) || /ANY\(\$1/.test(s)) return { rows: [] };
  const lista = universo(s);
  if (/GROUP BY plan/.test(s)) return { rows: porPlano(lista) };
  if (/^SELECT COUNT\(/.test(s)) return { rows: [{ total: lista.length, paying: lista.length, n: lista.length }] };
  return { rows: lista.map((e) => ({ ...e, company_id: e.id, nome: e.trade_name })) };
}

function makeApp(...routers) {
  const app = express();
  app.use(express.json());
  for (const r of routers) app.use('/admin', r);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
  return app;
}
const app = makeApp(
  require('../../src/routes/admin'),
  require('../../src/routes/adminClients360'),
  require('../../src/routes/adminOps'),
  require('../../src/routes/adminRevenue'),
  require('../../src/routes/adminGrowth'),
  require('../../src/routes/adminMetrics'),
);
const get = (url) => request(app).get('/admin' + url).set('Authorization', 'Bearer ' + staff);

beforeEach(() => {
  consultas = [];
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => responder(sql, params));
});

describe('utils/empresasDaGestao', () => {
  test('fragmento pelo tipo de conta, com e sem alias', () => {
    expect(gestao.semDojo()).toBe("vertical IS DISTINCT FROM 'karate_dojo'");
    expect(gestao.semDojo('c')).toBe("c.vertical IS DISTINCT FROM 'karate_dojo'");
  });

  test('alias ou coluna que não é identificador nunca vira SQL', () => {
    expect(() => gestao.semDojo("c; DROP TABLE companies")).toThrow();
    expect(() => gestao.companyIdSemDojo("x' OR '1'='1")).toThrow();
    expect(() => gestao.usuarioSemDojo('u u')).toThrow();
  });

  test('tabelas com company_id e usuários usam a mesma regra', () => {
    expect(gestao.companyIdSemDojo('s.company_id')).toMatch(/dojo_gestao\.id = s\.company_id/);
    expect(gestao.companyIdSemDojo('s.company_id')).toMatch(/vertical = 'karate_dojo'/);
    expect(gestao.usuarioSemDojo('u')).toMatch(/owner_id = u\.id/);
  });

  test('nenhum nome de federação no helper', () => {
    const fonte = require('fs').readFileSync(require.resolve('../../src/utils/empresasDaGestao'), 'utf8');
    expect(fonte).not.toMatch(/FPKT/i);
  });
});

describe('listas da Gestão Aura sem dojôs, com a federação', () => {
  test('GET /admin/clients', async () => {
    const res = await get('/clients');
    expect(res.status).toBe(200);
    const ids = res.body.clients.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([LOJA, FEDERACAO]));
    expect(ids).not.toContain(DOJO);
    expect(ids).not.toContain(DOJO_SOLTO);
    expect(res.body.total).toBe(2);
  });

  test('GET /admin/clients-360', async () => {
    const res = await get('/clients-360');
    expect(res.status).toBe(200);
    const ids = res.body.clients.map((c) => c.id);
    expect(ids.sort()).toEqual([LOJA, FEDERACAO].sort());
  });

  test('GET /admin/onboarding/pipeline (não tinha filtro nenhum)', async () => {
    const res = await get('/onboarding/pipeline');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    const ids = res.body.stages.flatMap((st) => st.clients.map((c) => c.id));
    expect(ids).not.toContain(DOJO);
    expect(ids).toContain(FEDERACAO);
  });
});

describe('contagens e métricas sem dojôs', () => {
  test('GET /admin/dashboard conta só loja e federação', async () => {
    const res = await get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.clients).toMatchObject({ total: 2, essencial: 0, negocio: 1, expansao: 1 });
  });

  test('GET /admin/metrics/unit-economics (pagantes e MRR não tinham filtro)', async () => {
    const res = await get('/metrics/unit-economics');
    expect(res.status).toBe(200);
    expect(res.body.paying_clients).toBe(2);
    expect(res.body.mrr).toBe(199 + 299);
    expect(res.body.cac.new_clients_3m).toBe(2);
  });

  test('GET /admin/metrics/mrr-waterfall e /forecast', async () => {
    const w = await get('/metrics/mrr-waterfall');
    expect(w.status).toBe(200);
    expect(w.body.current_mrr).toBe(199 + 299);
    const f = await get('/metrics/forecast');
    expect(f.body.current_mrr).toBe(199 + 299);
  });

  test('GET /admin/metrics/overview: clientes e uso agregado sem dojô', async () => {
    const res = await get('/metrics/overview');
    expect(res.status).toBe(200);
    expect(res.body.clients.total).toBe(2);
    const uso = consultas.find((s) => s.includes('AS total_products'));
    expect(uso).toBeDefined();
    // as quatro contagens de uso (transações, vendas, produtos, clientes)
    expect(uso.match(/dojo_gestao\.vertical = 'karate_dojo'/g)).toHaveLength(4);
  });

  test('GET /admin/metrics/funnel: cadastro só de dojô sai do funil', async () => {
    const res = await get('/metrics/funnel');
    expect(res.status).toBe(200);
    expect(res.body.funnel[0]).toMatchObject({ stage: 'Signup', count: 2 });
    expect(res.body.funnel[3]).toMatchObject({ stage: 'Pagante', count: 2 });
  });

  test('GET /admin/alerts: nenhuma consulta de empresa sem o filtro', async () => {
    const res = await get('/alerts');
    expect(res.status).toBe(200);
    const deEmpresas = consultas.filter((s) => /FROM (companies c|client_health_scores h)/.test(s));
    expect(deEmpresas.length).toBe(4);
    for (const s of deEmpresas) expect(s).toMatch(FRAGMENTO);
    expect(res.body.alerts.map((a) => a.company_id)).not.toContain(DOJO);
  });

  test('toda consulta de lista/contagem em companies destas rotas leva o filtro', async () => {
    for (const url of ['/clients', '/clients-360', '/dashboard', '/onboarding/pipeline',
      '/metrics/overview', '/metrics/unit-economics', '/metrics/mrr-waterfall', '/metrics/forecast',
      '/metrics/funnel', '/metrics/geography', '/metrics/verticals', '/metrics/feature-adoption', '/alerts']) {
      consultas = [];
      const res = await get(url);
      expect(res.status).toBe(200);
      // As subconsultas dos helpers (dojo_gestao/loja_gestao; pend_empresa da
      // conta pendente, tq-113) não contam.
      const semFiltro = consultas.filter((s) => /FROM companies/.test(s.replace(/FROM companies ((dojo|loja)_gestao|pend_empresa)/g, ''))
        && !/WHERE (c\.)?id ?= ?\$1/.test(s) && !/ANY\(\$1/.test(s) && !FRAGMENTO.test(s));
      expect({ url, semFiltro }).toEqual({ url, semFiltro: [] });
    }
  });
});

describe('busca direta por id continua abrindo o dojô (suporte)', () => {
  test('GET /admin/clients/:cid/modules de um dojô', async () => {
    const res = await get(`/clients/${DOJO}/modules`);
    expect(res.status).toBe(200);
    expect(res.body.company_id).toBe(DOJO);
    expect(res.body.company_name).toBe('Dojô Filiado');
  });

  test('listarClients360 por id devolve o dojô', async () => {
    const { listarClients360 } = require('../../src/services/clients360');
    const lista = await listarClients360({ companyId: DOJO });
    expect(lista.map((c) => c.id)).toEqual([DOJO]);
  });
});

describe('painel e MRR', () => {
  test('carregarEmpresas (universo do painel) pede o filtro e não traz dojô', async () => {
    const b = require('../../src/services/painelBlocos/_base');
    const emp = await b.carregarEmpresas(db);
    const sql = consultas.find((s) => s.includes('FROM companies c'));
    expect(sql).toMatch(FRAGMENTO);
    const ids = emp.lista.map((e) => e.company_id);
    expect(ids).toEqual(expect.arrayContaining([LOJA, FEDERACAO]));
    expect(ids).not.toContain(DOJO);
    expect(ids).not.toContain(DOJO_SOLTO);
  });

  test('fonteCompanies (MRR) pede o filtro', async () => {
    const { fonteCompanies } = require('../../src/services/receita');
    const linhas = await fonteCompanies({ db });
    expect(consultas.find((s) => s.includes('FROM companies c'))).toMatch(FRAGMENTO);
    expect(linhas.map((l) => l.company_id)).not.toContain(DOJO);
  });

  test('health score não é recalculado para dojô', async () => {
    const { recalculateAll } = require('../../src/services/healthScore');
    await recalculateAll({ db });
    expect(consultas.find((s) => s.includes('FROM companies c'))).toMatch(FRAGMENTO);
  });
});
