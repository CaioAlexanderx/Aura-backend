// ============================================================
// AURA Studio — S2: frete por CEP no storefront do Studio
//
// Antes deste item o Studio cobrava SEMPRE config.delivery_fee, ignorando
// frete gratis acima de X e faixa por distancia — as duas ja configuradas
// pela lojista no mesmo digital_channel_config que a loja comum usa.
//
// Duas frentes cobertas aqui:
//   1. A rota GET /:slug/studio/shipping-quote (contrato publico).
//   2. calculateShippingQuote, que agora atende DOIS storefronts. Nao
//      tinha teste nenhum; travar o comportamento antes de ganhar o
//      segundo consumidor e o ponto.
//
// MOCK POR SQL, NUNCA POR POSICAO (CLAUDE.md). db.query vem do mock
// global (tests/jest.setup.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

// A rota e a matematica sao testadas separadas: aqui o servico e mockado
// para provar o CONTRATO da rota (404/400/200 e repasse de parametros).
jest.mock('../src/services/shippingQuote', () => ({
  calculateShippingQuote: jest.fn(),
}));

const { calculateShippingQuote } = require('../src/services/shippingQuote');
const db = require('../src/config/database');

function isConfigSelect(sql) {
  return /FROM digital_channel_config/.test(sql) && /is_published = true/.test(sql);
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/storefront', require('../src/routes/studioStorefront'));
  return app;
}

describe('S2 — GET /storefront/:slug/studio/shipping-quote', () => {
  let app;

  // Sem jest.resetModules() de proposito: esta rota nao tem cache
  // module-level pra limpar, e o reset criaria mocks NOVOS de db e do
  // servico — os que o router passaria a usar nao seriam os que estes
  // testes configuram. Foi assim que a primeira versao deste arquivo
  // deu 500 em sete casos.
  beforeEach(() => {
    db.query.mockReset();
    calculateShippingQuote.mockReset();
    app = makeApp();
  });

  function mockLoja(config) {
    db.query.mockImplementation((sql) => {
      if (isConfigSelect(sql)) {
        return Promise.resolve({ rows: config ? [config] : [] });
      }
      return Promise.resolve({ rows: [] });
    });
  }

  test('devolve a cotacao e repassa cep e subtotal ao servico', async () => {
    mockLoja({ company_id: 'c1', delivery_enabled: true, delivery_fee: '10.00' });
    calculateShippingQuote.mockResolvedValue({
      fee: 24.9, eta: 'ate 5 dias uteis', mode: 'distance', currency: 'BRL', distance_km: 42.3,
    });

    const res = await request(app)
      .get('/storefront/sheid-mania/studio/shipping-quote')
      .query({ cep: '01310-100', subtotal: '199.90' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ fee: 24.9, mode: 'distance', distance_km: 42.3 });

    const [config, cep, subtotal] = calculateShippingQuote.mock.calls[0];
    expect(config.company_id).toBe('c1');
    expect(cep).toBe('01310-100');
    expect(subtotal).toBe(199.9);
  });

  test('loja inexistente ou despublicada da 404 sem calcular nada', async () => {
    mockLoja(null);
    const res = await request(app)
      .get('/storefront/nao-existe/studio/shipping-quote')
      .query({ cep: '01310100' });

    expect(res.status).toBe(404);
    expect(calculateShippingQuote).not.toHaveBeenCalled();
  });

  test('loja que nao entrega da 400 sem calcular nada', async () => {
    mockLoja({ delivery_enabled: false });
    const res = await request(app)
      .get('/storefront/sheid-mania/studio/shipping-quote')
      .query({ cep: '01310100' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nao faz entregas/);
    expect(calculateShippingQuote).not.toHaveBeenCalled();
  });

  test('sem cep da 400', async () => {
    mockLoja({ delivery_enabled: true });
    const res = await request(app).get('/storefront/sheid-mania/studio/shipping-quote');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cep obrigatorio/);
  });

  test('subtotal ausente vira 0 — cotacao sem carrinho e legitima', async () => {
    mockLoja({ delivery_enabled: true });
    calculateShippingQuote.mockResolvedValue({ fee: 15, mode: 'flat', currency: 'BRL' });

    const res = await request(app)
      .get('/storefront/sheid-mania/studio/shipping-quote')
      .query({ cep: '01310100' });

    expect(res.status).toBe(200);
    expect(calculateShippingQuote.mock.calls[0][2]).toBe(0);
  });

  test('subtotal negativo da 400', async () => {
    mockLoja({ delivery_enabled: true });
    const res = await request(app)
      .get('/storefront/sheid-mania/studio/shipping-quote')
      .query({ cep: '01310100', subtotal: '-1' });

    expect(res.status).toBe(400);
    expect(calculateShippingQuote).not.toHaveBeenCalled();
  });

  test('CEP fora da area sai como 200 com fee null — nao e erro de servidor', async () => {
    mockLoja({ delivery_enabled: true });
    calculateShippingQuote.mockResolvedValue({
      fee: null, eta: null, mode: 'distance', currency: 'BRL',
      distance_km: 812.4, error: 'Fora da area de entrega',
    });

    const res = await request(app)
      .get('/storefront/sheid-mania/studio/shipping-quote')
      .query({ cep: '90010150' });

    expect(res.status).toBe(200);
    expect(res.body.fee).toBeNull();
    expect(res.body.error).toBe('Fora da area de entrega');
  });

  test('falha do servico vira 500, nao derruba a rota', async () => {
    mockLoja({ delivery_enabled: true });
    calculateShippingQuote.mockRejectedValue(new Error('BrasilAPI fora do ar'));

    const res = await request(app)
      .get('/storefront/sheid-mania/studio/shipping-quote')
      .query({ cep: '01310100' });

    expect(res.status).toBe(500);
  });
});

