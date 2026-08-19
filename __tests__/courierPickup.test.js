// ============================================================
// AURA. — Retirada por app de entrega (migration 288)
//
// Terceiro delivery_type: o cliente contrata Uber/99 e informa quem vai
// buscar. O que esta em jogo nao e cobranca — a loja nao cobra frete
// nesse modo — e sim ENTREGAR PARA A PESSOA CERTA. Sem nome e placa, a
// lojista entrega a personalizacao de um cliente para o primeiro motoboy
// que citar o numero do pedido.
//
// A validacao e um modulo compartilhado de proposito: storefront.js e
// studioStorefront.js chamam a MESMA funcao. Duas copias divergindo
// dariam duas regras de retirada para a mesma lojista — foi exatamente
// o que aconteceu com os campos obrigatorios (S0).
// ============================================================
'use strict';

const {
  COURIER, normalizePlate, validateCourierPickup,
} = require('../src/services/courierPickup');

const LOJA_OK = { courier_pickup_enabled: true };

describe('normalizePlate', () => {
  test('aceita placa antiga e Mercosul', () => {
    expect(normalizePlate('ABC1234')).toBe('ABC1234');
    expect(normalizePlate('ABC1D23')).toBe('ABC1D23');
  });

  test('normaliza o que o cliente digita no celular', () => {
    expect(normalizePlate('abc-1234')).toBe('ABC1234');
    expect(normalizePlate(' abc 1d23 ')).toBe('ABC1D23');
    expect(normalizePlate('ABC.1234')).toBe('ABC1234');
  });

  test('recusa o que nao e placa', () => {
    expect(normalizePlate('')).toBeNull();
    expect(normalizePlate(null)).toBeNull();
    expect(normalizePlate('ABC123')).toBeNull();    // curta
    expect(normalizePlate('ABC12345')).toBeNull();  // longa
    expect(normalizePlate('1234ABC')).toBeNull();   // invertida
    expect(normalizePlate('AB01234')).toBeNull();   // 2 letras
    expect(normalizePlate('ABCD123')).toBeNull();   // 4a letra na posicao do digito
  });
});

describe('validateCourierPickup', () => {
  test('loja com a modalidade ligada e dados completos passa', () => {
    expect(validateCourierPickup(LOJA_OK, {
      courier_name: 'Joao da Silva', courier_plate: 'abc-1d23',
    })).toEqual({ courier_name: 'Joao da Silva', courier_plate: 'ABC1D23' });
  });

  test('loja que nao ligou a modalidade recusa', () => {
    const r = validateCourierPickup({ courier_pickup_enabled: false }, {
      courier_name: 'Joao', courier_plate: 'ABC1234',
    });
    expect(r.error).toMatch(/nao disponivel/);
  });

  // Default FALSE: loja que nunca ouviu falar da modalidade nao passa a
  // aceita-la sozinha quando a migration roda.
  test('config sem a coluna ainda recusa', () => {
    expect(validateCourierPickup({}, { courier_name: 'J', courier_plate: 'ABC1234' }).error)
      .toMatch(/nao disponivel/);
    expect(validateCourierPickup(null, {}).error).toMatch(/nao disponivel/);
  });

  test('sem nome do entregador recusa', () => {
    expect(validateCourierPickup(LOJA_OK, { courier_plate: 'ABC1234' }).error)
      .toMatch(/nome do entregador/);
    expect(validateCourierPickup(LOJA_OK, { courier_name: '   ', courier_plate: 'ABC1234' }).error)
      .toMatch(/nome do entregador/);
  });

  test('placa invalida recusa dizendo o formato', () => {
    const r = validateCourierPickup(LOJA_OK, { courier_name: 'Joao', courier_plate: 'moto' });
    expect(r.error).toMatch(/ABC1234 ou ABC1D23/);
  });

  test('nome absurdamente longo recusa', () => {
    expect(validateCourierPickup(LOJA_OK, {
      courier_name: 'x'.repeat(121), courier_plate: 'ABC1234',
    }).error).toMatch(/muito longo/);
  });

  test('COURIER e o valor gravado em delivery_type', () => {
    expect(COURIER).toBe('courier');
  });
});

// ── A modalidade nos dois storefronts ────────────────────────
// O mesmo corpo de pedido roda contra a loja comum e contra o Studio.
// Se um dia so um dos dois for atualizado, estes casos quebram — que e
// o ponto de ter a validacao num modulo compartilhado.
describe('POST /order — retirada por app nos dois storefronts', () => {
  const express = require('express');
  const request = require('supertest');
  const db = require('../src/config/database');

  const ROTAS = [
    { nome: 'loja comum', mod: '../src/routes/storefront',       path: '/storefront/sheid-mania/order' },
    { nome: 'Studio',     mod: '../src/routes/studioStorefront', path: '/storefront/sheid-mania/studio/order' },
  ];

  const PRODUTO = {
    id: 'p1', name: 'CANECA BRANCA', price: '39.90', stock_qty: 10,
    image_url: null, is_active: true, is_personalizable: true,
    customization_config: { fields: [] },
  };

  function makeApp(mod) {
    const app = express();
    app.use(express.json());
    app.use('/storefront', require(mod));
    return app;
  }

  function mockBanco(config) {
    db.query.mockImplementation((sql) => {
      if (/FROM digital_channel_config/.test(sql)) return Promise.resolve({ rows: [config] });
      if (/FROM companies_payment_gateways/.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM products/.test(sql)) return Promise.resolve({ rows: [PRODUTO] });
      return Promise.resolve({ rows: [] });
    });
  }

  const LOJA = {
    company_id: 'c1', pickup_enabled: true, delivery_enabled: true,
    delivery_fee: '10.00', pix_key: 'chave', company_display_name: 'Sheid Mania',
  };

  beforeEach(() => { db.query.mockReset(); });

  describe.each(ROTAS)('$nome', ({ mod, path }) => {
    function pedido(app, extra) {
      return request(app).post(path).send({
        customer_name: 'Cliente', customer_phone: '11999999999',
        delivery_type: 'courier', payment_method: 'pix',
        items: [{ product_id: 'p1', quantity: 1, customization: {} }],
        ...extra,
      });
    }

    test('loja sem a modalidade ligada recusa', async () => {
      mockBanco({ ...LOJA, courier_pickup_enabled: false });
      const res = await pedido(makeApp(mod), {
        courier_name: 'Joao', courier_plate: 'ABC1234',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/nao disponivel/);
    });

    test('sem nome do entregador recusa', async () => {
      mockBanco({ ...LOJA, courier_pickup_enabled: true });
      const res = await pedido(makeApp(mod), { courier_plate: 'ABC1234' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/nome do entregador/);
    });

    test('placa invalida recusa', async () => {
      mockBanco({ ...LOJA, courier_pickup_enabled: true });
      const res = await pedido(makeApp(mod), {
        courier_name: 'Joao', courier_plate: 'moto do joao',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Placa invalida/);
    });

    test('dados completos passam da validacao', async () => {
      mockBanco({ ...LOJA, courier_pickup_enabled: true });
      const res = await pedido(makeApp(mod), {
        courier_name: 'Joao da Silva', courier_plate: 'abc-1d23',
      });
      // O pedido segue para a transacao (mockada), entao o que importa
      // aqui e nao ter sido barrado na validacao da modalidade.
      expect(res.status).not.toBe(400);
    });
  });
});
