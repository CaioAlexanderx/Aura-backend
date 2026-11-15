// ============================================================
// AURA. — O pedido da loja online entra em "Vendas na promocao" (p-123a)
//
// QA na loja real (14/11/2026): pedido confirmado a preco promocional e a
// Promocao em lote dizia "Ainda sem vendas na promocao" — a conta so olhava
// o Caixa. Com a migration 452:
//   - o item do pedido grava preco_lista/em_promocao na hora do pedido, pela
//     mesma regra do Caixa (vendaNaPromocao.marcacaoDoItem);
//   - base sem a 452: o item grava como antes;
//   - o resumo soma os pedidos CONFIRMADOS da loja ao Caixa; sem a 452, so
//     o Caixa, com o SQL de antes.
// Banco simulado, no arreio do pedidoOnlineDePor.test.js. A conta no
// Postgres de verdade: vendidosNaPromocao.banco.test.js.
// ============================================================
'use strict';

jest.mock('../src/services/pixService', () => ({
  generatePix: jest.fn(async () => ({
    payment_id: null, qrcode: null, payload: '000201PIXDETESTE', expires_at: null, mode: 'manual',
  })),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn() }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(async () => {}),
  notifyManualPixOrder: jest.fn(async () => {}),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const precoEfetivo = require('../src/services/precoEfetivo');
const vendaNaPromocao = require('../src/services/vendaNaPromocao');

const DIA = 864e5;
const ATIVA = () => ({ promo_starts_at: new Date(Date.now() - DIA), promo_ends_at: new Date(Date.now() + 7 * DIA) });

let produtos;
let variantes;
let comVariantes;
let inserts;
let colunas452;

function consulta(sql) {
  if (/information_schema\.columns/.test(sql) && /digital_order_items/.test(sql)) return { rows: [{ n: colunas452 ? 2 : 0 }] };
  if (/FROM digital_channel_config/.test(sql)) {
    return { rows: [{ company_id: 'c1', pickup_enabled: true, pix_key: 'chave', company_display_name: 'Loja' }] };
  }
  if (/SELECT product_id, COUNT\(\*\) AS cnt/.test(sql)) return { rows: comVariantes };
  if (/FROM product_variants pv/.test(sql)) return { rows: variantes };
  if (/FROM products/.test(sql)) return { rows: produtos };
  return { rows: [] };
}

beforeEach(() => {
  precoEfetivo._resetarParaTeste();
  vendaNaPromocao._resetarParaTeste();
  colunas452 = true;
  comVariantes = [];
  variantes = [];
  inserts = [];
  db.query.mockReset();
  db.connect.mockReset();
  db.query.mockImplementation(async (sql) => consulta(String(sql)));
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO digital_orders/.test(s)) return { rows: [{ id: 'o1', order_number: 1, company_id: params[0] }] };
      if (/INSERT INTO digital_order_items/.test(s)) { inserts.push({ sql: s, params }); return { rows: [] }; }
      return consulta(s);
    }),
    release: jest.fn(),
  }));
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/storefront', require('../src/routes/storefront'));
  return a;
}
const pedir = (items) => request(app()).post('/storefront/loja/order').send({
  customer_name: 'Cliente', customer_phone: '11999999999', delivery_type: 'pickup', payment_method: 'pix', items,
});
const peca = (extra) => ({ id: 'p1', name: 'BLUSA', price: '100.00', stock_qty: 10, image_url: null, is_active: true,
  promo_price: null, promo_starts_at: null, promo_ends_at: null, ...extra });

describe('o item do pedido guarda a promocao', () => {
  test('peca em promocao: preco_lista = De, em_promocao = true; sem promocao: false', async () => {
    produtos = [peca({ promo_price: '79.90', ...ATIVA() }), peca({ id: 'p2', name: 'SAIA', price: '50.00' })];
    const r = await pedir([{ product_id: 'p1', quantity: 2 }, { product_id: 'p2', quantity: 1 }]);
    expect(r.status).toBe(201);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].sql).toMatch(/preco_lista, em_promocao/);
    expect(inserts[0].params.slice(4, 6)).toEqual([79.9, 2]);
    expect(inserts[0].params.slice(8)).toEqual([100, true]);
    expect(inserts[1].params.slice(8)).toEqual([null, false]);
  });

  test('variante com promocao propria: De = preco da variante', async () => {
    produtos = [peca()];
    comVariantes = [{ product_id: 'p1', cnt: '1' }];
    variantes = [{ id: 'vG', product_id: 'p1', price_override: '120.00', stock_qty: 5, is_active: true, label: 'G',
      promo_price: '99.00', ...ATIVA() }];
    const r = await pedir([{ product_id: 'p1', variant_id: 'vG', quantity: 1 }]);
    expect(r.status).toBe(201);
    expect(inserts[0].params.slice(4, 5)).toEqual([99]);
    expect(inserts[0].params.slice(8)).toEqual([120, true]);
  });

  test('base sem a 452: o item grava como antes', async () => {
    colunas452 = false;
    produtos = [peca({ promo_price: '79.90', ...ATIVA() })];
    const r = await pedir([{ product_id: 'p1', quantity: 1 }]);
    expect(r.status).toBe(201);
    expect(inserts[0].sql).not.toMatch(/preco_lista/);
    expect(inserts[0].params).toHaveLength(8);
  });
});

describe('o resumo soma a loja online', () => {
  const periodo = { companyIds: ['c1'], desde: new Date('2026-11-01T03:00:00Z'), ate: new Date('2026-12-01T02:59:59Z') };
  const q452 = (presente, tot) => jest.fn(async (sql) => {
    const s = String(sql);
    if (/information_schema\.columns/.test(s)) return { rows: [{ n: presente ? 2 : 0 }] };
    if (/pedidos_loja_online/.test(s)) return { rows: [tot] };
    return { rows: [] };
  });

  test('com a 452: Caixa e pedidos confirmados, e quantos sao da loja', async () => {
    const q = q452(true, { itens_vendidos: '7', faturamento: '660', desconto_dado: '140', vendas: 4, pedidos_loja_online: 1 });
    const r = await vendaNaPromocao.resumoDosVendidos(q, periodo);
    expect(r.resumo).toEqual({ itens_vendidos: 7, faturamento: 660, desconto_dado: 140, vendas: 4 });
    expect(r).toMatchObject({ pedidos_loja_online: 1, conta_loja_online: true });
    const sql = String(q.mock.calls.find(([s]) => /pedidos_loja_online/.test(String(s)))[0]);
    expect(sql).toMatch(/UNION ALL/);
    expect(sql).toMatch(/FROM digital_order_items oi JOIN digital_orders o/);
    expect(sql).toContain("o.status::text IN ('confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered')");
    expect(sql).toContain('oi.em_promocao = true');
    expect(sql).toContain('COALESCE(o.confirmed_at, o.created_at) >= $2::timestamptz');
  });

  test('sem a 452: so o Caixa', async () => {
    const q = q452(false, { itens_vendidos: '0', faturamento: '0', desconto_dado: '0', vendas: 0, pedidos_loja_online: 0 });
    const r = await vendaNaPromocao.resumoDosVendidos(q, periodo);
    expect(r).toMatchObject({ pedidos_loja_online: 0, conta_loja_online: false, items: [], por_loja: [] });
    const sql = String(q.mock.calls.find(([s]) => /pedidos_loja_online/.test(String(s)))[0]);
    expect(sql).not.toMatch(/digital_order/);
  });
});
