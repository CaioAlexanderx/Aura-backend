// ============================================================
// Conta pendente fora da Gestão Aura e da régua (tq-113, 26/10/2026)
//
// Decisão do Caio (opção B): a conta continua nascendo antes da confirmação
// do e-mail, mas enquanto o dono não confirma ela não é cliente: sai das
// listas, contagens, funis, alertas e métricas das rotas /admin/*, do
// universo do painel, da receita e dos e-mails. A busca por id continua
// abrindo a empresa (suporte).
//
// Banco de mentira (mesma ideia de adminSemDojos.test.js): só esconde a
// empresa pendente quando o SQL da rota traz o fragmento da definição única
// (utils/contaPendente.js). Assim a rota só "esconde" se a consulta pedir.
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
const cp = require('../../src/utils/contaPendente');

const SECRET = 'aura-test-secret-2026';
const staff = jwt.sign({ id: 'bbbbbbbb-0000-4000-8000-000000000001', role: 'admin' }, SECRET);

const LOJA = '11111111-0000-4000-8000-000000000001';
const PENDENTE = '55555555-0000-4000-8000-000000000005';

const base = {
  is_active: true, billing_status: 'trial', billing_cycle: 'monthly', module_overrides: {},
  created_at: '2026-10-01T12:00:00.000Z', trial_ends_at: '2026-12-01T12:00:00.000Z', email: null,
  is_sandbox: false, billing_owner_company_id: null, asaas_subscription_id: null, cnpj: null,
  tax_regime: null, tx_count: 0, prod_count: 0, sales_count: 0, sale_count: 0, cust_count: 0,
  total_revenue: 0, vertical: null, federation_id: null,
};
const EMPRESAS = [
  { ...base, id: LOJA, trade_name: 'Loja Confirmada', plan: 'negocio', pendente: false },
  { ...base, id: PENDENTE, trade_name: 'Loja Pendente', plan: 'essencial', pendente: true },
];

const FRAGMENTO = /pend_dono\.email_verified IS NOT TRUE/;

