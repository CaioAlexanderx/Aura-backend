// ============================================================
// AURA. — Valor pago do item devolvido na troca (INC-2026-11-19-01)
//
// Caso real (produção, 19/11/2026): venda c1667516 — 1 "BLUSA POLO
// FEMININA", unit_price 79,90, total_price 79,90, sem desconto no item;
// sales.discount_amount = 25,00, total_amount = 54,90. A troca 6b340b17
// devolveu a blusa e lançou R$ 79,90 de crédito na ficha. O certo é 54,90.
//
// Trava aqui:
//   1. a regra (services/valorPagoNaTroca.js): desconto na venda, no item,
//      os dois, rateio de centavos entre linhas (mesmo da NFC-e), devolução
//      parcial, devolução em várias trocas com teto do que foi pago;
//   2. o motor (trocaV2.handle): unit_price do payload inflado é ignorado;
//      troca_returned_items.unit_price, crédito na ficha, financeiro
//      "Troca - Devolucao", sale_payments negativa e resposta usam o pago;
//   3. a NF-e 55 de devolução recebe o pago (nunca maior que a nota original);
//   4. pedido da loja online com desconto do Pix: mesma regra;
//   5. a busca da troca (GET /pdv/sales-for-troca e /sales-by-product-barcode)
//      devolve valor_pago_unit e valor_pago_total por item.
// ============================================================
'use strict';

jest.mock('../src/services/nuvemfiscal', () => require('../__mocks__/nuvemfiscal'));
jest.mock('../src/services/trocaDevolucao55', () => ({ handle: jest.fn() }));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');
const trocaV2 = require('../src/services/trocaV2');
const trocaDevolucao55 = require('../src/services/trocaDevolucao55');
const {
  pagoPorLinhaC, valorPagoDasLinhas, unitarioDaDevolucaoC, comValorPago,
} = require('../src/services/valorPagoNaTroca');
const { aplicarDescontoNasLinhas, linhasDaVendaGravada, centavos } = require('../src/services/descontoDaVendaNaNfce');
const { _internal: pedidoInternal } = require('../src/services/trocaPedidoOnline');

const EMPRESA = 'c0000000-0000-0000-0000-000000000001';
const VENDA = 'c1667516-0000-4000-8000-000000000001';
const ITEM = 'b0000000-0000-0000-0000-000000000001';
const ITEM2 = 'b0000000-0000-0000-0000-000000000002';
const CLIENTE = 'cc000000-0000-4000-8000-000000000001';
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

const BLUSA = { id: ITEM, sale_id: VENDA, product_id: 'prod-blusa', variant_id: null, quantity: '1', unit_price: '79.90', discount: '0', total_price: '79.90', product_name_snapshot: 'BLUSA POLO FEMININA' };

