// ============================================================
// AURA. — Taxa da maquininha no Pix (09/11/2026)
//
// Decisao do Caio: campo novo "Pix pela maquininha %" (card_fee_pix_pct) em
// Configuracoes. Com a taxa ligada e o Pix > 0, TODA venda Pix paga a taxa,
// sem pergunta no Caixa (a venda nao sabe se o Pix passou pela maquininha).
// Na venda dividida, so a parte paga no Pix. Mesma categoria "Taxas de
// cartão" e mesma chave pdv-card-fee-<id>.
//
// O que este arquivo prova:
//   A. Pix com taxa: despesa com o valor certo, descricao citando o Pix.
//   B. Quem nao preencheu o Pix fica EXATAMENTE como antes (Pix sem taxa;
//      cartao com a mesma descricao e o mesmo objeto de retorno).
//   C. Venda dividida cartao + Pix: cada parte na sua aliquota.
//   D. Idempotencia: a chave e pdv-card-fee-<id> e a segunda gravacao nao
//      duplica a despesa.
//   E. pdv-settings: card_fee_pix_pct grava, default 0, teto 100.
// Mock do banco despachado por conteudo do SQL (padrao do pdv-connection).
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

const mockClient = { query: jest.fn(), release: jest.fn() };
db.connect = jest.fn().mockResolvedValue(mockClient);
db.query = jest.fn();

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const pdvRouter = require('../src/routes/pdv');
const { insertCardFeeExpense, CARD_FEE_KEY } = pdvRouter;
const settingsRouter = require('../src/routes/pdvSettings');

const app = express();
app.use(express.json());
app.use('/companies/:id/pdv', pdvRouter);

const CID = 'comp-1', PROD = 'prod-1', SALE = 'sale-1';

function despachar(pdvSettings, total) {
  mockClient.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/SELECT pdv_settings FROM companies/i.test(s)) {
      return Promise.resolve({ rows: [{ pdv_settings: { caixa_enabled: false, ...pdvSettings } }] });
    }
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM products p JOIN companies/i.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Batom', cost_price: 10, stock_qty: 50, stock_company_id: CID }] });
    }
    if (/INSERT INTO sales/i.test(s)) {
      return Promise.resolve({ rows: [{ id: SALE, total_amount: total, employee_id: null, customer_id: null }] });
    }
    return Promise.resolve({ rows: [] });
  });
  db.query.mockResolvedValue({ rows: [] });
}

const taxaInserida = () => mockClient.query.mock.calls.filter((c) =>
  /INSERT INTO transactions/i.test(String(c[0] || '')) && /'expense'/.test(String(c[0] || '')));

function vender(body) {
  return request(app).post(`/companies/${CID}/pdv/sale`).send({
    items: [{ product_id: PROD, quantity: 1, unit_price: 100 }],
    ...body,
  });
}

beforeEach(() => { jest.clearAllMocks(); mockClient.query.mockReset(); db.query.mockReset(); });

describe('A. Pix com taxa', () => {
  it('venda Pix com card_fee_pix_pct=0,99 lanca a despesa com o Pix na descricao', async () => {
    despachar({ card_fee_enabled: true, card_fee_credit_pct: 3, card_fee_debit_pct: 1, card_fee_pix_pct: 0.99 }, 100);

    const res = await vender({ payment_method: 'pix' });

    expect(res.status).toBe(201);
    const ins = taxaInserida();
    expect(ins).toHaveLength(1);
    const [sql, params] = ins[0];
    expect(sql).toMatch(/'Taxas de cartão'/);
    expect(sql).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
    expect(params[1]).toBe(0.99);
    expect(params[2]).toBe('Taxa da maquininha - Batom (pix 100.00 x 0.99%)');
    expect(params[4]).toBe('pdv-card-fee-' + SALE);
    expect(res.body.card_fee).toEqual({
      fee: 0.99, credit_pct: 3, debit_pct: 1, credit_base: 0, debit_base: 0, pix_pct: 0.99, pix_base: 100,
    });
  });

  it('Pix via lista de pagamentos tambem paga a taxa', async () => {
    despachar({ card_fee_enabled: true, card_fee_pix_pct: 1.5 }, 100);

    const res = await vender({ payment_method: 'pix', payments: [{ method: 'pix', value: 100 }] });

    expect(res.status).toBe(201);
    const ins = taxaInserida();
    expect(ins).toHaveLength(1);
    expect(ins[0][1][1]).toBe(1.5);
  });

  it('taxa desligada: Pix preenchido nao gera despesa', async () => {
    despachar({ card_fee_enabled: false, card_fee_pix_pct: 0.99 }, 100);

    const res = await vender({ payment_method: 'pix' });

    expect(res.status).toBe(201);
    expect(taxaInserida()).toHaveLength(0);
    expect(res.body.card_fee).toBeNull();
  });
});