// ── POST /order: o frete cobrado sai da cotacao ──────────────
// O 409 de cotacao velha acontece ANTES da transacao, entao estes casos
// exercitam o calculo do frete no fechamento sem precisar mockar a
// criacao inteira do pedido. server_fee no corpo do 409 e o valor que o
// servidor cobraria — e por isso a assercao mais direta de que o frete
// vem da cotacao e nao mais do delivery_fee fixo.
describe('S2 — POST /storefront/:slug/studio/order', () => {
  let app;

  const LOJA = {
    company_id: 'c1',
    delivery_enabled: true,
    pickup_enabled: true,
    delivery_fee: '10.00',          // taxa fixa: o que o Studio cobrava sempre
    pix_key: 'chave-pix',
    company_display_name: 'Sheid Mania',
  };

  const CANECA = {
    id: 'p1', name: 'CANECA BRANCA', price: '39.90', stock_qty: 10,
    image_url: null, is_active: true, is_personalizable: true,
    customization_config: { fields: [] },
  };

  beforeEach(() => {
    db.query.mockReset();
    calculateShippingQuote.mockReset();
    app = makeApp();
    db.query.mockImplementation((sql) => {
      if (/FROM digital_channel_config/.test(sql)) return Promise.resolve({ rows: [LOJA] });
      if (/FROM companies_payment_gateways/.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM products/.test(sql)) return Promise.resolve({ rows: [CANECA] });
      return Promise.resolve({ rows: [] });
    });
  });

  function pedido(extra) {
    return request(app).post('/storefront/sheid-mania/studio/order').send({
      customer_name: 'Cliente', customer_phone: '11999999999',
      delivery_type: 'delivery', payment_method: 'pix',
      items: [{ product_id: 'p1', quantity: 1, customization: {} }],
      ...extra,
    });
  }

  test('o frete cobrado vem da cotacao por CEP, nao do delivery_fee fixo', async () => {
    calculateShippingQuote.mockResolvedValue({ fee: 27.4, mode: 'distance', currency: 'BRL' });

    const res = await pedido({ address_zip: '90010-150', expected_delivery_fee: 10 });

    expect(res.status).toBe(409);
    expect(res.body.server_fee).toBe(27.4);   // cotacao
    expect(res.body.client_fee).toBe(10);     // taxa fixa antiga
    expect(calculateShippingQuote.mock.calls[0][1]).toBe('90010150'); // CEP normalizado
  });

  test('cotacao batendo com o esperado nao bloqueia o pedido', async () => {
    calculateShippingQuote.mockResolvedValue({ fee: 27.4, mode: 'distance', currency: 'BRL' });
    const res = await pedido({ address_zip: '90010150', expected_delivery_fee: 27.4 });
    expect(res.status).not.toBe(409);
  });

  test('CEP fora da area de entrega barra o pedido com 400', async () => {
    calculateShippingQuote.mockResolvedValue({
      fee: null, mode: 'distance', currency: 'BRL',
      distance_km: 812.4, error: 'Fora da area de entrega',
    });

    const res = await pedido({ address_zip: '90010150' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Fora da area de entrega');
    expect(res.body.distance_km).toBe(812.4);
  });

  // Sem CEP nao ha o que cotar: cai na taxa fixa, exatamente como antes
  // do S2. Note que o expected_delivery_fee tambem NAO e conferido nesse
  // caminho — a guarda de cotacao velha so existe dentro do ramo com CEP.
  // E o mesmo comportamento da loja comum (storefront.js); divergir aqui
  // criaria duas regras de frete para a mesma lojista.
  test('sem CEP nao cota nada e nao bloqueia — cai na taxa fixa', async () => {
    const res = await pedido({ expected_delivery_fee: 999 });

    expect(calculateShippingQuote).not.toHaveBeenCalled();
    expect(res.status).not.toBe(409);
  });

  test('retirada na loja nao cota frete', async () => {
    const res = await pedido({ delivery_type: 'pickup', address_zip: '90010150' });
    expect(calculateShippingQuote).not.toHaveBeenCalled();
    expect(res.status).not.toBe(409);
  });
});

// ── A matematica, agora com dois consumidores ────────────────
describe('S2 — calculateShippingQuote (servico real)', () => {
  const real = jest.requireActual('../src/services/shippingQuote').calculateShippingQuote;

  test('frete gratis acima do valor configurado vence o resto', async () => {
    const q = await real(
      { delivery_fee: '20', delivery_free_above_amount: '150', delivery_pricing_mode: 'distance' },
      '01310100', 200
    );
    expect(q).toMatchObject({ fee: 0, mode: 'free', free_shipping: true });
  });

  test('abaixo do valor de frete gratis, cobra normal', async () => {
    const q = await real(
      { delivery_fee: '20', delivery_free_above_amount: '150' },
      '01310100', 149.99
    );
    expect(q).toMatchObject({ fee: 20, mode: 'flat' });
  });

  test('modo flat devolve a taxa fixa e o prazo da loja', async () => {
    const q = await real(
      { delivery_fee: '12.5', delivery_eta_text: 'ate 3 dias uteis' },
      '01310100', 50
    );
    expect(q).toMatchObject({ fee: 12.5, mode: 'flat', eta: 'ate 3 dias uteis' });
  });

  test('CEP invalido nao chega a geocodificar', async () => {
    const q = await real({ delivery_fee: '10' }, '123', 50);
    expect(q).toMatchObject({ fee: null, mode: 'invalid' });
    expect(q.error).toMatch(/CEP invalido/);
  });

  test('modo distance sem faixas configuradas cai em flat, avisando', async () => {
    const q = await real(
      { delivery_fee: '18', delivery_pricing_mode: 'distance', origin_lat: '-23.5', origin_lng: '-46.6' },
      '01310100', 50
    );
    expect(q).toMatchObject({ fee: 18, mode: 'flat-fallback' });
    expect(q.alert).toMatch(/faixas de distancia/);
  });

  test('modo distance sem origem geolocalizada cai em flat, avisando', async () => {
    const q = await real(
      {
        delivery_fee: '18',
        delivery_pricing_mode: 'distance',
        delivery_distance_tiers: [{ max_km: 10, fee: 5 }],
      },
      '01310100', 50
    );
    expect(q).toMatchObject({ fee: 18, mode: 'flat-fallback' });
    expect(q.alert).toMatch(/CEP de origem/);
  });
});