// ── 1. A regra ───────────────────────────────────────────────
describe('valor pago por linha', () => {
  test('caso real: 79,90 com 25,00 de desconto na venda -> 54,90', () => {
    expect(pagoPorLinhaC([BLUSA], '25.00')).toEqual([5490]);
    const [l] = valorPagoDasLinhas([BLUSA], '25.00');
    expect(l.valor_pago_unit).toBe(54.9);
    expect(l.valor_pago_total).toBe(54.9);
  });

  test('desconto no item (lapis): o total da linha ja vem com ele', () => {
    const linha = { ...BLUSA, unit_price: '100.00', discount: '15.00', total_price: '85.00' };
    expect(pagoPorLinhaC([linha], 0)).toEqual([8500]);
  });

  test('desconto no item + desconto na venda: rateio sobre a linha ja com o lapis', () => {
    // linha A: 2 x 50 = 100, lapis 20 -> 80; linha B: 1 x 120 = 120. Base 200.
    // Desconto da venda 20: A leva 8, B leva 12. Pago: A 72, B 108.
    const a = { id: 'a', quantity: '2', unit_price: '50.00', discount: '20.00', total_price: '80.00', product_id: 'p-a' };
    const b = { id: 'b', quantity: '1', unit_price: '120.00', discount: '0', total_price: '120.00', product_id: 'p-b' };
    expect(pagoPorLinhaC([a, b], '20.00')).toEqual([7200, 10800]);
    const [pa] = valorPagoDasLinhas([a, b], '20.00');
    expect(pa.valor_pago_unit).toBe(36);
  });

  test('2 itens com centavos: soma das linhas = total da venda, sobra na maior linha (regra da NFC-e)', () => {
    // 3 linhas de 10,00 com 10,00 de desconto: 3,33 cada no piso e o centavo
    // que sobra na maior linha (empate: a primeira), como na NFC-e.
    const l = (id) => ({ id, quantity: '1', unit_price: '10.00', discount: '0', total_price: '10.00', product_id: 'p-' + id });
    const pagos = pagoPorLinhaC([l('1'), l('2'), l('3')], '10.00');
    expect(pagos.reduce((s, v) => s + v, 0)).toBe(2000);
    expect(pagos).toEqual([666, 667, 667]);

    // Venda de 2 itens (29,90 + 19,90 = 49,80) com 5,00 de desconto.
    const x = { id: 'x', quantity: '1', unit_price: '29.90', total_price: '29.90', product_id: 'p-x' };
    const y = { id: 'y', quantity: '1', unit_price: '19.90', total_price: '19.90', product_id: 'p-y' };
    const p2 = pagoPorLinhaC([x, y], '5.00');
    expect(p2[0] + p2[1]).toBe(4480);
    // Rateio: 3,00 + 1,99 = 4,99 no piso; o centavo que sobra vai na maior (x).
    expect(p2).toEqual([2689, 1791]);
  });

  test('e o MESMO rateio da NFC-e: pago = vProd - vDesc de cada item da nota', () => {
    const itens = [
      { id: '1', quantity: '3', unit_price: '12.99', discount: '1.00', total_price: '37.97', product_id: 'p1', product_name_snapshot: 'A' },
      { id: '2', quantity: '1', unit_price: '49.90', discount: '0', total_price: '49.90', product_id: 'p2', product_name_snapshot: 'B' },
      { id: '3', quantity: '2', unit_price: '7.45', discount: '0', total_price: '14.90', product_id: 'p3', product_name_snapshot: 'C' },
    ];
    const nota = aplicarDescontoNasLinhas(linhasDaVendaGravada(itens), 13.37);
    const daNota = nota.itens.map((it) => Math.round(it.quantity * it.unit_price * 100) - centavos(it.discount || 0));
    expect(pagoPorLinhaC(itens, '13.37')).toEqual(daNota);
  });

  test('frete fica fora do rateio; desconto que cobre os produtos zera so os produtos', () => {
    const prod = { id: '1', quantity: '1', unit_price: '50.00', total_price: '50.00', product_id: 'a0000000-0000-4000-8000-0000000000aa', product_name_snapshot: 'Saia' };
    const frete = { id: '2', quantity: '1', unit_price: '15.00', total_price: '15.00', product_id: null, product_name_snapshot: 'Frete' };
    expect(pagoPorLinhaC([prod, frete], '10.00')).toEqual([4000, 1500]);
    expect(pagoPorLinhaC([prod, frete], '60.00')).toEqual([0, 1500]);
  });

  test('sem total_price (linha antiga/mock): vale quantidade x preco', () => {
    expect(pagoPorLinhaC([{ id: '1', quantity: 2, unit_price: 10 }], 0)).toEqual([2000]);
  });
});

