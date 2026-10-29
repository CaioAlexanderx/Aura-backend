// ============================================================
// AURA. — Desconto e preco alterado na troca do Caixa (29/10/2026)
//
// Relato: a lojista nao conseguia dar desconto nem mudar o preco do item
// novo na troca. O motor da troca gravava discount_amount=0 e
// sale_items.discount=0 fixos e nao lia nenhum campo de desconto.
//
// Trava aqui:
//   1. a conta: desconto do item (lapis) + desconto manual (R$ ou %), mesma
//      regra e teto do POST /sale, e a diferenca a pagar/devolver sai liquida;
//   2. o que o handle grava: sales.total_amount/discount_amount,
//      sale_items.discount/total_price, financeiro "Troca - Venda" liquido e
//      pagamento da diferenca liquida; resposta com new_subtotal/discount;
//   3. desconto invalido -> 400 INVALID_MANUAL_DISCOUNT, nada gravado;
//   4. sem desconto: tudo como antes (discount 0);
//   5. o adaptador do contrato v1 (POST /pdv/troca com original_sale_id)
//      repassa os campos de desconto.
// ============================================================
'use strict';

jest.mock('../src/config/database', () => ({ connect: jest.fn(), query: jest.fn() }));
jest.mock('../src/services/nuvemfiscal', () => require('../__mocks__/nuvemfiscal'));
jest.mock('../src/services/trocaDevolucao55', () => ({ handle: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const trocaV2 = require('../src/services/trocaV2');
const { computeAndValidateTotals, newItemLine } = trocaV2._internal;

const EMPRESA = 'c0000000-0000-0000-0000-000000000001';
const VENDA = 'a0000000-0000-0000-0000-000000000001';

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

function clientDaTroca() {
  const chamadas = [];
  const venda = {
    id: VENDA, status: 'completed', company_id: EMPRESA, seller_id: null, employee_id: null,
    created_at: '2026-10-20T10:00:00Z', total_amount: '249.99', customer_id: null,
    items: [{ id: 'si-1', sale_id: VENDA, product_id: 'prod-velho', variant_id: null, quantity: 1, unit_price: '249.99', product_name_snapshot: 'Tenis' }],
  };
  const c = {
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const s = norm(sql);
      chamadas.push([s, params]);
      if (/^SELECT s\.id, s\.status, s\.company_id/.test(s)) return { rows: [venda] };
      if (/^SELECT id, sale_id, product_id, variant_id, quantity, unit_price, product_name_snapshot FROM sale_items/.test(s)) return { rows: venda.items };
      if (/information_schema\.columns/.test(s)) return { rows: [{ n: '2' }] };
      if (/^INSERT INTO sales/.test(s)) return { rows: [{ id: 'troca-1', company_id: params[0], customer_id: params[1] }] };
      if (/^SELECT company_id FROM products WHERE id=\$1/.test(s)) return { rows: [{ company_id: EMPRESA }] };
      if (/^SELECT p\.company_id AS stock_company_id/.test(s)) return { rows: [{ stock_company_id: EMPRESA }] };
      if (/^UPDATE products SET stock_qty = stock_qty - \$1/.test(s)) return { rows: [{ stock_qty: 4 }] };
      return { rows: [], rowCount: 1 };
    }),
  };
  return { c, chamadas };
}

function resFalso() {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((code) => { r.statusCode = code; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  return r;
}

function reqTroca(extra = {}, itemExtra = {}) {
  return {
    params: { id: EMPRESA },
    user: { id: 'user-1' },
    body: {
      original_sale_ids: [VENDA],
      returned_items: [{
        original_sale_id: VENDA, original_sale_item_id: 'si-1',
        product_id: 'prod-velho', variant_id: null, quantity: 1, unit_price: 249.99,
      }],
      new_items: [{ product_id: 'prod-novo', variant_id: null, quantity: 1, unit_price: 339.99, product_name_snapshot: 'Tenis novo', ...itemExtra }],
      payment_splits: [{ method: 'pix', amount: 60 }],
      nfce_strategy: 'none',
      ...extra,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
});

describe('conta da troca com desconto', () => {
  test('linha do item novo: desconto do lapis sai do total, nunca negativo', () => {
    expect(newItemLine({ quantity: 2, unit_price: 100, item_discount: 30 })).toEqual({ qty: 2, unitPrice: 100, gross: 200, itemDiscount: 30, lineTotal: 170 });
    expect(newItemLine({ quantity: 1, unit_price: 50, item_discount: 80 }).lineTotal).toBe(0);
    expect(newItemLine({ quantity: 1, unit_price: 50, item_discount: -5 }).itemDiscount).toBe(0);
    expect(newItemLine({ quantity: 1, unit_price: 50 }).itemDiscount).toBe(0);
  });

  test('desconto do item + desconto manual em R$: diferenca a pagar liquida', () => {
    const t = computeAndValidateTotals({
      returned_items: [{ quantity: 1, unit_price: 249.99 }],
      new_items: [{ quantity: 1, unit_price: 339.99, item_discount: 20 }],
      payment_splits: [{ method: 'pix', amount: 60 }],
      discount: { discount_type: 'fixed', discount_value: 10 },
    });
    expect(t.newSubtotal).toBe(319.99);
    expect(t.discountAmount).toBe(10);
    expect(t.newValue).toBe(309.99);
    expect(t.saleTotal).toBe(309.99);
    expect(t.netAmount).toBe(60);
    expect(t.paymentSplits).toEqual([{ method: 'pix', amount: 60 }]);
  });

  test('desconto em % sobre o subtotal dos itens novos', () => {
    const t = computeAndValidateTotals({
      returned_items: [{ quantity: 1, unit_price: 100 }],
      new_items: [{ quantity: 2, unit_price: 100 }],
      discount: { discount_type: 'percent', discount_value: 10 },
    });
    expect(t.discountAmount).toBe(20);
    expect(t.newValue).toBe(180);
    expect(t.netAmount).toBe(80);
  });

  test('desconto que passa a diferenca vira devolucao ao cliente (e nao some)', () => {
    const t = computeAndValidateTotals({
      returned_items: [{ quantity: 1, unit_price: 100 }],
      new_items: [{ quantity: 1, unit_price: 110 }],
      discount: { discount_type: 'fixed', discount_value: 20 },
      legacyMethod: 'dinheiro',
    });
    expect(t.newValue).toBe(90);
    expect(t.netAmount).toBe(-10);
    expect(t.refundSplits).toEqual([{ method: 'dinheiro', amount: 10 }]);
    expect(t.paymentSplits).toEqual([]);
  });

  test('teto: desconto nunca passa do subtotal dos itens novos', () => {
    const t = computeAndValidateTotals({
      returned_items: [{ quantity: 1, unit_price: 50 }],
      new_items: [{ quantity: 1, unit_price: 40 }],
      discount: { discount_type: 'fixed', discount_value: 999 },
    });
    expect(t.discountAmount).toBe(40);
    expect(t.newValue).toBe(0);
  });

  test('desconto invalido: 400 com o codigo do POST /sale', () => {
    expect(() => computeAndValidateTotals({
      returned_items: [{ quantity: 1, unit_price: 50 }],
      new_items: [{ quantity: 1, unit_price: 80 }],
      discount: { discount_type: 'percent', discount_value: 150 },
    })).toThrow(/maior que 100%/);
    try {
      computeAndValidateTotals({ returned_items: [{ quantity: 1, unit_price: 50 }], new_items: [{ quantity: 1, unit_price: 80 }], discount: { discount_type: 'fixed' } });
    } catch (e) {
      expect(e.status).toBe(400);
      expect(e.body.code).toBe('INVALID_MANUAL_DISCOUNT');
    }
  });

  test('sem desconto: valores de sempre', () => {
    const t = computeAndValidateTotals({
      returned_items: [{ quantity: 1, unit_price: 249.99 }],
      new_items: [{ quantity: 1, unit_price: 339.99 }],
    });
    expect(t.discountAmount).toBe(0);
    expect(t.newValue).toBe(339.99);
    expect(t.netAmount).toBe(90);
  });
});

describe('trocaV2.handle grava o desconto', () => {
  test('preco alterado (lapis) + desconto manual: venda, itens, financeiro e pagamento liquidos', async () => {
    const { c, chamadas } = clientDaTroca();
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({ discount_type: 'fixed', discount_value: 10 }, { item_discount: 20 }), res);

    expect(res.statusCode).toBe(201);
    expect(res.body.new_subtotal).toBe(319.99);
    expect(res.body.discount_amount).toBe(10);
    expect(res.body.new_value).toBe(309.99);
    expect(res.body.net_amount).toBe(60);

    const venda = chamadas.find(([s]) => /^INSERT INTO sales/.test(s));
    expect(venda[0]).toMatch(/total_amount, discount_amount, payment_method/);
    // total_amount, discount_amount na ordem das colunas (com exchange_*)
    expect(venda[1][7]).toBe(309.99);
    expect(venda[1][8]).toBe(10);
    expect(venda[1][venda[1].length - 1]).toBe(VENDA); // exchange_of_sale_id segue por ultimo

    const item = chamadas.find(([s]) => /^INSERT INTO sale_items/.test(s));
    // (sale_id, product_id, variant_id, quantity, unit_price, unit_cost, discount, total_price, name)
    expect(item[0]).toMatch(/VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$9,\$7,\$8\)/);
    expect(item[1][4]).toBe(339.99);
    expect(item[1][6]).toBe(319.99); // total_price
    expect(item[1][8]).toBe(20);     // discount

    const receita = chamadas.find(([s, p]) => /^INSERT INTO transactions/.test(s) && /'income'/.test(s));
    expect(receita[1][1]).toBe(309.99);

    const pagamentos = chamadas.filter(([s, p]) => /^INSERT INTO sale_payments/.test(s) && p[3] > 0);
    expect(pagamentos.map(([, p]) => p[3])).toEqual([60]);
  });

  test('desconto em % no corpo: sales.discount_amount e diferenca recalculados no servidor', async () => {
    const { c, chamadas } = clientDaTroca();
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    // 339,99 com 10% = 34,00 de desconto -> 305,99; diferenca 56,00 (o split
    // de 60 enviado e ajustado no servidor, regra nao bloqueante de sempre).
    await trocaV2.handle(reqTroca({ discount_type: 'percent', discount_value: 10 }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.discount_amount).toBe(34);
    expect(res.body.net_amount).toBe(56);
    const venda = chamadas.find(([s]) => /^INSERT INTO sales/.test(s));
    expect(venda[1][7]).toBe(305.99);
    expect(venda[1][8]).toBe(34);
    const pagamentos = chamadas.filter(([s, p]) => /^INSERT INTO sale_payments/.test(s) && p[3] > 0);
    expect(pagamentos.map(([, p]) => p[3])).toEqual([56]);
  });

  test('desconto invalido: 400 e ROLLBACK, nada gravado', async () => {
    const { c, chamadas } = clientDaTroca();
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({ discount_type: 'fixed', discount_value: -5 }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_MANUAL_DISCOUNT');
    expect(chamadas.some(([s]) => /^INSERT INTO sales/.test(s))).toBe(false);
    expect(chamadas.some(([s]) => s === 'ROLLBACK')).toBe(true);
  });

  test('sem desconto: discount 0 gravado, como antes', async () => {
    const { c, chamadas } = clientDaTroca();
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({ payment_splits: [{ method: 'pix', amount: 90 }] }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.discount_amount).toBe(0);
    expect(res.body.new_value).toBe(339.99);
    const venda = chamadas.find(([s]) => /^INSERT INTO sales/.test(s));
    expect(venda[1][7]).toBe(339.99);
    expect(venda[1][8]).toBe(0);
    const item = chamadas.find(([s]) => /^INSERT INTO sale_items/.test(s));
    expect(item[1][8]).toBe(0);
  });
});

describe('POST /pdv/troca no contrato v1 repassa o desconto', () => {
  const pdvRouter = require('../src/routes/pdv');
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/pdv', (req, _res, next) => { req.user = { id: 'user-1', role: 'admin' }; next(); }, pdvRouter);

  test('discount_type/discount_value e item_discount chegam ao motor da troca', async () => {
    const spy = jest.spyOn(trocaV2, 'handle').mockImplementation((req, res) => res.status(201).json({ body: req.body }));
    const r = await request(app)
      .post(`/companies/${EMPRESA}/pdv/troca`)
      .send({
        original_sale_id: VENDA,
        returned_items: [{ product_id: 'prod-velho', quantity: 1, unit_price: 249.99, original_sale_item_id: 'si-1' }],
        new_items: [{ product_id: 'prod-novo', quantity: 1, unit_price: 339.99, item_discount: 20 }],
        payment_method: 'pix',
        discount_type: 'percent',
        discount_value: 5,
      });
    expect(r.status).toBe(201);
    expect(spy).toHaveBeenCalledTimes(1);
    const body = spy.mock.calls[0][0].body;
    expect(body.original_sale_ids).toEqual([VENDA]);
    expect(body.discount_type).toBe('percent');
    expect(body.discount_value).toBe(5);
    expect(body.new_items[0].item_discount).toBe(20);
    spy.mockRestore();
  });
});
