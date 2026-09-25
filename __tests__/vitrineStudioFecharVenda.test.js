// ============================================================
// Vitrine Studio · Fase 2 "Fechar a venda" — backend (B1, B2, B3)
//
// B1  POST /studio/order: pedido_token/pedido_url, customer_document com a
//     validacao da loja comum, retirada por app "informo depois", servico
//     de arte cobrado uma vez por linha, Pix guardado no pedido. E o
//     corpo de HOJE (app em producao com a chave desligada) continua
//     funcionando igual.
// B2  GET /studio/pedido/:token: a confirmacao que sobrevive ao F5, sem
//     telefone, e-mail, CPF nem endereco completo.
// B3  POST /studio/cotacao: as MESMAS funcoes do pedido. O teste central
//     deste arquivo e "para o mesmo corpo, cotacao e pedido dao o mesmo
//     total".
//
// MOCK POR SQL, NUNCA POR POSICAO (CLAUDE.md). db.query vem do mock
// global (tests/jest.setup.js).
// ============================================================
'use strict';

jest.mock('../src/services/pixService', () => ({ generatePix: jest.fn() }));
jest.mock('../src/services/mpService', () => ({
  createMpPixPayment: jest.fn(), createMpPreference: jest.fn(),
}));
jest.mock('../src/services/digitalOrderNotifications', () => ({
  notifyPaymentConfirmed: jest.fn(() => Promise.resolve()),
  notifyManualPixOrder: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/digitalOrderConfirmation', () => ({
  onOrderConfirmed: jest.fn(() => Promise.resolve()),
}));
jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn() }));
jest.mock('../src/services/shippingQuote', () => ({ calculateShippingQuote: jest.fn() }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { generatePix } = require('../src/services/pixService');
const { createMpPixPayment, createMpPreference } = require('../src/services/mpService');
const { calculateShippingQuote } = require('../src/services/shippingQuote');
const { limparCache } = require('../src/services/lojaDeTeste');

const CID = 'c0000000-0000-0000-0000-000000000001';
const TOKEN = 'a3f1c2d4e5b6978812ab34cd56ef7890';
const CPF_OK = '52998224725';

const ARTE = {
  id: 'art_service', type: 'option', label: 'Arte',
  config: { is_art_service: true, choices: [
    { value: 'none', label: 'Vou enviar minha arte pronta', price_delta: 0 },
    { value: 'adjust', label: 'Envio minha arte e vocês ajustam', price_delta: 10 },
    { value: 'designer', label: 'Criem a arte pra mim', price_delta: 30 },
  ] },
};
const COR = {
  id: 'cor', type: 'option', label: 'Cor da alça',
  config: { choices: [{ value: 'rosa', label: 'Rosa', price_delta: 2.5 }, { value: 'branca', label: 'Branca', price_delta: 0 }] },
};
const TEXTO = { id: 'nome', type: 'text', label: 'Arte' };
const FOTO = { id: 'foto', type: 'image', label: 'Sua foto' };

const PRODUTOS = {
  p1: {
    id: 'p1', name: 'Caneca Alça Coração', price: '57.90', stock_qty: 10, image_url: 'https://r2/caneca.jpg',
    is_active: true, is_personalizable: true,
    customization_config: {
      fields: [ARTE, COR, TEXTO, FOTO],
      has_back: true, back_charge_enabled: true, back_price_delta: 8,
      has_middle: true, middle_charge_enabled: true, middle_price_delta: 4,
    },
  },
  p2: {
    id: 'p2', name: 'Caneca Branca', price: '39.90', stock_qty: 10, image_url: null,
    is_active: true, is_personalizable: true, customization_config: { fields: [ARTE] },
  },
};

let loja;
let gateways;
let regras;
let sandbox;
let pedidoRow;
let itensRow;
let inserts;
let updates;

function lojaPadrao() {
  return {
    company_id: CID, slug: 'sheid-mania', site_name: 'Sheid Mania', company_display_name: 'Sheid LTDA',
    pickup_enabled: true, delivery_enabled: true, courier_pickup_enabled: true, delivery_fee: '12.00',
    pix_key: 'chave@sheid.com', pix_discount_pct: 5, pay_on_delivery_enabled: true,
    address: 'Rua das Flores, 100 - Centro', pickup_eta_text: 'Retire em 3 dias úteis',
    delivery_eta_text: 'Chega 1 dia útil depois de pronto',
    whatsapp: '5512996145447', is_published: true,
    studio_settings: { default_sla_days: 3, max_revisions_included: 2, extra_revision_price: 10 },
  };
}

function mockBanco() {
  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql);
    if (/is_sandbox/.test(s)) return { rows: [{ is_sandbox: sandbox }] };
    if (/FROM digital_channel_config/.test(s)) return { rows: loja ? [loja] : [] };
    if (/FROM companies_payment_gateways/.test(s)) return { rows: gateways };
    if (/FROM studio_pricing_rules/.test(s)) return { rows: regras };
    if (/FROM products/.test(s)) {
      const ids = params[0] || [];
      return { rows: ids.map((id) => PRODUTOS[id]).filter(Boolean) };
    }
    if (/FROM digital_order_items i/.test(s)) return { rows: itensRow };
    if (/FROM digital_orders o/.test(s) && /public_token = \$1/.test(s)) {
      if (typeof pedidoRow === 'function') return pedidoRow(s, params);
      return { rows: pedidoRow && params[0] === TOKEN && params[1] === CID ? [pedidoRow] : [] };
    }
    if (/^\s*UPDATE digital_orders/.test(s)) { updates.push({ sql: s, params }); return { rows: [] }; }
    return { rows: [] };
  });
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO digital_orders/.test(s)) {
        inserts.pedido = params;
        return { rows: [{ id: 'o1', order_number: '00123', company_id: CID, public_token: TOKEN, created_at: new Date().toISOString() }] };
      }
      if (/INSERT INTO digital_order_items/.test(s)) { inserts.itens.push(params); }
      return { rows: [] };
    }),
    release: jest.fn(),
  }));
}

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/storefront', require('../src/routes/studioStorefront'));
  return app;
}
const app = makeApp();