describe('B. Sem o Pix preenchido, tudo igual a antes', () => {
  it.each([
    ['ausente', {}],
    ['zero', { card_fee_pix_pct: 0 }],
  ])('Pix %s: venda Pix nao gera despesa', async (_nome, extra) => {
    despachar({ card_fee_enabled: true, card_fee_credit_pct: 3, card_fee_debit_pct: 1, ...extra }, 100);

    const res = await vender({ payment_method: 'pix' });

    expect(res.status).toBe(201);
    expect(taxaInserida()).toHaveLength(0);
    expect(res.body.card_fee).toBeNull();
  });

  it('venda dividida cartao + Pix sem Pix preenchido: so o cartao paga, descricao e retorno de antes', async () => {
    despachar({ card_fee_enabled: true, card_fee_credit_pct: 3, card_fee_debit_pct: 1 }, 100);

    const res = await vender({
      payment_method: 'cartao',
      payments: [{ method: 'cartao', value: 60 }, { method: 'pix', value: 40 }],
    });

    expect(res.status).toBe(201);
    const ins = taxaInserida();
    expect(ins).toHaveLength(1);
    expect(ins[0][1][1]).toBe(1.8);
    expect(ins[0][1][2]).toBe('Taxa da maquininha - Batom (credito 60.00 x 3%)');
    // Mesmo objeto de antes: nenhuma chave do Pix.
    expect(res.body.card_fee).toEqual({ fee: 1.8, credit_pct: 3, debit_pct: 1, credit_base: 60, debit_base: 0 });
  });

  it('debito sozinho sem Pix preenchido: igual a antes', async () => {
    despachar({ card_fee_enabled: true, card_fee_credit_pct: 3, card_fee_debit_pct: 1 }, 100);

    const res = await vender({ payment_method: 'debito' });

    expect(res.status).toBe(201);
    expect(taxaInserida()[0][1].slice(1, 3)).toEqual([1, 'Taxa da maquininha - Batom (debito 100.00 x 1%)']);
  });
});

describe('C. Venda dividida cartao + Pix', () => {
  it('cada parte na sua aliquota; dinheiro fica de fora', async () => {
    despachar({ card_fee_enabled: true, card_fee_credit_pct: 3, card_fee_debit_pct: 1, card_fee_pix_pct: 0.99 }, 100);

    const res = await vender({
      payment_method: 'cartao',
      payments: [{ method: 'cartao', value: 50 }, { method: 'pix', value: 30 }, { method: 'dinheiro', value: 20 }],
    });

    expect(res.status).toBe(201);
    const ins = taxaInserida();
    expect(ins).toHaveLength(1);
    // 50 x 3% + 30 x 0,99% = 1,50 + 0,297 = 1,797 -> 1,80
    expect(ins[0][1][1]).toBe(1.8);
    expect(ins[0][1][2]).toBe('Taxa da maquininha - Batom (credito 50.00 x 3% + pix 30.00 x 0.99%)');
    expect(res.body.card_fee).toMatchObject({ credit_base: 50, pix_base: 30, pix_pct: 0.99 });
  });

  it('Pix + crediario: so a parte no Pix paga', async () => {
    const r = await insertCardFeeExpense(
      { query: jest.fn(async (sql) => (/SELECT pdv_settings/.test(sql)
        ? { rows: [{ pdv_settings: { card_fee_enabled: true, card_fee_pix_pct: 2 } }] }
        : { rows: [] })) },
      { companyId: CID, saleId: SALE, cardBase: { cartao: 0, debito: 0, pix: 25 }, itemsSummary: 'Batom' },
    );
    expect(r.fee).toBe(0.5);
  });
});

