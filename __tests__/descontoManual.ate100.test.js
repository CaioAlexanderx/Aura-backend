// ============================================================
// Desconto manual do Caixa ate 100% (12/11/2026)
// src/services/descontoManual.js + POST /pdv/sale (src/routes/pdv.js)
//
// Relato de loja: "quando e colocado o valor do desconto manual, a soma nao
// da certo". O app cortava o desconto em 50% sem avisar. O teto passa a ser
// o total (100%), com confirmacao no app acima de 50%. Aqui trava:
//   A. % de 0 a 100 (acima de 100 = erro, como antes);
//   B. R$ maior que o subtotal vira o subtotal;
//   C. arredondamento ao centavo: centavos inteiros, meio centavo para cima,
//      sem erro de ponto flutuante — a MESMA tabela do app
//      (aura-app __tests__/descontoManual.test.ts);
//   D. venda com 80% de desconto grava total e desconto certos; R$ acima do
//      total grava total 0; cupom + manual continuam somando com teto.
// ============================================================
'use strict';

const {
  resolveManualDiscount, paraCentavos, aoCentavo, descontoPercentual, descontoEmReais,
} = require('../src/services/descontoManual');

describe('A. desconto em % de 0 a 100', () => {
  test.each([
    [0, 0], [10, 13.99], [50, 69.95], [80, 111.92], [100, 139.9],
  ])('%s%% de R$ 139,90 = R$ %s', (pct, esperado) => {
    expect(resolveManualDiscount({ discount_type: 'percent', discount_value: pct }, 139.9)).toEqual({ amount: esperado });
  });

  test('acima de 100% continua erro (o app limita a 100 antes de mandar)', () => {
    expect(resolveManualDiscount({ discount_type: 'percent', discount_value: 100.01 }, 100).error).toMatch(/100%/);
    expect(resolveManualDiscount({ discount_pct: 101 }, 100).error).toMatch(/100%/);
  });

  test('negativo ou invalido continua erro', () => {
    expect(resolveManualDiscount({ discount_type: 'percent', discount_value: -1 }, 100).error).toBeTruthy();
    expect(resolveManualDiscount({ discount_type: 'fixed', discount_value: 'abc' }, 100).error).toBeTruthy();
    expect(resolveManualDiscount({ discount_type: 'percent' }, 100).error).toBeTruthy();
  });
});

describe('B. desconto em R$', () => {
  test('R$ 80 numa peca de R$ 139,90 vale R$ 80 (nao mais R$ 69,95)', () => {
    expect(resolveManualDiscount({ discount_type: 'fixed', discount_value: 80 }, 139.9)).toEqual({ amount: 80 });
  });

  test('maior que o subtotal vira o subtotal (100%)', () => {
    expect(resolveManualDiscount({ discount_type: 'fixed', discount_value: 200 }, 139.9)).toEqual({ amount: 139.9 });
    expect(resolveManualDiscount({ discount_amount: 999 }, 49.9)).toEqual({ amount: 49.9 });
  });

  test('arredonda ao centavo, meio para cima', () => {
    expect(descontoEmReais(100, 10.005)).toBe(10.01);
    expect(descontoEmReais(100, 1.005)).toBe(1.01);
    expect(descontoEmReais(100, 10.004)).toBe(10);
  });
});

// Tabela compartilhada com o app (mesmos numeros em
// aura-app __tests__/descontoManual.test.ts): [subtotal, pct, desconto].
const TABELA_PCT = [
  [10.05, 10, 1.01],     // meio centavo: 1,005 -> 1,01 (total 9,04)
  [1.15, 10, 0.12],      // 0,115 -> 0,12 (o float antigo dava 0,11)
  [0.05, 10, 0.01],      // 0,005 -> 0,01
  [0.04, 10, 0],         // 0,004 -> 0,00
  [139.9, 50, 69.95],
  [139.9, 80, 111.92],
  [149.9, 80, 119.92],
  [99.99, 33.33, 33.33], // 33,326667 -> 33,33
  [19.9, 12.5, 2.49],    // 2,4875 -> 2,49
  [1234.57, 7.5, 92.59], // 92,59275 -> 92,59
  [0.01, 50, 0.01],      // 0,005 -> 0,01
  [100, 100, 100],
  [100, 0, 0],
];

describe('C. arredondamento ao centavo (tabela comum com o app)', () => {
  test.each(TABELA_PCT)('%s x %s%% = %s', (subtotal, pct, desconto) => {
    expect(descontoPercentual(subtotal, pct)).toBe(desconto);
    expect(resolveManualDiscount({ discount_type: 'percent', discount_value: pct }, subtotal).amount).toBe(desconto);
    expect(resolveManualDiscount({ discount_pct: pct }, subtotal).amount).toBe(desconto);
  });

  test('R$ 10,05 - 10% = R$ 9,04', () => {
    const d = descontoPercentual(10.05, 10);
    expect(aoCentavo(10.05 - d)).toBe(9.04);
  });

  test('paraCentavos: meio centavo para cima sem erro de ponto flutuante', () => {
    expect(paraCentavos(1.005)).toBe(101);
    expect(paraCentavos(10.05)).toBe(1005);
    expect(paraCentavos(0.1 + 0.2)).toBe(30);
    expect(paraCentavos(2.675)).toBe(268);
    expect(paraCentavos(-1.005)).toBe(-101);
    expect(paraCentavos(NaN)).toBe(0);
  });
});

