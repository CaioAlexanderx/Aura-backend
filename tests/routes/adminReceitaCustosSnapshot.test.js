// ============================================================
// Receita e Financeiro da Gestão Aura leem os custos do snapshot (card t2-21).
//
//   GET /admin/dashboard                  (routes/admin)
//   GET /admin/metrics/overview           (routes/adminMetrics)
//   GET /admin/metrics/unit-economics     (routes/adminRevenue)
//
// Antes, as três somavam aura_operational_costs (4 linhas, todas de abril):
// outubro dava custo R$ 0 e margem = MRR. Agora a fonte é a linha do mês em
// aura_revenue_snapshot, a mesma do bloco Custos do painel. Mês sem custo
// lançado é null ("sem custo lançado"), nunca 0. Banco em memória: nenhum dado
// de cliente real, nada vai ao banco de produção.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const custos = require('../../src/services/custosMensais');

const staff = jwt.sign({ id: 'bbbbbbbb-0000-4000-8000-000000000001', role: 'admin' }, 'aura-test-secret-2026');
// 18/10/2026 12:00 em Brasília.
const AGORA = new Date('2026-10-18T15:00:00.000Z');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', require('../../src/routes/admin'));
  app.use('/admin', require('../../src/routes/adminMetrics'));
  app.use('/admin', require('../../src/routes/adminRevenue'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const get = (url) => request(makeApp()).get('/admin' + url).set('Authorization', 'Bearer ' + staff);

const linha = (mes, extra = {}) => ({
  mes, mrr_total: 0, total_costs: 0, gross_margin: 0, taxas_asaas: null, das: null, custos_detalhe: null, updated_at: null, ...extra,
});
const item = (valor, origem = 'empresa') => ({ valor, origem });

// Banco que responde só ao que as três rotas perguntam. aura_operational_costs
// LANÇA: se alguma rota voltar a ler a tabela velha, o teste cai.
function criarBanco({ snapshot = [], erroCustos = null } = {}) {
  const sqls = [];
  db.query.mockImplementation(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    sqls.push(s);
    if (s.includes('aura_operational_costs')) throw new Error('leu a tabela velha: ' + s.slice(0, 80));
    if (s.includes('-- custos:mes')) {
      if (erroCustos) throw Object.assign(new Error('falha simulada'), { code: erroCustos });
      const l = snapshot.find((x) => `${x.mes}-01` === String(params[0]).slice(0, 10));
      return { rows: l ? [l] : [] };
    }
    if (s.includes('-- custos:snapshot')) {
      if (erroCustos) throw Object.assign(new Error('falha simulada'), { code: erroCustos });
      const ate = String(params[0]).slice(0, 7);
      return { rows: snapshot.filter((x) => x.mes <= ate).sort((a, b) => b.mes.localeCompare(a.mes)).slice(0, params[1]) };
    }
    if (s.includes('SELECT * FROM aura_revenue_snapshot ORDER BY reference_month DESC LIMIT 1')) {
      return { rows: snapshot.length ? [{ mrr_total: snapshot[snapshot.length - 1].mrr_total }] : [] };
    }
    if (s.includes('SELECT mrr_total FROM aura_revenue_snapshot')) return { rows: [{ mrr_total: 1000 }] };
    if (s.startsWith('SELECT plan, COUNT(*) AS total,')) return { rows: [{ plan: 'negocio', total: '3', paying: '2', trial: '1', overdue: '0' }] };
    if (s.startsWith('SELECT plan, COUNT(*) AS total FROM companies')) return { rows: [{ plan: 'negocio', total: '3' }, { plan: 'essencial', total: '2' }] };
    if (s.startsWith('SELECT plan, COUNT(*) AS n FROM companies')) return { rows: [{ plan: 'negocio', n: '2' }] };
    if (s.startsWith('SELECT COUNT(*) AS paying FROM companies')) return { rows: [{ paying: '2' }] };
    if (s.includes('FROM churn_events') && s.includes('mrr_lost')) return { rows: [{ total: '0', mrr_lost: '0' }] };
    if (s.includes('FROM churn_events')) return { rows: [{ total: '3' }] };
    if (s.includes('aura_monthly_goals')) return { rows: [] };
    if (s.startsWith('SELECT COUNT(*) AS total FROM companies')) return { rows: [{ total: '4' }] };
    if (s.includes('AS tx_month')) return { rows: [{ tx_month: '0', sales_month: '0', total_products: '0', total_customers: '0' }] };
    throw new Error('SQL inesperado: ' + s.slice(0, 140));
  });
  return sqls;
}

// Outubro com custo lançado: R$ 2.150,50 e receita do snapshot R$ 4.000.
const OUTUBRO = linha('2026-10', {
  mrr_total: 4000, total_costs: 2150.5, taxas_asaas: 120.25, das: 300,
  custos_detalhe: { infraestrutura: item(500), anthropic: item(1200, 'socio'), meta: item(450.5) },
});

beforeAll(() => {
  jest.useFakeTimers({ now: AGORA, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
beforeEach(() => db.query.mockReset());

describe('GET /admin/dashboard', () => {
  test('mês com custo lançado: custo e margem vêm do snapshot, com os campos antigos', async () => {
    const sqls = criarBanco({ snapshot: [OUTUBRO] });
    const r = await get('/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.costs.current_month).toBe(2150.5);
    expect(r.body.costs).toMatchObject({ mes: '2026-10', lancado: true, rotulo: null, fonte: 'aura_revenue_snapshot', taxas_asaas: 120.25, das: 300, das_rotulo: 'DAS pago (do snapshot)' });
    expect(r.body.costs.das_obs).toMatch(/mês anterior/);
    // margem = receita do snapshot (4000) - custos
    expect(r.body.gross_margin.estimated).toBe(1849.5);
    expect(r.body.gross_margin.margin_pct).toBe(46);
    expect(r.body.gross_margin).toMatchObject({ base: 'receita do snapshot', receita: 4000, receita_obs: null });
    // campos antigos continuam
    expect(r.body.clients).toEqual({ total: 5, essencial: 2, negocio: 3, expansao: 0 });
    expect(r.body.mrr.estimated).toBe(2 * 99 + 3 * 179);
    expect(r.body.mrr).toHaveProperty('last_snapshot');
    expect(r.body).toHaveProperty('reference_date');
    expect(sqls.some((q) => q.includes('aura_operational_costs'))).toBe(false);
  });

  test('outubro sem custo lançado: null e "sem custo lançado", nunca R$ 0 nem margem = MRR', async () => {
    criarBanco({ snapshot: [linha('2026-09', { mrr_total: 3000, total_costs: 1000 }), linha('2026-10', { mrr_total: 4000 })] });
    const r = await get('/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.costs.current_month).toBeNull();
    expect(r.body.costs).toMatchObject({ lancado: false, rotulo: 'sem custo lançado', mes: '2026-10' });
    expect(r.body.gross_margin.estimated).toBeNull();
    expect(r.body.gross_margin.margin_pct).toBeNull();
  });

  test('sem linha do mês no snapshot: também null', async () => {
    criarBanco({ snapshot: [linha('2026-09', { mrr_total: 3000, total_costs: 1000 })] });
    const r = await get('/dashboard');
    expect(r.body.costs.current_month).toBeNull();
    expect(r.body.costs.lancado).toBe(false);
    expect(r.body.gross_margin.estimated).toBeNull();
  });

  test('mês só com total digitado (sem abertura) conta como lançado', async () => {
    criarBanco({ snapshot: [linha('2026-10', { mrr_total: 1000, total_costs: 250 })] });
    const r = await get('/dashboard');
    expect(r.body.costs.current_month).toBe(250);
    expect(r.body.gross_margin.estimated).toBe(750);
    expect(r.body.gross_margin.margin_pct).toBe(75);
  });

  test('deploy antes da migration 382 (coluna ausente): null, sem derrubar a rota', async () => {
    criarBanco({ snapshot: [OUTUBRO], erroCustos: '42703' });
    const r = await get('/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.costs.current_month).toBeNull();
    expect(r.body.costs.lancado).toBe(false);
  });

  test('erro de banco que não é a migration ausente continua sendo erro', async () => {
    criarBanco({ snapshot: [OUTUBRO], erroCustos: '57014' });
    const r = await get('/dashboard');
    expect(r.status).toBe(500);
  });
});

describe('GET /admin/metrics/overview', () => {
  test('custo e margem do snapshot; campos antigos preservados', async () => {
    const sqls = criarBanco({ snapshot: [OUTUBRO] });
    const r = await get('/metrics/overview');
    expect(r.status).toBe(200);
    expect(r.body.costs).toMatchObject({ current_month: 2150.5, lancado: true, mes: '2026-10', rotulo: null });
    expect(r.body.margin).toMatchObject({ gross: 1849.5, pct: 46, base: 'receita do snapshot', receita: 4000 });
    expect(r.body.mrr).toHaveProperty('total');
    expect(r.body.clients).toHaveProperty('paying');
    expect(r.body).toHaveProperty('arpu');
    expect(sqls.some((q) => q.includes('aura_operational_costs'))).toBe(false);
  });

  test('sem custo lançado: null (o app lê margin.pct e costs.current_month)', async () => {
    criarBanco({ snapshot: [linha('2026-10', { mrr_total: 4000 })] });
    const r = await get('/metrics/overview');
    expect(r.body.costs.current_month).toBeNull();
    expect(r.body.costs.rotulo).toBe('sem custo lançado');
    expect(r.body.margin.gross).toBeNull();
    expect(r.body.margin.pct).toBeNull();
  });
});

describe('GET /admin/metrics/unit-economics', () => {
  test('custos por categoria e margem do snapshot, com rótulo da categoria', async () => {
    const sqls = criarBanco({ snapshot: [OUTUBRO] });
    const r = await get('/metrics/unit-economics');
    expect(r.status).toBe(200);
    expect(r.body.costs.total).toBe(2150.5);
    // ordenado do maior para o menor; category continua sendo o campo antigo
    expect(r.body.costs.breakdown).toEqual([
      { category: 'anthropic', label: 'Anthropic', amount: 1200 },
      { category: 'infraestrutura', label: 'Infraestrutura', amount: 500 },
      { category: 'meta', label: 'Meta', amount: 450.5 },
    ]);
    expect(r.body.costs).toMatchObject({ lancado: true, mes: '2026-10', das: 300, das_rotulo: 'DAS pago (do snapshot)' });
    expect(r.body.margin).toMatchObject({ gross: 1849.5, pct: 46, base: 'receita do snapshot', receita: 4000 });
    // formato antigo
    expect(r.body).toEqual(expect.objectContaining({ paying_clients: 2, mrr: 2 * 199 }));
    expect(r.body.ltv).toHaveProperty('value');
    expect(sqls.some((q) => q.includes('aura_operational_costs'))).toBe(false);
  });

  test('sem custo lançado: total, margem e breakdown vazios; nada de R$ 0', async () => {
    criarBanco({ snapshot: [linha('2026-10', { mrr_total: 4000 })] });
    const r = await get('/metrics/unit-economics');
    expect(r.body.costs.total).toBeNull();
    expect(r.body.costs.breakdown).toEqual([]);
    expect(r.body.costs).toMatchObject({ lancado: false, rotulo: 'sem custo lançado' });
    expect(r.body.margin.gross).toBeNull();
    expect(r.body.margin.pct).toBeNull();
  });

  test('CAC: anúncios (Meta) dos meses lançados e abertos; mês com "demais" não entra', async () => {
    criarBanco({
      snapshot: [
        linha('2026-08', { total_costs: 900, custos_detalhe: { demais: item(900) } }),
        linha('2026-09', { total_costs: 1000, custos_detalhe: { infraestrutura: item(600), meta: item(400) } }),
        OUTUBRO,
      ],
    });
    const r = await get('/metrics/unit-economics');
    // set (400) + out (450,5) = 850,5 sobre 4 clientes novos
    expect(r.body.cac.marketing_spend_3m).toBe(850.5);
    expect(r.body.cac.value).toBe(212.63);
    expect(r.body.cac).toMatchObject({ new_clients_3m: 4, marketing_meses_lancados: 3, marketing_meses_com_abertura: 2 });
    expect(r.body.ltv_cac_ratio).not.toBeNull();
  });

  test('CAC sem nenhum mês lançado e aberto: null, não R$ 0', async () => {
    criarBanco({ snapshot: [linha('2026-10', { mrr_total: 4000 })] });
    const r = await get('/metrics/unit-economics');
    expect(r.body.cac.value).toBeNull();
    expect(r.body.cac.marketing_spend_3m).toBeNull();
    expect(r.body.ltv_cac_ratio).toBeNull();
  });

  test('deploy antes da migration 382: tudo null, rota responde', async () => {
    criarBanco({ snapshot: [OUTUBRO], erroCustos: '42P01' });
    const r = await get('/metrics/unit-economics');
    expect(r.status).toBe(200);
    expect(r.body.costs.total).toBeNull();
    expect(r.body.cac.value).toBeNull();
  });
});

describe('custoDoMes: receita antes de outubro', () => {
  test('mês anterior a 2026-10 avisa que a receita do snapshot é cobrança, não MRR contratual', async () => {
    criarBanco({ snapshot: [linha('2026-07', { mrr_total: 2000, total_costs: 500 })] });
    const r = await custos.custoDoMes({ db, hoje: '2026-07-15' });
    expect(r.receita_obs).toMatch(/cobrança/);
    expect(r.margem).toBe(1500);
  });
});