describe('D. Idempotencia da chave', () => {
  it('a chave e pdv-card-fee-<id> e gravar duas vezes nao duplica', async () => {
    expect(CARD_FEE_KEY('abc')).toBe('pdv-card-fee-abc');

    // Banco falso com o unique de transactions.idempotency_key.
    const linhas = new Map();
    const client = {
      query: jest.fn(async (sql, params) => {
        if (/SELECT pdv_settings/.test(sql)) {
          return { rows: [{ pdv_settings: { card_fee_enabled: true, card_fee_pix_pct: 0.99 } }] };
        }
        if (/INSERT INTO transactions/.test(sql)) {
          expect(sql).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/);
          const key = params[4];
          if (!linhas.has(key)) linhas.set(key, { amount: params[1], description: params[2] });
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const args = { companyId: CID, saleId: SALE, cardBase: { pix: 100 }, itemsSummary: 'Batom' };
    await insertCardFeeExpense(client, args);
    await insertCardFeeExpense(client, args);

    expect(linhas.size).toBe(1);
    expect(linhas.get('pdv-card-fee-' + SALE)).toEqual({ amount: 0.99, description: 'Taxa da maquininha - Batom (pix 100.00 x 0.99%)' });
  });
});

describe('E. pdv-settings: card_fee_pix_pct', () => {
  const COMPANY = '45d92b02-165d-44d6-928a-ac8e0183d5bd';
  function makeApp() {
    const a = express();
    a.use(express.json());
    a.use('/companies/:id', settingsRouter);
    // eslint-disable-next-line no-unused-vars
    a.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
    return a;
  }
  function mockCompany(pdv_settings) {
    const state = { pdv_settings, updates: [] };
    db.query.mockImplementation(async (sql, params) => {
      if (/^\s*SELECT/i.test(sql)) {
        const out = {};
        if (/pdv_settings/.test(sql)) out.pdv_settings = state.pdv_settings;
        if (/vertical_active/.test(sql)) out.vertical_active = null;
        return { rows: [out] };
      }
      if (/^\s*UPDATE companies SET pdv_settings/i.test(sql)) {
        state.pdv_settings = JSON.parse(params[0]);
        state.updates.push(state.pdv_settings);
        return { rows: [], rowCount: 1 };
      }
      throw new Error('SQL inesperado no teste: ' + sql);
    });
    return state;
  }

  it('sem a chave salva, o GET devolve 0', async () => {
    mockCompany({ card_fee_enabled: true, card_fee_credit_pct: 3 });
    const get = await request(makeApp()).get('/companies/' + COMPANY + '/pdv-settings');
    expect(get.status).toBe(200);
    expect(get.body.settings.card_fee_pix_pct).toBe(0);
  });

  it('PUT grava o percentual e nao mexe no credito/debito', async () => {
    const state = mockCompany({ card_fee_enabled: true, card_fee_credit_pct: 3, card_fee_debit_pct: 1 });
    const put = await request(makeApp())
      .put('/companies/' + COMPANY + '/pdv-settings')
      .send({ settings: { card_fee_pix_pct: 0.99 } });
    expect(put.status).toBe(200);
    expect(state.updates[0]).toMatchObject({ card_fee_pix_pct: 0.99, card_fee_credit_pct: 3, card_fee_debit_pct: 1 });
  });

  it.each([[101], [-1], ['abc']])('PUT com %p leva 400 e nao grava', async (v) => {
    const state = mockCompany({});
    const put = await request(makeApp())
      .put('/companies/' + COMPANY + '/pdv-settings')
      .send({ settings: { card_fee_pix_pct: v } });
    expect(put.status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });

  it('PUT com 100 e com 0 passa', async () => {
    for (const v of [100, 0]) {
      const state = mockCompany({});
      const put = await request(makeApp())
        .put('/companies/' + COMPANY + '/pdv-settings')
        .send({ settings: { card_fee_pix_pct: v } });
      expect(put.status).toBe(200);
      expect(state.updates[0].card_fee_pix_pct).toBe(v);
    }
  });
});