let consultas;
function responder(sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ');
  consultas.push(s);
  if (/FROM companies/.test(s) && /WHERE (c\.)?id ?= ?\$1/.test(s)) {
    return { rows: EMPRESAS.filter((e) => e.id === params[0]) };
  }
  if (/FROM users u WHERE/.test(s)) {
    return { rows: [{ n: s.includes('pend_empresa') ? 1 : 2 }] };
  }
  if (!/FROM companies/.test(s) || /ANY\(\$1/.test(s)) return { rows: [] };
  const lista = FRAGMENTO.test(s) ? EMPRESAS.filter((e) => !e.pendente) : EMPRESAS;
  if (/GROUP BY plan/.test(s)) {
    return {
      rows: Object.values(lista.reduce((acc, e) => {
        const r = acc[e.plan] || (acc[e.plan] = { plan: e.plan, total: 0, paying: 0, n: 0 });
        r.total += 1; r.n += 1;
        return acc;
      }, {})),
    };
  }
  if (/^SELECT COUNT\(/.test(s)) return { rows: [{ total: lista.length, paying: 0, n: lista.length }] };
  return { rows: lista.map((e) => ({ ...e, company_id: e.id, nome: e.trade_name, status: e.billing_status })) };
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

describe('utils/contaPendente: a definição única', () => {
  test('fragmento: dono não confirmado, sem staff, fora interna e sandbox', () => {
    const f = cp.sqlContaPendente('c');
    expect(f).toMatch(/c\.is_sandbox IS NOT TRUE/);
    expect(f).toMatch(/lower\(COALESCE\(c\.email, ''\)\) NOT LIKE '%@getaura\.com\.br'/);
    expect(f).toMatch(/pend_dono\.id = c\.owner_id/);
    expect(f).toMatch(/pend_dono\.email_verified IS NOT TRUE/);
    expect(f).toMatch(/pend_dono\.is_staff IS NOT TRUE/);
    expect(f).toMatch(/lower\(COALESCE\(pend_dono\.email, ''\)\) NOT LIKE '%@getaura\.com\.br'/);
    expect(cp.semPendente('c')).toBe(`NOT ${f}`);
    // sem alias: a tabela pelo nome (consultas `FROM companies` sem alias)
    expect(cp.semPendente()).toMatch(/pend_dono\.id = companies\.owner_id/);
    expect(cp.companyIdSemPendente('s.company_id')).toMatch(/pend_empresa\.id = s\.company_id/);
    expect(cp.usuarioPendente('u')).toMatch(/pend_empresa\.owner_id = u\.id/);
  });

  test('alias ou coluna que não é identificador nunca vira SQL', () => {
    expect(() => cp.sqlContaPendente("c; DROP TABLE companies")).toThrow();
    expect(() => cp.companyIdSemPendente("x' OR '1'='1")).toThrow();
    expect(() => cp.usuarioSemPendente('u u')).toThrow();
  });

  test('a mesma regra em JS', () => {
    const p = { email_verified: false, is_staff: false, is_sandbox: false, owner_email: 'a@b.com', company_email: null };
    expect(cp.ehContaPendente(p)).toBe(true);
    expect(cp.ehContaPendente({ ...p, email_verified: null })).toBe(true);
    expect(cp.ehContaPendente({ ...p, email_verified: true })).toBe(false);
    expect(cp.ehContaPendente({ ...p, is_staff: true })).toBe(false);
    expect(cp.ehContaPendente({ ...p, is_sandbox: true })).toBe(false);
    expect(cp.ehContaPendente({ ...p, owner_email: 'x@getaura.com.br' })).toBe(false);
    expect(cp.ehContaPendente({ ...p, company_email: 'LOJA@GETAURA.COM.BR' })).toBe(false);
    expect(cp.ehContaPendente({ ...p, tem_dono: false })).toBe(false);
  });
});

describe('listas e contagens da Gestão Aura sem a conta pendente', () => {
  test('GET /admin/clients, /clients-360 e /onboarding/pipeline', async () => {
    const a = await get('/clients');
    expect(a.status).toBe(200);
    expect(a.body.clients.map((c) => c.id)).toEqual([LOJA]);
    const b = await get('/clients-360');
    expect(b.status).toBe(200);
    expect(b.body.clients.map((c) => c.id)).toEqual([LOJA]);
    const c = await get('/onboarding/pipeline');
    expect(c.status).toBe(200);
    expect(c.body.total).toBe(1);
  });

  test('GET /admin/dashboard e /metrics/funnel (cadastro pendente não é signup)', async () => {
    const d = await get('/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.clients).toMatchObject({ total: 1, essencial: 0, negocio: 1 });
    const f = await get('/metrics/funnel');
    expect(f.status).toBe(200);
    expect(f.body.funnel[0]).toMatchObject({ stage: 'Signup', count: 1 });
  });

  test('toda consulta de lista/contagem em companies das rotas leva o filtro', async () => {
    for (const url of ['/clients', '/clients-360', '/dashboard', '/onboarding/pipeline',
      '/metrics/overview', '/metrics/unit-economics', '/metrics/mrr-waterfall', '/metrics/forecast',
      '/metrics/funnel', '/metrics/geography', '/metrics/verticals', '/metrics/feature-adoption', '/alerts']) {
      consultas = [];
      const res = await get(url);
      expect(res.status).toBe(200);
      const semFiltro = consultas.filter((s) => /FROM companies/.test(s.replace(/FROM companies ((dojo|loja)_gestao|pend_empresa)/g, ''))
        && !/WHERE (c\.)?id ?= ?\$1/.test(s) && !/ANY\(\$1/.test(s) && !FRAGMENTO.test(s));
      expect({ url, semFiltro }).toEqual({ url, semFiltro: [] });
    }
  });

  test('uso agregado (transações, vendas, produtos, clientes) sem a pendente', async () => {
    await get('/metrics/overview');
    const uso = consultas.find((s) => s.includes('AS total_products'));
    expect(uso.match(/pend_empresa\.id = company_id/g)).toHaveLength(4);
  });

  test('busca por id continua abrindo a empresa pendente (suporte)', async () => {
    const res = await get(`/clients/${PENDENTE}/modules`);
    expect(res.status).toBe(200);
    expect(res.body.company_id).toBe(PENDENTE);
  });
});

describe('painel, receita, health score, relatório e régua', () => {
  test('universo do painel (SEM_INTERNAS) sem a pendente', async () => {
    const b = require('../../src/services/painelBlocos/_base');
    expect(b.SEM_INTERNAS).toContain(cp.semPendente('c'));
    const emp = await b.carregarEmpresas(db);
    expect(emp.lista.map((e) => e.company_id)).toEqual([LOJA]);
  });

  test('MRR (fonteCompanies) e health score pedem o filtro', async () => {
    const { fonteCompanies } = require('../../src/services/receita');
    await fonteCompanies({ db });
    expect(consultas.find((s) => s.includes('FROM companies c'))).toMatch(FRAGMENTO);
    consultas = [];
    const { recalculateAll } = require('../../src/services/healthScore');
    await recalculateAll({ db });
    expect(consultas.find((s) => s.includes('FROM companies c'))).toMatch(FRAGMENTO);
  });

  test('relatório semanal: a consulta de quem recebe leva o filtro', async () => {
    const { empresasElegiveis } = require('../../src/jobs/reportScheduler');
    await empresasElegiveis({ env: {} });
    expect(consultas.find((s) => s.includes('FROM companies c'))).toMatch(FRAGMENTO);
  });

  test('ciclo do teste (relacionamento): todas as consultas de envio levam o filtro', () => {
    const r = require('../../src/services/relacionamento');
    for (const nome of ['SQL_SEM_VENDA', 'SQL_TERMINANDO', 'SQL_ENCERRADO', 'SQL_CONTA_GUARDADA', 'SQL_SUMIU']) {
      expect({ nome, ok: FRAGMENTO.test(r[nome]) }).toEqual({ nome, ok: true });
    }
  });

  test('cobrança: dono pendente não recebe e-mail; confirmado recebe', async () => {
    const { destinatarioDaEmpresa } = require('../../src/services/cobrancaAssinatura');
    const linha = {
      id: LOJA, loja: 'Loja', company_email: null, is_active: true, is_sandbox: false,
      vertical: null, vertical_active: null, user_id: 'u1', user_email: 'dona@loja.com',
      full_name: 'Maria Silva', is_staff: false,
    };
    db.query.mockResolvedValueOnce({ rows: [{ ...linha, email_verified: false }] });
    expect(await destinatarioDaEmpresa(db, LOJA)).toBeNull();
    db.query.mockResolvedValueOnce({ rows: [{ ...linha, email_verified: true }] });
    expect(await destinatarioDaEmpresa(db, LOJA)).toMatchObject({ email: 'dona@loja.com' });
  });
});
