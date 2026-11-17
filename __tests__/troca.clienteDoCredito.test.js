// ============================================================
// AURA. — Cliente do credito na troca (p-165, 17/11/2026)
//
// - customer_id do corpo diferente do da venda passa pela conferencia do
//   dono (utils/customerScope.js); de outro dono -> 404 CUSTOMER_NOT_FOUND.
// - credito na conta sem cliente -> 422 CREDITO_EXIGE_CLIENTE, antes de
//   gravar qualquer coisa e antes do pre-cancelamento das NFC-e de origem.
// Mesmo client de mentira de trocaPedidoOnline.test.js.
// ============================================================
'use strict';

jest.mock('../src/config/database', () => ({ connect: jest.fn(), query: jest.fn() }));
jest.mock('../src/services/nuvemfiscal', () => require('../__mocks__/nuvemfiscal'));
jest.mock('../src/services/trocaDevolucao55', () => ({ handle: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const trocaV2 = require('../src/services/trocaV2');

const EMPRESA = 'c0000000-0000-0000-0000-000000000001';
const PEDIDO = 'd0000000-0000-0000-0000-000000000012';

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// ── client de mentira do handle ─────────────────────────────
function clientDaTroca({ pedido, itens, jaDevolvido = [], venda, clienteDoDono = false } = {}) {
  const chamadas = [];
  const c = {
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const s = norm(sql);
      chamadas.push([s, params]);
      if (/FROM digital_orders o JOIN companies c/.test(s)) return { rows: pedido ? [pedido] : [] };
      if (/FROM digital_order_items WHERE order_id IN/.test(s)) return { rows: itens || [] };
      if (/original_digital_order_item_id AS item_id, SUM/.test(s)) return { rows: jaDevolvido };
      if (/^SELECT s\.id, s\.status, s\.company_id/.test(s)) return { rows: venda ? [venda] : [] };
      if (/^SELECT id, sale_id, product_id, variant_id, quantity, unit_price, product_name_snapshot FROM sale_items/.test(s)) {
        return { rows: venda ? venda.items : [] };
      }
      if (/^SELECT id FROM customers WHERE id = \$1/.test(s)) return { rows: clienteDoDono ? [{ id: params[0] }] : [] };
      if (/information_schema\.columns/.test(s)) return { rows: [{ n: '2' }] };
      if (/^INSERT INTO troca_payouts/.test(s)) return { rows: [{ id: 'po-1' }] };
      if (/^INSERT INTO sales/.test(s)) return { rows: [{ id: 'troca-1', company_id: params[0], customer_id: params[1] }] };
      if (/^SELECT company_id FROM products WHERE id=\$1/.test(s)) return { rows: [{ company_id: EMPRESA }] };
      if (/^UPDATE product_variants SET stock_qty = stock_qty - \$1/.test(s)) return { rows: [{ stock_qty: 5 }] };
      if (/^UPDATE products SET stock_qty = stock_qty - \$1/.test(s)) return { rows: [{ stock_qty: 5 }] };
      if (/^SELECT p\.company_id AS stock_company_id/.test(s)) return { rows: [{ stock_company_id: EMPRESA }] };
      return { rows: [], rowCount: 1 };
    }),
  };
  return { c, chamadas, sqls: () => chamadas.map(([s]) => s) };
}

function resFalso() {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((code) => { r.statusCode = code; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  return r;
}

const pedidoOk = {
  id: PEDIDO, order_number: '00012', status: 'delivered', payment_status: 'confirmed',
  stock_deducted: true, company_id: EMPRESA, customer_id: 'cli-1', total: '40.00',
  created_at: '2026-10-16T22:36:21Z', nfce_id: null,
};
const itensOk = [{
  id: '61', order_id: PEDIDO, product_id: 'prod-1', variant_id: 'var-1',
  quantity: 1, unit_price: '40.00', product_name: 'Vestido', variant_label: 'M / Azul',
}];

function reqTroca(extra = {}) {
  return {
    params: { id: EMPRESA },
    user: { id: 'user-1' },
    body: {
      original_sale_ids: [],
      original_digital_order_ids: [PEDIDO],
      returned_items: [{
        original_digital_order_id: PEDIDO,
        original_digital_order_item_id: '61',
        // payload "errado" de proposito: o produto/variante vem do pedido
        product_id: 'outro-produto', variant_id: 'outra-variante',
        quantity: 1, unit_price: 40,
      }],
      new_items: [],
      refund_splits: [{ method: 'crediario_credito', amount: 40 }],
      nfce_strategy: 'none',
      ...extra,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
});

const OUTRO_CLIENTE = 'e0000000-0000-0000-0000-000000000099';
const gravouVenda = (sqls) => sqls().some((x) => /^INSERT INTO sales/.test(x));

describe('troca — cliente do credito', () => {
  test('venda sem cliente + credito na conta: 422 com codigo, nada gravado', async () => {
    const { c, sqls } = clientDaTroca({ pedido: { ...pedidoOk, customer_id: null }, itens: itensOk });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca(), res);
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('CREDITO_EXIGE_CLIENTE');
    expect(gravouVenda(sqls)).toBe(false);
    expect(sqls()).toContain('ROLLBACK');
  });

  test('venda sem cliente + devolucao em dinheiro: segue como antes', async () => {
    const { c, sqls } = clientDaTroca({ pedido: { ...pedidoOk, customer_id: null }, itens: itensOk });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({ refund_splits: [{ method: 'dinheiro', amount: 40 }] }), res);
    expect(res.statusCode).toBe(201);
    expect(sqls().some((x) => /FROM customers WHERE id/.test(x))).toBe(false);
  });

  test('venda sem cliente + cliente escolhido do mesmo dono: credito vai para ele', async () => {
    const { c, chamadas } = clientDaTroca({ pedido: { ...pedidoOk, customer_id: null }, itens: itensOk, clienteDoDono: true });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({ customer_id: OUTRO_CLIENTE }), res);
    expect(res.statusCode).toBe(201);
    const conf = chamadas.find(([x]) => /^SELECT id FROM customers WHERE id = \$1/.test(x));
    expect(conf[1]).toEqual([OUTRO_CLIENTE, EMPRESA]);
    const venda = chamadas.find(([x]) => /^INSERT INTO sales/.test(x));
    expect(venda[1][1]).toBe(OUTRO_CLIENTE);
    const credito = chamadas.find(([x]) => /^INSERT INTO customer_credit_transactions/.test(x));
    expect(credito[1][1]).toBe(OUTRO_CLIENTE);
  });

  test('cliente diferente do da venda (presente): conferido e aceito', async () => {
    const { c, chamadas } = clientDaTroca({ pedido: pedidoOk, itens: itensOk, clienteDoDono: true });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({ customer_id: OUTRO_CLIENTE }), res);
    expect(res.statusCode).toBe(201);
    const venda = chamadas.find(([x]) => /^INSERT INTO sales/.test(x));
    expect(venda[1][1]).toBe(OUTRO_CLIENTE);
  });

  test('cliente de outro dono: 404 CUSTOMER_NOT_FOUND, nada gravado', async () => {
    const { c, sqls } = clientDaTroca({ pedido: pedidoOk, itens: itensOk, clienteDoDono: false });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({ customer_id: OUTRO_CLIENTE }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
    expect(gravouVenda(sqls)).toBe(false);
  });

  test('cliente do corpo igual ao da venda: sem consulta extra', async () => {
    const { c, chamadas } = clientDaTroca({ pedido: pedidoOk, itens: itensOk });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({ customer_id: pedidoOk.customer_id }), res);
    expect(res.statusCode).toBe(201);
    expect(chamadas.some(([x]) => /FROM customers WHERE id/.test(x))).toBe(false);
    const venda = chamadas.find(([x]) => /^INSERT INTO sales/.test(x));
    expect(venda[1][1]).toBe(pedidoOk.customer_id);
  });

  test('a conferencia roda antes do pre-cancelamento das NFC-e de origem', () => {
    const s = fs.readFileSync(path.join(__dirname, '../src/services/trocaV2.js'), 'utf8');
    const corpo = s.slice(s.indexOf('async function handle('));
    expect(corpo.indexOf('resolverClienteDaTroca(client')).toBeGreaterThan(0);
    expect(corpo.indexOf('resolverClienteDaTroca(client')).toBeLessThan(corpo.indexOf('preCancelNfces(originSales'));
  });
});

describe('temCreditoNaConta', () => {
  const { temCreditoNaConta } = trocaV2._internal;
  test.each([
    [[{ method: 'crediario_credito', amount: 10 }], true],
    [[{ method: 'crediario_credito', amount: 0 }], false],
    [[{ method: 'dinheiro', amount: 10 }], false],
    [[], false],
    [undefined, false],
  ])('%j -> %s', (splits, esperado) => {
    expect(temCreditoNaConta(splits)).toBe(esperado);
  });
});