describe('devolucao parcial e em mais de uma troca', () => {
  test('2 de 3 unidades: proporcional a quantidade', () => {
    // 3 x 30,00 = 90,00 com 9,00 de desconto -> 81,00 pagos, 27,00 cada.
    const [l] = valorPagoDasLinhas([{ id: '1', quantity: '3', unit_price: '30', total_price: '90' }], '9');
    expect(unitarioDaDevolucaoC({ unitPagoC: l.unitPagoC, linhaPagaC: l.linhaPagaC, jaDevolvidoC: 0, qty: 2 })).toBe(2700);
  });

  test('linha que nao divide em centavos: a soma das devolucoes nunca passa do pago', () => {
    // 3 unidades, 100,01 pagos -> 33,34 por unidade (arredondado).
    const [l] = valorPagoDasLinhas([{ id: '1', quantity: '3', unit_price: '33.337', total_price: '100.01' }], 0);
    expect(l.unitPagoC).toBe(3334);
    // De uma vez: 3 x 33,34 = 100,02 > 100,01 -> 33,33 (99,99).
    expect(unitarioDaDevolucaoC({ ...l, jaDevolvidoC: 0, qty: 3 })).toBe(3333);
    // Uma por troca: 33,34 + 33,34 + 33,33 = 100,01.
    const u1 = unitarioDaDevolucaoC({ ...l, jaDevolvidoC: 0, qty: 1 });
    const u2 = unitarioDaDevolucaoC({ ...l, jaDevolvidoC: u1, qty: 1 });
    const u3 = unitarioDaDevolucaoC({ ...l, jaDevolvidoC: u1 + u2, qty: 1 });
    expect([u1, u2, u3]).toEqual([3334, 3334, 3333]);
    expect(u1 + u2 + u3).toBe(10001);
  });

  test('troca antiga gravada pelo preco de tabela: o que ja saiu conta no teto', () => {
    // 2 x 54,90 pagos (109,80); a 1a unidade voltou a 79,90 (defeito).
    // A 2a so pode levar o que resta: 29,90.
    expect(unitarioDaDevolucaoC({ unitPagoC: 5490, linhaPagaC: 10980, jaDevolvidoC: 7990, qty: 1 })).toBe(2990);
    expect(unitarioDaDevolucaoC({ unitPagoC: 5490, linhaPagaC: 5490, jaDevolvidoC: 7990, qty: 1 })).toBe(0);
  });
});

// ── 2. O motor da troca ──────────────────────────────────────
function clientDaTroca({ venda = {}, itens = [BLUSA], jaDevolvido = [], nfce = null } = {}) {
  const sqls = [];
  const vendaRow = {
    id: VENDA, status: 'completed', company_id: EMPRESA, seller_id: null, employee_id: null,
    created_at: '2026-11-10T10:00:00Z', total_amount: '54.90', customer_id: CLIENTE, discount_amount: '25.00',
    ...venda,
  };
  const c = {
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const s = norm(sql);
      sqls.push([s, params]);
      if (/^SELECT s\.id, s\.status, s\.company_id/.test(s)) return { rows: [vendaRow] };
      if (/^SELECT id, sale_id, product_id, variant_id, quantity, unit_price, product_name_snapshot, discount, total_price FROM sale_items/.test(s)) return { rows: itens };
      if (/^SELECT tri\.original_sale_item_id, SUM\(tri\.quantity\) AS already_returned/.test(s)) return { rows: jaDevolvido };
      if (/^SELECT DISTINCT ON \(ne\.sale_id\)/.test(s)) return { rows: nfce ? [{ sale_id: VENDA, ...nfce }] : [] };
      if (/information_schema\.columns/.test(s)) return { rows: [{ n: '2' }] };
      if (/^INSERT INTO sales/.test(s)) return { rows: [{ id: 'troca-6b340b17', company_id: params[0], customer_id: params[1] }] };
      if (/^INSERT INTO customer_credit_transactions/.test(s)) return { rows: [{ id: 'cct-1' }] };
      if (/^INSERT INTO troca_payouts/.test(s)) return { rows: [{ id: 'po-1' }] };
      if (/^INSERT INTO nfce_emissions/.test(s)) return { rows: [{ id: 'em-1' }] };
      if (/^SELECT company_id FROM products WHERE id=\$1/.test(s)) return { rows: [{ company_id: EMPRESA }] };
      return { rows: [], rowCount: 1 };
    }),
  };
  return { c, sqls };
}