// ── D. POST /pdv/sale ──────────────────────────────────────────
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
const nfseAutomatica = require('../src/services/nfseAutomatica');

const app = express();
app.use(express.json());
app.use('/companies/:id/pdv', pdvRouter);

const CID = 'comp-1', PROD = 'prod-1', SALE = 'sale-1';

function despachar({ cupom } = {}) {
  mockClient.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: { caixa_enabled: false } }] });
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM products p JOIN companies/i.test(s)) return Promise.resolve({ rows: [{ name: 'Peca', cost_price: 0, stock_qty: 50, stock_company_id: CID }] });
    if (/FROM coupons c/i.test(s)) return Promise.resolve({ rows: cupom ? [cupom] : [] });
    if (/INSERT INTO sales/i.test(s)) return Promise.resolve({ rows: [{ id: SALE, total_amount: params[5], discount_amount: params[6], employee_id: null, customer_id: null }] });
    return Promise.resolve({ rows: [] });
  });
  db.query.mockResolvedValue({ rows: [] });
}

const vender = (preco, body = {}) =>
  request(app).post(`/companies/${CID}/pdv/sale`)
    .send({ items: [{ product_id: PROD, quantity: 1, unit_price: preco }], payment_method: 'pix', ...body });

function gravado() {
  const call = mockClient.query.mock.calls.find((c) => /INSERT INTO sales/i.test(String(c[0] || '')));
  return { total: call[1][5], desconto: call[1][6] };
}

let gatilho;
beforeEach(() => {
  jest.clearAllMocks(); mockClient.query.mockReset(); db.query.mockReset();
  gatilho = jest.spyOn(nfseAutomatica, 'aoFinalizarVenda').mockReturnValue(false);
});
afterEach(() => gatilho.mockRestore());

describe('D. POST /pdv/sale grava o desconto certo', () => {
  test('80% de R$ 149,90: desconto R$ 119,92, total R$ 29,98', async () => {
    despachar();
    const res = await vender(149.9, { discount_type: 'percent', discount_value: 80 });
    expect(res.status).toBe(201);
    expect(gravado()).toEqual({ total: 29.98, desconto: 119.92 });
  });

  test('R$ 80 em R$ 139,90: grava R$ 80 de desconto, total R$ 59,90', async () => {
    despachar();
    await vender(139.9, { discount_type: 'fixed', discount_value: 80 });
    expect(gravado()).toEqual({ total: 59.9, desconto: 80 });
  });

  test('R$ acima do total: desconto = total, venda de R$ 0', async () => {
    despachar();
    await vender(139.9, { discount_type: 'fixed', discount_value: 500 });
    expect(gravado()).toEqual({ total: 0, desconto: 139.9 });
  });

  test('100%: total R$ 0', async () => {
    despachar();
    await vender(139.9, { discount_type: 'percent', discount_value: 100 });
    expect(gravado()).toEqual({ total: 0, desconto: 139.9 });
  });

  test('R$ 10,05 - 10%: total R$ 9,04 (meio centavo do desconto para cima)', async () => {
    despachar();
    await vender(10.05, { discount_type: 'percent', discount_value: 10 });
    expect(gravado()).toEqual({ total: 9.04, desconto: 1.01 });
  });

  test('cupom + manual continuam somando sobre a mesma base, com teto no subtotal', async () => {
    despachar({ cupom: { id: 'cup-1', code: 'DEZ', discount_type: 'percent', discount_value: '10', is_active: true, max_uses: null, current_uses: 0, min_order_value: 0, expires_at: null, customer_id: null } });
    await vender(100, { coupon_code: 'DEZ', discount_type: 'percent', discount_value: 80 });
    expect(gravado()).toEqual({ total: 10, desconto: 90 });

    mockClient.query.mockReset();
    despachar({ cupom: { id: 'cup-1', code: 'DEZ', discount_type: 'percent', discount_value: '10', is_active: true, max_uses: null, current_uses: 0, min_order_value: 0, expires_at: null, customer_id: null } });
    await vender(100, { coupon_code: 'DEZ', discount_type: 'percent', discount_value: 95 });
    expect(gravado()).toEqual({ total: 0, desconto: 100 });
  });

  test('acima de 100%: 400 e nada gravado', async () => {
    despachar();
    const res = await vender(100, { discount_type: 'percent', discount_value: 120 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_MANUAL_DISCOUNT');
    expect(mockClient.query.mock.calls.some((c) => /INSERT INTO sales/i.test(String(c[0] || '')))).toBe(false);
  });
});
