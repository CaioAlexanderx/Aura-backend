// ============================================================
// AURA. — Paridade: o pedido da loja comum SO de prateleira grava o mesmo
// que gravava antes do p-184 (loja unica 3.4b, 17/11/2026)
//
// O p-184 ensina o POST /storefront/:slug/order a gravar o pedido com peca
// personalizavel na Fila (vertical 'studio'). Quem nao vende personalizado
// nao pode sentir nada. Este teste roda quatro pedidos so de prateleira
// (Pix manual com variante, Pix do Mercado Pago com desconto e chave de
// idempotencia, cartao, pagar na entrega com aceite) e compara com o
// registro gravado na main de ANTES da mudanca (cb400bad):
//   - cada consulta da transacao do pedido, na ordem, com SQL e parametros
//     (o INSERT do pedido sem `vertical`, os INSERT dos itens sem
//     `customization`);
//   - cada escrita fora da transacao (Pix guardado, resposta guardada);
//   - os argumentos do Pix e do cartao do Mercado Pago (o Pix sem
//     `horasDeValidade`: vale as 24 h de sempre);
//   - a resposta, campo a campo.
//
// Regravar o registro (so com motivo, e dizendo no PR):
//   GRAVAR_PARIDADE=1 npx jest __tests__/pedidoDaLojaSoPrateleira.paridade.test.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../src/services/pixService', () => ({
  generatePix: jest.fn(async () => ({
    payment_id: null, qrcode: null, payload: '000201PIXDETESTE', expires_at: null, mode: 'manual',
  })),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(async () => {}),
  notifyManualPixOrder: jest.fn(async () => {}),
  notifyPedidoAAceitar: jest.fn(async () => {}),
}));
jest.mock('../src/services/digitalOrderConfirmation', () => ({ onOrderConfirmed: jest.fn(async () => {}) }));
jest.mock('../src/services/mpGateway', () => ({ gatewayAtivo: jest.fn(async () => null) }));
jest.mock('../src/services/mpService', () => ({
  createMpPixPayment: jest.fn(async () => ({
    payment_id: 'mp-pix-1', qrcode: 'QR', payload: 'PAYLOAD', expires_at: '2026-11-18T15:00:00.000Z',
  })),
  createMpPreference: jest.fn(async () => ({ init_point: 'https://mp.test/checkout', preference_id: 'pref-1' })),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const mpGateway = require('../src/services/mpGateway');
const mpService = require('../src/services/mpService');
const precoEfetivo = require('../src/services/precoEfetivo');
const vendaNaPromocao = require('../src/services/vendaNaPromocao');
const pedidoIdem = require('../src/services/pedidoOnlineIdempotente');

const ARQUIVO = path.join(__dirname, 'fixtures', 'pedidoDaLojaSoPrateleira', 'registro.json');
const CID = 'c0000000-0000-0000-0000-0000000000a1';
const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const V2 = '33333333-3333-3333-3333-333333333333';

const PRODUTOS = [
  { id: P1, name: 'BLUSA', price: '100.00', stock_qty: 10, image_url: 'https://img/blusa.jpg', is_active: true,
    promo_price: null, promo_starts_at: null, promo_ends_at: null },
  { id: P2, name: 'SAIA', price: '80.00', stock_qty: 0, image_url: null, is_active: true,
    promo_price: null, promo_starts_at: null, promo_ends_at: null },
];
const VARIANTES = [
  { id: V2, product_id: P2, price_override: '90.00', stock_qty: 4, is_active: true, label: 'M',
    promo_price: null, promo_starts_at: null, promo_ends_at: null },
];

let config;
let registro;

function leitura(sql) {
  if (/information_schema\.columns/.test(sql)) return { rows: [{ n: 2 }] };
  if (/FROM digital_channel_config/.test(sql)) return { rows: [config] };
  if (/SELECT product_id, COUNT\(\*\) AS cnt/.test(sql)) return { rows: [{ product_id: P2, cnt: '1' }] };
  if (/FROM product_variants pv/.test(sql)) return { rows: VARIANTES };
  if (/FROM products/.test(sql)) return { rows: PRODUTOS };
  return { rows: [] };
}

const ehEscrita = (sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);

beforeEach(() => {
  precoEfetivo._resetarParaTeste();
  vendaNaPromocao._resetarParaTeste();
  pedidoIdem._resetCache();
  registro = { transacao: [], escritas: [] };
  mpGateway.gatewayAtivo.mockReset();
  mpGateway.gatewayAtivo.mockResolvedValue(null);
  mpService.createMpPixPayment.mockClear();
  mpService.createMpPreference.mockClear();
  db.query.mockReset();
  db.connect.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    if (ehEscrita(s)) registro.escritas.push({ sql: s, params: params || null });
    return leitura(s);
  });
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      registro.transacao.push({ sql: s, params: params || null });
      if (/INSERT INTO digital_orders/.test(s)) {
        return { rows: [{ id: 'o1', order_number: 7, company_id: params[0], customer_name: params[1] }] };
      }
      if (/INSERT INTO digital_order_items/.test(s)) return { rows: [] };
      return leitura(s);
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

const BASE = {
  customer_name: 'Cliente Teste', customer_phone: '11999990000', customer_email: 'cliente@example.test',
  delivery_type: 'pickup',
  items: [{ product_id: P1, quantity: 2 }, { product_id: P2, variant_id: V2, quantity: 1 }],
};
const LOJA = { company_id: CID, pickup_enabled: true, company_display_name: 'Loja Teste', slug: 'loja' };

const CENARIOS = {
  pix_manual_com_variante: {
    config: { ...LOJA, pix_key: 'chave@loja.test' },
    corpo: { ...BASE, payment_method: 'pix' },
  },
  pix_mercado_pago_desconto_e_chave: {
    config: { ...LOJA, pix_key: null, pix_discount_pct: '5' },
    gateway: { access_token: 'tok' },
    chave: 'chave-de-teste-0001',
    corpo: { ...BASE, payment_method: 'pix' },
  },
  cartao: {
    config: { ...LOJA, card_enabled: true },
    gateway: { access_token: 'tok' },
    corpo: { ...BASE, payment_method: 'card', customer_cpf_cnpj: '52998224725' },
  },
  na_entrega_com_aceite: {
    config: { ...LOJA, pay_on_delivery_enabled: true, pay_on_delivery_methods: ['cash', 'pix'] },
    corpo: { ...BASE, payment_method: 'on_delivery', pay_on_delivery_method: 'cash', change_for: 400 },
  },
};

async function rodar(nome) {
  const c = CENARIOS[nome];
  config = c.config;
  if (c.gateway) mpGateway.gatewayAtivo.mockResolvedValue(c.gateway);
  let req = request(app()).post('/storefront/loja/order');
  if (c.chave) req = req.set('Idempotency-Key', c.chave);
  const r = await req.send(c.corpo);
  return {
    status: r.status,
    resposta: r.body,
    transacao: registro.transacao,
    escritas: registro.escritas,
    pix_mp: mpService.createMpPixPayment.mock.calls,
    cartao_mp: mpService.createMpPreference.mock.calls,
  };
}

describe('pedido so de prateleira: mesmo registro de antes do p-184', () => {
  const gravar = process.env.GRAVAR_PARIDADE === '1';
  const guardado = gravar || !fs.existsSync(ARQUIVO) ? {} : JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
  const novo = {};

  afterAll(() => {
    if (!gravar) return;
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
    fs.writeFileSync(ARQUIVO, `${JSON.stringify(novo, null, 2)}\n`);
  });

  test.each(Object.keys(CENARIOS))('%s', async (nome) => {
    const atual = JSON.parse(JSON.stringify(await rodar(nome)));
    expect(atual.status).toBe(201);
    if (gravar) { novo[nome] = atual; return; }
    expect(guardado[nome]).toBeDefined();
    expect(atual).toEqual(guardado[nome]);
  });

  test('o pedido nasce sem vertical nem etapa da Fila', async () => {
    const r = await rodar('pix_manual_com_variante');
    const insert = r.transacao.find((q) => /INSERT INTO digital_orders/.test(q.sql));
    expect(insert.sql).not.toMatch(/vertical|studio_production_status/);
    for (const item of r.transacao.filter((q) => /INSERT INTO digital_order_items/.test(q.sql))) {
      expect(item.sql).not.toMatch(/customization|art_review_status/);
    }
    expect(r.resposta).not.toHaveProperty('studio_production_status');
    expect(r.resposta).not.toHaveProperty('personalizado');
  });
});