function resFalso() {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((code) => { r.statusCode = code; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  return r;
}

function reqTroca({ returned, refund, strategy = 'none', newItems = [] } = {}) {
  return {
    params: { id: EMPRESA },
    user: { id: 'user-1' },
    body: {
      original_sale_ids: [VENDA],
      returned_items: returned || [{
        original_sale_id: VENDA, original_sale_item_id: ITEM, product_id: 'prod-blusa',
        quantity: 1, unit_price: 79.9, product_name_snapshot: 'BLUSA POLO FEMININA',
      }],
      new_items: newItems,
      // O app antigo manda o credito pelo preco de tabela.
      refund_splits: refund || [{ method: 'crediario_credito', amount: 79.9 }],
      nfce_strategy: strategy,
    },
  };
}

const achar = (sqls, re) => sqls.filter(([s]) => re.test(s));

describe('trocaV2.handle: o servidor calcula o valor devolvido', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
    trocaDevolucao55.handle.mockResolvedValue({ status: 'autorizada', devolucao_chave: 'chave-dev' });
  });

  test('caso real: credito de 54,90 na ficha (o payload mandava 79,90)', async () => {
    const { c, sqls } = clientDaTroca();
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca(), res);

    expect(res.statusCode).toBe(201);
    expect(res.body.returned_value).toBe(54.9);
    expect(res.body.net_amount).toBe(-54.9);

    const [tri] = achar(sqls, /^INSERT INTO troca_returned_items/);
    expect(tri[1][6]).toBe(54.9); // unit_price gravado = pago por unidade

    const [cct] = achar(sqls, /^INSERT INTO customer_credit_transactions/);
    expect(cct[1][3]).toBe(54.9);
    expect(cct[1][1]).toBe(CLIENTE);

    const [po] = achar(sqls, /^INSERT INTO troca_payouts/);
    expect(po[1][4]).toBe(54.9);

    const devolucao = achar(sqls, /^INSERT INTO transactions/).find(([s]) => /Troca - Devolucao/.test(s));
    expect(devolucao[1][1]).toBe(54.9);

    const negativa = achar(sqls, /^INSERT INTO sale_payments/).find(([, p]) => p[3] < 0);
    expect(negativa[1][3]).toBe(-54.9);
  });

  test('payload com unit_price inflado (999,99) e ignorado', async () => {
    const { c, sqls } = clientDaTroca();
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({
      returned: [{ original_sale_id: VENDA, original_sale_item_id: ITEM, product_id: 'prod-blusa', quantity: 1, unit_price: 999.99 }],
      refund: [{ method: 'dinheiro', amount: 999.99 }],
    }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.returned_value).toBe(54.9);
    const [tri] = achar(sqls, /^INSERT INTO troca_returned_items/);
    expect(tri[1][6]).toBe(54.9);
    expect(res.body.payouts).toEqual([expect.objectContaining({ method: 'dinheiro', amount: 54.9 })]);
  });

  test('payload sem unit_price (ou NaN): mesmo valor pago', async () => {
    const { c } = clientDaTroca();
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({
      returned: [{ original_sale_id: VENDA, original_sale_item_id: ITEM, product_id: 'prod-blusa', quantity: 1, unit_price: '' }],
      refund: [{ method: 'dinheiro', amount: 0 }],
    }), res);
    expect(res.body.returned_value).toBe(54.9);
  });

  test('venda sem desconto: igual a antes (pago = total da linha)', async () => {
    const { c, sqls } = clientDaTroca({
      venda: { discount_amount: '0', total_amount: '79.90' },
    });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca(), res);
    expect(res.body.returned_value).toBe(79.9);
    expect(achar(sqls, /^INSERT INTO troca_returned_items/)[0][1][6]).toBe(79.9);
  });

  test('devolucao parcial: 2 de 3 unidades com desconto na venda', async () => {
    const linha = { ...BLUSA, quantity: '3', unit_price: '30.00', total_price: '90.00' };
    const { c, sqls } = clientDaTroca({ itens: [linha], venda: { discount_amount: '9.00', total_amount: '81.00' } });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({
      returned: [{ original_sale_id: VENDA, original_sale_item_id: ITEM, product_id: 'prod-blusa', quantity: 2, unit_price: 30 }],
      refund: [{ method: 'dinheiro', amount: 60 }],
    }), res);
    expect(res.body.returned_value).toBe(54);
    expect(achar(sqls, /^INSERT INTO troca_returned_items/)[0][1].slice(5, 7)).toEqual([2, 27]);
  });

  test('segunda troca da mesma linha: teto do que ainda nao voltou', async () => {
    // 2 blusas pagas a 54,90 cada; uma ja voltou (54,90). A outra leva 54,90.
    const linha = { ...BLUSA, quantity: '2', total_price: '159.80' };
    const { c } = clientDaTroca({
      itens: [linha], venda: { discount_amount: '50.00', total_amount: '109.80' },
      jaDevolvido: [{ original_sale_item_id: ITEM, already_returned: '1', already_value: '54.90' }],
    });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca(), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.returned_value).toBe(54.9);
  });

  test('a mesma linha em duas linhas do payload: a soma nao passa do pago', async () => {
    const linha = { ...BLUSA, quantity: '3', unit_price: '33.337', total_price: '100.01' };
    const { c, sqls } = clientDaTroca({ itens: [linha], venda: { discount_amount: '0', total_amount: '100.01' } });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    const ret = (q) => ({ original_sale_id: VENDA, original_sale_item_id: ITEM, product_id: 'prod-blusa', quantity: q, unit_price: 50 });
    await trocaV2.handle(reqTroca({ returned: [ret(2), ret(1)], refund: [{ method: 'dinheiro', amount: 1 }] }), res);
    const gravados = achar(sqls, /^INSERT INTO troca_returned_items/).map(([, p]) => p[5] * p[6]);
    expect(Math.round(gravados.reduce((s, v) => s + v, 0) * 100)).toBeLessThanOrEqual(10001);
    expect(res.body.returned_value).toBe(100.01);
  });

  test('NF-e 55 de devolucao: itens e total pelo pago (nunca acima da nota original)', async () => {
    const { c } = clientDaTroca({
      nfce: { id: 'nfce-1', nuvemfiscal_id: null, chave_acesso: '3526...', authorized_at: '2026-11-10T10:00:00Z', numero: 9, status: 'autorizada', config_uf: 'SP' },
    });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({ strategy: 'devolucao_55' }), res);
    expect(res.statusCode).toBe(201);
    expect(trocaDevolucao55.handle).toHaveBeenCalledTimes(1);
    const args = trocaDevolucao55.handle.mock.calls[0][1];
    expect(args.returnedValue).toBeCloseTo(54.9, 2);
    expect(args.returnedItems[0].unit_price).toBe(54.9);
    // A nota original saiu com vNF 54,90 (79,90 - 25,00): a devolucao nao passa.
    expect(args.returnedValue).toBeLessThanOrEqual(54.9);
  });

  test('troca com item novo: a diferenca a pagar usa o valor pago', async () => {
    const { c } = clientDaTroca();
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca({
      newItems: [{ product_id: null, quantity: 1, unit_price: 99.9, product_name_snapshot: 'Vestido' }],
      refund: [],
    }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.net_amount).toBe(45);
  });
});

