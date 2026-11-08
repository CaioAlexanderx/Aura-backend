// ============================================================
// AURA. — Pedido da loja online cobra o preco efetivo (De/Por, p-85)
//
// O servidor refaz o preco do pedido (nao confia no cliente). Com a 427:
//   - peca em promocao: o item e o total saem pelo preco de promocao
//     (o mesmo `price` que a vitrine mostra e o carrinho soma);
//   - agendada ou vencida: preco normal;
//   - variante com preco proprio e promocao propria; variante sem preco
//     proprio segue a promocao do produto;
//   - base sem a 427 (42703): preco normal, pedido de pe.
// Banco simulado, no arreio do pedidoOnlineIdempotente.test.js.
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
const { _resetarParaTeste } = require('../src/services/precoEfetivo');

const DIA = 864e5;
const ATIVA = () => ({ promo_starts_at: new Date(Date.now() - DIA), promo_ends_at: new Date(Date.now() + 7 * DIA) });

let produtos;
let variantes;
let comVariantes;
let itens;
let pedidos;
let semMigration;

function consulta(sql) {
  // Coluna de verdade ("promo_price AS ..."); o degrau sem a 427 manda NULL::numeric.
  if (semMigration && /[\s.,]promo_price AS/.test(sql)) {
    const e = new Error('column "promo_price" does not exist');
    e.code = '42703';
    throw e;
  }
  if (/FROM digital_channel_config/.test(sql)) {
    return { rows: [{ company_id: 'c1', pickup_enabled: true, pix_key: 'chave', company_display_name: 'Loja' }] };
  }
  if (/SELECT product_id, COUNT\(\*\) AS cnt/.test(sql)) return { rows: comVariantes };
  if (/FROM product_variants pv/.test(sql)) return { rows: variantes };
  if (/FROM products/.test(sql)) return { rows: produtos };
  return { rows: [] };
}

beforeEach(() => {
  _resetarParaTeste();
  semMigration = false;
  comVariantes = [];
  variantes = [];
  itens = [];
  pedidos = [];
  db.query.mockReset();
  db.connect.mockReset();
  db.query.mockImplementation(async (sql) => consulta(String(sql)));
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO digital_orders/.test(s)) {
        const p = { id: 'o1', order_number: 1, company_id: params[0], subtotal: params[7], total: params[8] };
        pedidos.push(p);
        return { rows: [p] };
      }
      if (/INSERT INTO digital_order_items/.test(s)) {
        itens.push({ product_id: params[1], unit_price: params[4], quantity: params[5], variant_id: params[7] });
        return { rows: [] };
      }
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

test('peca em promocao: item e total pelo preco de promocao', async () => {
  produtos = [peca({ promo_price: '79.90', ...ATIVA() })];
  const r = await pedir([{ product_id: 'p1', quantity: 2 }]);
  expect(r.status).toBe(201);
  expect(itens).toEqual([{ product_id: 'p1', unit_price: 79.9, quantity: 2, variant_id: null }]);
  expect(Number(pedidos[0].subtotal)).toBeCloseTo(159.8, 2);
});

test('sem promocao, agendada e vencida: preco normal', async () => {
  for (const extra of [
    {},
    { promo_price: '79.90', promo_starts_at: new Date(Date.now() + DIA), promo_ends_at: new Date(Date.now() + 7 * DIA) },
    { promo_price: '79.90', promo_starts_at: new Date(Date.now() - 7 * DIA), promo_ends_at: new Date(Date.now() - DIA) },
  ]) {
    produtos = [peca(extra)];
    itens = [];
    const r = await pedir([{ product_id: 'p1', quantity: 1 }]);
    expect(r.status).toBe(201);
    expect(itens[0].unit_price).toBe(100);
  }
});

test('variante com preco proprio em promocao; variante que herda a do produto', async () => {
  produtos = [peca({ promo_price: '80.00', ...ATIVA() })];
  comVariantes = [{ product_id: 'p1', cnt: '2' }];
  variantes = [
    { id: 'vG', product_id: 'p1', price_override: '120.00', stock_qty: 5, is_active: true, label: 'Tamanho: G',
      promo_price: '99.00', ...ATIVA() },
    { id: 'vP', product_id: 'p1', price_override: null, stock_qty: 5, is_active: true, label: 'Tamanho: P',
      promo_price: null, promo_starts_at: null, promo_ends_at: null },
  ];
  const r = await pedir([{ product_id: 'p1', variant_id: 'vG', quantity: 1 }, { product_id: 'p1', variant_id: 'vP', quantity: 1 }]);
  expect(r.status).toBe(201);
  expect(itens.map((i) => [i.variant_id, i.unit_price])).toEqual([['vG', 99], ['vP', 80]]);
});

test('base sem a 427: preco normal, pedido de pe', async () => {
  semMigration = true;
  produtos = [peca()];
  const r = await pedir([{ product_id: 'p1', quantity: 1 }]);
  expect(r.status).toBe(201);
  expect(itens[0].unit_price).toBe(100);
});