const CLIENTE = { customer_name: 'Helena Souza', customer_phone: '12999990000', customer_email: 'helena@exemplo.com' };
const pedir = (corpo) => request(app).post('/storefront/sheid-mania/studio/order').send({ ...CLIENTE, ...corpo });
const cotar = (corpo) => request(app).post('/storefront/sheid-mania/studio/cotacao').send(corpo);

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  generatePix.mockReset();
  createMpPixPayment.mockReset();
  createMpPreference.mockReset();
  calculateShippingQuote.mockReset();
  limparCache();
  loja = lojaPadrao();
  gateways = [];
  regras = [];
  sandbox = false;
  pedidoRow = null;
  itensRow = [];
  inserts = { pedido: null, itens: [] };
  updates = [];
  generatePix.mockImplementation(async ({ order, total }) => ({
    payment_id: 'manual-' + order.id, qrcode: null,
    payload: `000201PIX-${Number(total).toFixed(2)}`, expires_at: null, mode: 'manual',
  }));
  mockBanco();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

// ─────────────────────────────────────────────────────────────
// B3 — cotacao e pedido dao o MESMO total
// ─────────────────────────────────────────────────────────────
describe('B3 · cotacao = pedido', () => {
  const r2 = (v) => Math.round(v * 100) / 100;

  const CENARIOS = [
    ['uma caneca simples no Pix', {
      payment_method: 'pix', delivery_type: 'pickup',
      items: [{ product_id: 'p2', quantity: 1, customization: { art_service: 'none' } }],
    }],
    ['arte ajustada em 2 unidades, verso, meio e cor', {
      payment_method: 'pix', delivery_type: 'pickup',
      items: [{ product_id: 'p1', quantity: 2, customization: {
        art_service: 'adjust', cor: 'rosa', nome: 'Mãe', foto: 'https://r2/f.png',
        has_back_selected: true, has_middle_selected: true,
      } }],
    }],
    ['duas linhas, faixa de quantidade e cartao', {
      payment_method: 'card', delivery_type: 'pickup',
      items: [
        { product_id: 'p1', quantity: 12, customization: { art_service: 'designer', cor: 'branca' } },
        { product_id: 'p2', quantity: 3, customization: { art_service: 'adjust' } },
      ],
    }],
    ['entrega com CEP no Pix', {
      payment_method: 'pix', delivery_type: 'delivery', cep: '12242000', address_zip: '12242000',
      address_street: 'Rua A', address_number: '10', address_neighborhood: 'Jardim Colonial',
      address_city: 'São José dos Campos', address_state: 'SP',
      items: [{ product_id: 'p1', quantity: 5, customization: { art_service: 'none', foto: 'u' } }],
    }],
    ['entrega sem CEP (taxa fixa) na retirada', {
      payment_method: 'on_delivery', delivery_type: 'delivery',
      items: [{ product_id: 'p2', quantity: 7, customization: { art_service: 'designer' } }],
    }],
  ];

  beforeEach(() => {
    regras = [{ product_id: 'p1', qty_tiers: [{ min_qty: 10, unit_multiplier: 0.9, lead_days: 5 }] }];
    gateways = [{ id: 'g1', access_token: 'tok', public_key: 'pk' }];
    calculateShippingQuote.mockResolvedValue({ fee: 18.5, mode: 'distance', currency: 'BRL', distance_km: 12 });
    createMpPixPayment.mockResolvedValue({ payment_id: '999', qrcode: 'QRB64', payload: '000201MP', expires_at: '2026-09-28T14:00:00Z', mode: 'mp' });
    createMpPreference.mockResolvedValue({ preference_id: 'pref', init_point: 'https://mp/checkout' });
  });

  test.each(CENARIOS)('%s', async (_nome, corpo) => {
    const c = await cotar(corpo);
    expect(c.status).toBe(200);
    const p = await pedir(corpo);
    expect(p.status).toBe(201);

    expect(c.body.subtotal).toBe(r2(p.body.subtotal));
    expect(c.body.total).toBe(r2(p.body.total));
    expect(c.body.frete ?? 0).toBe(r2(p.body.delivery_fee));
    // Linha a linha, contra o que foi GRAVADO em digital_order_items.
    expect(inserts.itens).toHaveLength(corpo.items.length);
    c.body.itens.forEach((linha, i) => {
      expect(linha.preco_unitario).toBe(r2(inserts.itens[i][4]));
      expect(linha.total).toBe(r2(inserts.itens[i][6]));
    });
    // E o total gravado no pedido.
    expect(c.body.total).toBe(r2(inserts.pedido[8]));
  });

  test('o detalhe explica a linha: base com faixa, opcoes, verso, meio e arte uma vez', async () => {
    const c = await cotar({ items: [{ product_id: 'p1', quantity: 10, customization: {
      art_service: 'adjust', cor: 'rosa', has_back_selected: true, has_middle_selected: true, foto: 'u',
    } }] });
    expect(c.body.itens[0]).toEqual({
      indice: 0,
      preco_unitario: r2(57.9 * 0.9 + 2.5 + 8 + 4),
      total: r2((57.9 * 0.9 + 2.5 + 8 + 4) * 10 + 10),
      detalhe: { base: 52.11, opcoes: 2.5, verso: 8, meio: 4, arte: 10, faixa: { min_qty: 10, pct: 10 } },
    });
    expect(c.body.prazo_dias_uteis).toBe(5);
  });

  test('sem forma de pagamento: total cheio, total_pix com o desconto da loja', async () => {
    const c = await cotar({ items: [{ product_id: 'p2', quantity: 1, customization: {} }] });
    expect(c.body).toMatchObject({ subtotal: 39.9, desconto_pix: 2, total: 39.9, total_pix: 37.9, frete: null });
  });

  test('loja sem Pix nao anuncia desconto de Pix', async () => {
    loja.pix_key = null;
    gateways = [];
    const c = await cotar({ payment_method: 'pix', items: [{ product_id: 'p2', quantity: 1, customization: {} }] });
    expect(c.body.desconto_pix).toBe(0);
    expect(c.body.total_pix).toBe(39.9);
  });

  test('CEP fora da area nao derruba a cotacao: frete null e o recado', async () => {
    calculateShippingQuote.mockResolvedValue({ fee: null, error: 'Fora da area de entrega', distance_km: 94 });
    const c = await cotar({ delivery_type: 'delivery', cep: '01310100', items: [{ product_id: 'p2', quantity: 1, customization: {} }] });
    expect(c.status).toBe(200);
    expect(c.body.frete).toBeNull();
    expect(c.body.frete_erro).toBe('Fora da area de entrega');
  });

  test('item recusado: 400 com a mesma mensagem do pedido e o indice da linha', async () => {
    const corpo = { items: [{ product_id: 'p2', quantity: 1, customization: {} }, { product_id: 'nao-existe', quantity: 1 }] };
    const c = await cotar(corpo);
    const p = await pedir(corpo);
    expect(c.status).toBe(400);
    expect(c.body).toEqual({ error: 'Produto nao-existe nao encontrado', indice: 1 });
    expect(p.status).toBe(400);
    expect(p.body.error).toBe(c.body.error);
  });

  test('loja inexistente: 404; sacola vazia: 400; nada e gravado', async () => {
    loja = null;
    expect((await cotar({ items: [{ product_id: 'p2' }] })).status).toBe(404);
    loja = lojaPadrao();
    expect((await cotar({ items: [] })).status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────
// B1 — o pedido
// ─────────────────────────────────────────────────────────────
describe('B1 · POST /studio/order', () => {
  const UM_ITEM = { items: [{ product_id: 'p2', quantity: 1, customization: {} }] };

  test('devolve pedido_token e pedido_url no endereco da loja', async () => {
    const r = await pedir({ ...UM_ITEM, payment_method: 'pix' });
    expect(r.status).toBe(201);
    expect(r.body.pedido_token).toBe(TOKEN);
    expect(r.body.pedido_url).toBe(`https://loja.getaura.com.br/sheid-mania/pedido/${TOKEN}`);
    // O que ja existia continua la.
    expect(r.body).toMatchObject({ order_id: 'o1', order_number: '00123', status: 'pending_payment' });
    expect(r.body.track_url).toContain(`/acompanhar/${TOKEN}`);
  });

  test('com dominio proprio ativo, a URL e a dele', async () => {
    loja.custom_domain = 'www.sheidmania.com.br';
    loja.custom_domain_status = 'active';
    const r = await pedir({ ...UM_ITEM, payment_method: 'pix' });
    expect(r.body.pedido_url).toBe(`https://www.sheidmania.com.br/pedido/${TOKEN}`);
  });

  test('sem a migration 322 (sem token): os dois campos null', async () => {
    db.connect.mockImplementation(() => ({
      query: jest.fn(async (sql) => (/INSERT INTO digital_orders/.test(String(sql))
        ? { rows: [{ id: 'o1', order_number: '00123', company_id: CID }] } : { rows: [] })),
      release: jest.fn(),
    }));
    const r = await pedir({ ...UM_ITEM, payment_method: 'pix' });
    expect(r.status).toBe(201);
    expect(r.body.pedido_token).toBeNull();
    expect(r.body.pedido_url).toBeNull();
  });

  describe('customer_document', () => {
    test('CPF valido e gravado so com os digitos, onde a loja comum grava', async () => {
      const r = await pedir({ ...UM_ITEM, customer_document: '529.982.247-25' });
      expect(r.status).toBe(201);
      expect(inserts.pedido[12]).toBe(CPF_OK);
    });

    test('CNPJ valido tambem', async () => {
      const r = await pedir({ ...UM_ITEM, customer_document: '11.222.333/0001-81' });
      expect(r.status).toBe(201);
      expect(inserts.pedido[12]).toBe('11222333000181');
    });

    test('digito errado: 400 em portugues', async () => {
      const r = await pedir({ ...UM_ITEM, customer_document: '529.982.247-24' });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('CPF/CNPJ invalido');
    });

    test('vazio e ignorado', async () => {
      const r = await pedir({ ...UM_ITEM, customer_document: '  ' });
      expect(r.status).toBe(201);
      expect(inserts.pedido[12]).toBeNull();
    });

    test('o corpo antigo (customer_cpf_cnpj) continua valendo', async () => {
      const r = await pedir({ ...UM_ITEM, customer_cpf_cnpj: CPF_OK });
      expect(r.status).toBe(201);
      expect(inserts.pedido[12]).toBe(CPF_OK);
    });
  });

  describe('retirada por app', () => {
    test('"informo depois" dispensa nome e placa e grava null', async () => {
      const r = await pedir({ ...UM_ITEM, delivery_type: 'courier', courier_informar_depois: true });
      expect(r.status).toBe(201);
      expect(inserts.pedido[21]).toBeNull();
      expect(inserts.pedido[22]).toBeNull();
    });

    test('sem a bandeira, a validacao de hoje continua', async () => {
      const r = await pedir({ ...UM_ITEM, delivery_type: 'courier' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/nome do entregador/);
    });

    test('bandeira em loja sem a modalidade ainda recusa', async () => {
      loja.courier_pickup_enabled = false;
      const r = await pedir({ ...UM_ITEM, delivery_type: 'courier', courier_informar_depois: true });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/nao disponivel/);
    });

    test('com nome e placa, grava como sempre', async () => {
      const r = await pedir({ ...UM_ITEM, delivery_type: 'courier', courier_name: 'Rogério', courier_plate: 'fxt-4a12' });
      expect(r.status).toBe(201);
      expect(inserts.pedido[21]).toBe('Rogério');
      expect(inserts.pedido[22]).toBe('FXT4A12');
    });
  });

  test('servico de arte: 2 canecas com ajuste pagam o ajuste uma vez', async () => {
    const r = await pedir({ payment_method: 'on_delivery', items: [
      { product_id: 'p2', quantity: 2, customization: { art_service: 'adjust' } },
    ] });
    expect(r.status).toBe(201);
    expect(r.body.subtotal).toBeCloseTo(89.8, 10); // antes: 99,80
    const [, , , , unit, qty, subtotal] = inserts.itens[0];
    expect(unit).toBeCloseTo(39.9, 10);
    expect(qty).toBe(2);
    expect(subtotal).toBeCloseTo(89.8, 10);
  });

  test('cartao: o Mercado Pago recebe a arte como item proprio', async () => {
    gateways = [{ access_token: 'tok', public_key: 'pk' }];
    createMpPreference.mockResolvedValue({ preference_id: 'pref', init_point: 'https://mp/checkout' });
    const r = await pedir({ payment_method: 'card', items: [
      { product_id: 'p2', quantity: 2, customization: { art_service: 'designer' } },
    ] });
    expect(r.status).toBe(201);
    const itens = createMpPreference.mock.calls[0][0].orderItems;
    expect(itens.map((i) => [i.unit_price, i.quantity])).toEqual([[39.9, 2], [30, 1]]);
  });

  test('Pix do Mercado Pago: vale 72 h e fica guardado no pedido (sem mexer no asaas_payment_id)', async () => {
    gateways = [{ access_token: 'tok', public_key: 'pk' }];
    createMpPixPayment.mockResolvedValue({ payment_id: '999', qrcode: 'QRB64', payload: '000201MP', expires_at: '2026-09-28T14:00:00Z', mode: 'mp' });
    const r = await pedir({ ...UM_ITEM, payment_method: 'pix' });
    expect(r.status).toBe(201);
    expect(createMpPixPayment.mock.calls[0][0].horasDeValidade).toBe(72);
    const guardou = updates.find((u) => /asaas_pix_payload/.test(u.sql));
    expect(guardou.params.slice(0, 4)).toEqual(['QRB64', '000201MP', '2026-09-28T14:00:00Z', 'o1']);
    expect(guardou.sql).not.toMatch(/asaas_payment_id/);
    expect(updates.some((u) => /mp_payment_id = \$1/.test(u.sql) && u.params[0] === '999')).toBe(true);
  });

  test('Pix manual continua guardado com o id', async () => {
    const r = await pedir({ ...UM_ITEM, payment_method: 'pix' });
    expect(r.status).toBe(201);
    const guardou = updates.find((u) => /asaas_pix_payload/.test(u.sql));
    expect(guardou.sql).toMatch(/asaas_payment_id\s+= \$5/);
    expect(guardou.params[4]).toBe('manual-o1');
    expect(r.body.pix.mode).toBe('manual');
  });

  test('loja de teste: Pix de mentira guardado, valendo 72 h, sem gateway', async () => {
    sandbox = true;
    gateways = [{ access_token: 'tok', public_key: 'pk' }];
    const antes = Date.now();
    const r = await pedir({ ...UM_ITEM, payment_method: 'pix' });
    expect(r.status).toBe(201);
    expect(createMpPixPayment).not.toHaveBeenCalled();
    const guardou = updates.find((u) => /asaas_pix_payload/.test(u.sql));
    expect(guardou.params[1]).toMatch(/LOJA DE TESTE/);
    expect(guardou.params[4]).toBe('teste-o1');
    const horas = (new Date(guardou.params[2]).getTime() - antes) / 3600000;
    expect(horas).toBeGreaterThan(71.9);
    expect(horas).toBeLessThan(72.1);
  });

  test('o corpo de hoje (app em producao, chave desligada) passa igual', async () => {
    const r = await pedir({
      delivery_type: 'courier', payment_method: 'pix', notes: 'Presente',
      courier_name: 'Joao', courier_plate: 'ABC1234',
      request_nfce: false, customer_cpf_cnpj: null,
      items: [{ product_id: 'p1', quantity: 1, customization: {
        art_service: 'none', cor: 'branca', foto: 'https://r2/f.png', has_back_selected: false, has_middle_selected: false,
      } }],
    });
    expect(r.status).toBe(201);
    expect(r.body.subtotal).toBeCloseTo(57.9, 10);
    expect(r.body.total).toBeCloseTo(57.9 - 2.9, 10); // 5% no Pix
    expect(Object.keys(r.body)).toEqual(expect.arrayContaining([
      'order_id', 'order_number', 'track_url', 'total', 'delivery_fee', 'subtotal', 'status',
      'payment_method', 'shipping', 'studio_production_status', 'pix', 'card',
    ]));
  });
});

// ─────────────────────────────────────────────────────────────
// B2 — a confirmacao pelo token
// ─────────────────────────────────────────────────────────────
describe('B2 · GET /studio/pedido/:token', () => {
  const ler = (token = TOKEN, slug = 'sheid-mania') => request(app).get(`/storefront/${slug}/studio/pedido/${token}`);

  function pedidoPixPendente(extra = {}) {
    return {
      id: 'o1', company_id: CID, order_number: '00123', created_at: '2026-09-25T14:03:00.000Z',
      customer_name: 'Helena Souza Prado', status: 'pending_payment', payment_status: 'pending',
      payment_method: 'pix', subtotal: '217.69', delivery_fee: '0.00', total: '206.81',
      discount_amount: '10.88', delivery_type: 'pickup',
      address_neighborhood: null, address_city: null,
      studio_production_status: 'pending_art',
      asaas_payment_id: 'manual-o1', asaas_pix_qrcode: null, asaas_pix_payload: '000201PIX', asaas_pix_expires_at: null,
      courier_name: null, payment_proof_url: null,
      ...extra,
    };
  }

  beforeEach(() => {
    itensRow = [{
      product_id: 'p1', product_name: 'Caneca Alça Coração', quantity: 2, unit_price: '57.90', subtotal: '125.80',
      product_image: 'https://r2/caneca.jpg', customization_config: PRODUTOS.p1.customization_config,
      customization: { art_service: 'adjust', cor: 'rosa', nome: 'Mãe', foto: 'https://r2/f.png', has_back_selected: true },
    }];
  });

  test('token curto nem chega ao banco', async () => {
    const r = await ler('curto');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Pedido nao encontrado' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('token inexistente ou de outra loja: 404 JSON', async () => {
    pedidoRow = pedidoPixPendente();
    expect((await ler('f'.repeat(32))).status).toBe(404);
    loja = null;
    const r = await ler(TOKEN, 'outra-loja');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Pedido nao encontrado' });
  });

  test('a consulta amarra o token a empresa da loja e ao Studio', async () => {
    pedidoRow = pedidoPixPendente();
    await ler();
    const [sql, params] = db.query.mock.calls.find(([q]) => /public_token = \$1/.test(String(q)));
    expect(sql).toMatch(/o\.company_id = \$2/);
    expect(sql).toMatch(/o\.vertical = 'studio'/);
    expect(params).toEqual([TOKEN, CID]);
  });

  test('Pix pendente: o contrato inteiro', async () => {
    pedidoRow = pedidoPixPendente();
    const r = await ler();
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({
      numero: '00123',
      criado_em: '2026-09-25T14:03:00.000Z',
      cliente_primeiro_nome: 'Helena',
      status: 'pending_payment',
      payment_status: 'pending',
      payment_method: 'pix',
      subtotal: 217.69, desconto_pix: 10.88, frete: 0, total: 206.81,
      entrega: {
        tipo: 'pickup', prazo_texto: 'Retire em 3 dias úteis',
        retirada_endereco: 'Rua das Flores, 100 - Centro', bairro_cidade: null, courier_a_informar: false,
      },
      itens: [{
        nome: 'Caneca Alça Coração', quantidade: 2, preco_unitario: 57.9, total: 125.8,
        imagem_url: 'https://r2/caneca.jpg',
        resumo: ['Frente e verso', 'Envio minha arte e vocês ajustam', 'Cor da alça: Rosa', 'Arte: Mãe'],
      }],
      pix: { qrcode: null, copia_e_cola: '000201PIX', expira_em: '2026-09-28T14:03:00.000Z', modo: 'manual' },
      cartao: null,
      comprovante_enviado: false,
      etapas: [
        { chave: 'recebido', rotulo: 'Pedido recebido', estado: 'atual' },
        { chave: 'arte', rotulo: 'Criando a arte', estado: 'futuro' },
        { chave: 'producao', rotulo: 'Em produção', estado: 'futuro' },
        { chave: 'pronto', rotulo: 'Pronto', estado: 'futuro' },
      ],
      prazo_dias_uteis: 3,
      revisoes: { max_included: 2, extra_price: 10, policy_text: null },
      acompanhar_url: `/acompanhar/${TOKEN}`,
      loja: { nome: 'Sheid Mania', whatsapp: '5512996145447' },
    });
  });

  test('nunca expoe telefone, e-mail, CPF nem endereco completo', async () => {
    pedidoRow = pedidoPixPendente({
      customer_phone: '12999990000', customer_email: 'helena@exemplo.com', customer_cpf_cnpj: CPF_OK,
      address_street: 'Rua Secreta', address_number: '42', delivery_address: 'Rua Secreta, 42',
    });
    const r = await ler();
    const txt = JSON.stringify(r.body);
    for (const segredo of ['12999990000', 'helena@exemplo.com', CPF_OK, 'Rua Secreta', 'Souza', 'Prado']) {
      expect(txt).not.toContain(segredo);
    }
    // E a consulta nem busca essas colunas.
    const [sql] = db.query.mock.calls.find(([q]) => /public_token = \$1/.test(String(q)));
    for (const col of ['customer_phone', 'customer_email', 'customer_cpf_cnpj', 'address_street', 'delivery_address', 'courier_plate']) {
      expect(sql).not.toContain(col);
    }
  });

  test('pago: sem Pix, e a linha do tempo anda para "Criando a arte"', async () => {
    pedidoRow = pedidoPixPendente({ status: 'confirmed', payment_status: 'paid' });
    const r = await ler();
    expect(r.body.pix).toBeNull();
    expect(r.body.etapas.map((e) => e.estado)).toEqual(['feito', 'atual', 'futuro', 'futuro']);
  });

  test('"ja paguei" (awaiting_approval): sem Pix, ainda em "Pedido recebido"', async () => {
    pedidoRow = pedidoPixPendente({ status: 'awaiting_approval', payment_proof_url: 'https://r2/proof.jpg' });
    const r = await ler();
    expect(r.body.pix).toBeNull();
    expect(r.body.comprovante_enviado).toBe(true);
    expect(r.body.etapas[0].estado).toBe('atual');
  });

  test('cancelado (Pix vencido): sem Pix e a linha do tempo nao diz "Criando a arte"', async () => {
    pedidoRow = pedidoPixPendente({ status: 'cancelled', payment_status: 'expired' });
    const r = await ler();
    expect(r.body.status).toBe('cancelled');
    expect(r.body.pix).toBeNull();
    expect(r.body.etapas.map((e) => e.estado)).toEqual(['atual', 'futuro', 'futuro', 'futuro']);
  });

  test('em producao: etapas pela mesma leitura do acompanhamento', async () => {
    pedidoRow = pedidoPixPendente({ status: 'confirmed', payment_status: 'paid', studio_production_status: 'in_production' });
    expect((await ler()).body.etapas.map((e) => e.estado)).toEqual(['feito', 'feito', 'atual', 'futuro']);
  });

  test('Pix do gateway: modo auto e QR em base64', async () => {
    pedidoRow = pedidoPixPendente({ asaas_payment_id: null, asaas_pix_qrcode: 'QRB64', asaas_pix_payload: '000201MP' });
    expect((await ler()).body.pix).toMatchObject({ qrcode: 'QRB64', copia_e_cola: '000201MP', modo: 'auto' });
  });

  test('entrega: so bairro e cidade', async () => {
    pedidoRow = pedidoPixPendente({ delivery_type: 'delivery', address_neighborhood: 'Jardim Colonial', address_city: 'São José dos Campos', delivery_fee: '12.00' });
    const r = await ler();
    expect(r.body.entrega).toEqual({
      tipo: 'delivery', prazo_texto: 'Chega 1 dia útil depois de pronto', retirada_endereco: null,
      bairro_cidade: 'Jardim Colonial · São José dos Campos', courier_a_informar: false,
    });
    expect(r.body.frete).toBe(12);
  });

  test('retirada por app com "informo depois": courier_a_informar', async () => {
    pedidoRow = pedidoPixPendente({ delivery_type: 'courier', courier_name: null });
    expect((await ler()).body.entrega.courier_a_informar).toBe(true);
    pedidoRow = pedidoPixPendente({ delivery_type: 'courier', courier_name: 'Rogério' });
    const r = await ler();
    expect(r.body.entrega.courier_a_informar).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain('Rogério');
  });

  test('prazo pela maior faixa das linhas', async () => {
    regras = [{ product_id: 'p1', qty_tiers: [{ min_qty: 2, unit_multiplier: 1, lead_days: 6 }] }];
    pedidoRow = pedidoPixPendente();
    expect((await ler()).body.prazo_dias_uteis).toBe(6);
  });

  test('base sem as colunas novas (42703): responde com a consulta minima', async () => {
    await jest.isolateModulesAsync(async () => {
      const dbIso = require('../src/config/database');
      const chamadas = [];
      dbIso.query.mockImplementation(async (sql, params) => {
        const s = String(sql);
        if (/FROM digital_channel_config/.test(s)) return { rows: [lojaPadrao()] };
        if (/public_token = \$1/.test(s)) {
          chamadas.push(s);
          if (/discount_amount/.test(s)) throw Object.assign(new Error('coluna'), { code: '42703' });
          const { discount_amount, courier_name, payment_proof_url, ...min } = pedidoPixPendente();
          return { rows: params[0] === TOKEN ? [min] : [] };
        }
        return { rows: [] };
      });
      const appIso = express();
      appIso.use('/storefront', require('../src/routes/studioStorefront'));
      const r = await request(appIso).get(`/storefront/sheid-mania/studio/pedido/${TOKEN}`);
      expect(r.status).toBe(200);
      expect(r.body.desconto_pix).toBe(0);
      expect(r.body.comprovante_enviado).toBe(false);
      expect(chamadas).toHaveLength(2);
      // Memoriza: a proxima leitura ja vai direto na minima.
      await request(appIso).get(`/storefront/sheid-mania/studio/pedido/${TOKEN}`);
      expect(chamadas).toHaveLength(3);
      expect(chamadas[2]).not.toMatch(/discount_amount/);
    });
  });

  test('base sem public_token (migration 322): 404, nunca 500', async () => {
    await jest.isolateModulesAsync(async () => {
      const dbIso = require('../src/config/database');
      dbIso.query.mockImplementation(async (sql) => {
        const s = String(sql);
        if (/FROM digital_channel_config/.test(s)) return { rows: [lojaPadrao()] };
        if (/public_token = \$1/.test(s)) throw Object.assign(new Error('coluna'), { code: '42703' });
        return { rows: [] };
      });
      const appIso = express();
      appIso.use('/storefront', require('../src/routes/studioStorefront'));
      const r = await request(appIso).get(`/storefront/sheid-mania/studio/pedido/${TOKEN}`);
      expect(r.status).toBe(404);
    });
  });
});

// A MESMA validacao de CPF/CNPJ nas duas lojas: um modulo, nenhuma copia.
test('as duas lojas validam CPF/CNPJ pelo mesmo modulo', () => {
  const fs = require('fs');
  const path = require('path');
  const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  for (const rota of ['src/routes/storefront.js', 'src/routes/studioStorefront.js']) {
    const src = fonte(rota);
    expect(src).toContain("const { validateCpfCnpj } = require('../services/cpfCnpj');");
    expect(src).not.toMatch(/function validateCpf/);
  }
  const { validateCpfCnpj } = require('../src/services/cpfCnpj');
  expect(validateCpfCnpj(null)).toBeNull();
  expect(validateCpfCnpj('529.982.247-25')).toBe(CPF_OK);
  expect(validateCpfCnpj('111.111.111-11')).toBe(false);
  expect(validateCpfCnpj('11.222.333/0001-81')).toBe('11222333000181');
  expect(validateCpfCnpj('123')).toBe(false);
});