// ── 3. Pedido da loja online ─────────────────────────────────
describe('pedido da loja online com desconto do Pix', () => {
  const { pagoDosPedidos } = trocaV2._internal;
  test('desconto do pedido rateado pelos itens (subtotal)', () => {
    const pedido = {
      id: 'o1', discount_amount: '10.00',
      items: [
        { id: 61, quantity: 1, unit_price: '60.00', subtotal: '60.00', product_id: 'p1', product_name_snapshot: 'Saia' },
        { id: 62, quantity: 2, unit_price: '20.00', subtotal: '40.00', product_id: 'p2', product_name_snapshot: 'Meia' },
      ],
    };
    const m = pagoDosPedidos([pedido]);
    expect(m.get('61')).toMatchObject({ linhaPagaC: 5400, unitPagoC: 5400 });
    expect(m.get('62')).toMatchObject({ linhaPagaC: 3600, unitPagoC: 1800 });
  });

  test('pedido sem desconto: subtotal do item', () => {
    const m = pagoDosPedidos([{ id: 'o1', discount_amount: '0', items: [{ id: 7, quantity: 1, unit_price: '49.90', subtotal: '49.90' }] }]);
    expect(m.get('7').unitPagoC).toBe(4990);
  });

  test('a busca de pedidos devolve valor_pago_unit por item', () => {
    const row = pedidoInternal.normalizeRow({
      id: 'o1', order_number: '00012', status: 'delivered', total: '90.00', discount_amount: '10.00',
      items: [{ product_id: 'p1', quantity: 1, unit_price: 100, total_price: 100, original_digital_order_item_id: '61' }],
    });
    expect(row.items[0].valor_pago_unit).toBe(90);
    expect(row.items[0].valor_pago_total).toBe(90);
    expect(row.discount_amount).toBe(10);
  });
});

// ── 4. Busca da venda para a troca ───────────────────────────
describe('GET /pdv/sales-for-troca e /sales-by-product-barcode: valor pago por item', () => {
  const { requireAuth, requireCompanyAccess } = require('../src/middleware/auth');
  const pdvRouter = require('../src/routes/pdv');
  const SECRET = 'aura-test-secret-2026';
  const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/pdv', pdvRouter);
  app.use('/api/v1/companies/:id', scoped);

  const vendaRow = {
    id: VENDA, total_amount: '54.90', discount_amount: '25.00', payment_method: 'pix', status: 'completed',
    created_at: '2026-11-10T15:00:00.000Z', company_id: EMPRESA, company_name: 'Loja', customer_id: CLIENTE,
    customer_name: 'Maria', cpf_cnpj: null, seller_id: null, seller_name: null, is_cross_filial: false,
    origin_type: 'sale', is_troca_origin: false, has_nfce: false, vale_troca_prazo_raw: null, item_count: '1',
    items: [{ product_id: 'prod-blusa', variant_id: null, product_name_snapshot: 'BLUSA POLO FEMININA', quantity: 1, unit_price: 79.9, original_sale_item_id: ITEM, total_price: 79.9 }],
  };

  beforeEach(() => {
    jest.resetAllMocks();
    db.query.mockImplementation((sql) => {
      const s = String(sql || '');
      if (/FROM sales s/i.test(s)) return Promise.resolve({ rows: [JSON.parse(JSON.stringify(vendaRow))] });
      return Promise.resolve({ rows: [] });
    });
  });

  test('sales-for-troca: 54,90 por unidade; preco de tabela continua em unit_price', async () => {
    const res = await request(app).get(`/api/v1/companies/${EMPRESA}/pdv/sales-for-troca?q=maria`).set(adminAuth);
    expect(res.status).toBe(200);
    const [v] = res.body;
    expect(v.items[0]).toMatchObject({ unit_price: 79.9, total_price: 79.9, valor_pago_unit: 54.9, valor_pago_total: 54.9 });
    const sql = db.query.mock.calls.map((c) => String(c[0])).find((s) => /FROM sales s/i.test(s));
    expect(sql).toMatch(/s\.discount_amount/);
    expect(sql).toMatch(/ORDER BY si\.id\) FILTER/);
  });

  test('sales-by-product-barcode: mesmo campo', async () => {
    const res = await request(app).get(`/api/v1/companies/${EMPRESA}/pdv/sales-by-product-barcode?barcode=7891234567890`).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body[0].items[0].valor_pago_unit).toBe(54.9);
  });

  test('comValorPago nao mexe em venda sem itens', () => {
    const r = { id: 'x', items: [] };
    expect(comValorPago(r, '10')).toEqual({ id: 'x', items: [] });
  });
});
