// ============================================================
// AURA. — Atribuicao do pedido nas duas lojas (Aurinha, migration 313)
//
// A Aurinha manda o link da loja com `?origem=aurinha&conversa=<uuid>` e
// a loja devolve os dois no POST do pedido. A loja comum gravava desde a
// 313; o pedido da vitrine Studio chegava com os campos e o servidor os
// jogava fora — a venda que a conversa fechou nao contava como dela.
//
// Os casos de rota rodam o MESMO corpo contra as duas lojas: se uma
// voltar a ter uma copia propria da regra e divergir, quebram aqui.
// ============================================================
'use strict';

const { lerAtribuicao, gravarAtribuicao, ORIGEM_MAX } = require('../src/services/atribuicaoDoPedido');

const CONVERSA = '3f0e7a52-9c1d-4b8e-a6f2-0d5c7e9b1a24';

describe('lerAtribuicao', () => {
  test('origem e conversa validas passam', () => {
    expect(lerAtribuicao({ origem: 'aurinha', hub_conversation_id: CONVERSA }))
      .toEqual({ origem: 'aurinha', hub_conversation_id: CONVERSA });
  });

  test('conversa que nao e UUID e ignorada, a origem fica', () => {
    expect(lerAtribuicao({ origem: 'aurinha', hub_conversation_id: 'abc' }))
      .toEqual({ origem: 'aurinha', hub_conversation_id: null });
  });

  test('origem maior que a coluna e cortada em 32', () => {
    const a = lerAtribuicao({ origem: 'x'.repeat(50) });
    expect(a.origem).toHaveLength(ORIGEM_MAX);
  });

  test('sem nada valido devolve null (nao toca no banco)', () => {
    expect(lerAtribuicao({})).toBeNull();
    expect(lerAtribuicao(null)).toBeNull();
    expect(lerAtribuicao({ origem: '   ', hub_conversation_id: 42 })).toBeNull();
    expect(lerAtribuicao({ origem: { x: 1 } })).toBeNull();
  });
});

describe('gravarAtribuicao', () => {
  test('grava com COALESCE, preso a empresa do pedido', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const ok = await gravarAtribuicao(db, {
      orderId: 'o1', companyId: 'c1', atribuicao: { origem: 'aurinha', hub_conversation_id: CONVERSA },
    });
    expect(ok).toBe(true);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE digital_orders SET origem = COALESCE\(\$1, origem\)/);
    expect(sql).toMatch(/WHERE id = \$3 AND company_id = \$4/);
    expect(params).toEqual(['aurinha', CONVERSA, 'o1', 'c1']);
  });

  test('base sem a migration 313 (42703) nao rejeita nem loga', async () => {
    const erro = Object.assign(new Error('column "origem" does not exist'), { code: '42703' });
    const db = { query: jest.fn().mockRejectedValue(erro) };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(gravarAtribuicao(db, {
      orderId: 'o1', companyId: 'c1', atribuicao: { origem: 'aurinha', hub_conversation_id: null },
    })).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('outro erro tambem nao rejeita (o pedido ja existe), mas loga', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('conexao caiu')) };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(gravarAtribuicao(db, {
      orderId: 'o1', companyId: 'c1', atribuicao: { origem: 'aurinha', hub_conversation_id: null }, rotulo: 'X',
    })).resolves.toBe(false);
    expect(spy).toHaveBeenCalledWith('[X] atribuicao error:', 'conexao caiu');
    spy.mockRestore();
  });

  test('sem atribuicao nao consulta o banco', async () => {
    const db = { query: jest.fn() };
    await gravarAtribuicao(db, { orderId: 'o1', companyId: 'c1', atribuicao: null });
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('POST do pedido grava a atribuicao nas duas lojas', () => {
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
  const LOJA = {
    company_id: 'c1', pickup_enabled: true, delivery_enabled: true,
    delivery_fee: '10.00', pix_key: 'chave', company_display_name: 'Sheid Mania',
  };

  function makeApp(mod) {
    const app = express();
    app.use(express.json());
    app.use('/storefront', require(mod));
    return app;
  }

  // A transacao do pedido roda num client do pool: o INSERT devolve o
  // pedido e o resto responde vazio. A atribuicao vai pelo db.query de
  // fora, DEPOIS do COMMIT — e e esse UPDATE que os testes procuram.
  function mockBanco({ updateFalha } = {}) {
    db.query.mockImplementation((sql) => {
      if (/FROM digital_channel_config/.test(sql)) return Promise.resolve({ rows: [LOJA] });
      if (/FROM products/.test(sql)) return Promise.resolve({ rows: [PRODUTO] });
      if (/UPDATE digital_orders SET origem/.test(sql) && updateFalha) return Promise.reject(updateFalha);
      return Promise.resolve({ rows: [] });
    });
    db.connect.mockImplementation(() => ({
      query: jest.fn((sql) => /INSERT INTO digital_orders/.test(String(sql))
        ? Promise.resolve({ rows: [{ id: 'o1', order_number: 7, company_id: 'c1' }] })
        : Promise.resolve({ rows: [] })),
      release: jest.fn(),
    }));
  }

  const chamadasDeAtribuicao = () =>
    db.query.mock.calls.filter(([sql]) => /UPDATE digital_orders SET origem/.test(String(sql)));

  beforeEach(() => { db.query.mockReset(); db.connect.mockReset(); });

  describe.each(ROTAS)('$nome', ({ mod, path }) => {
    function pedido(extra) {
      return request(makeApp(mod)).post(path).send({
        customer_name: 'Cliente', customer_phone: '11999999999',
        delivery_type: 'pickup', payment_method: 'pix',
        items: [{ product_id: 'p1', quantity: 1, customization: {} }],
        ...extra,
      });
    }

    test('origem e conversa vao para o pedido criado', async () => {
      mockBanco();
      const res = await pedido({ origem: 'aurinha', hub_conversation_id: CONVERSA });
      expect(res.status).toBeLessThan(500);
      const chamadas = chamadasDeAtribuicao();
      expect(chamadas).toHaveLength(1);
      expect(chamadas[0][1]).toEqual(['aurinha', CONVERSA, 'o1', 'c1']);
    });

    test('conversa invalida e ignorada, a origem continua', async () => {
      mockBanco();
      await pedido({ origem: 'aurinha', hub_conversation_id: 'nao-e-uuid' });
      expect(chamadasDeAtribuicao()[0][1]).toEqual(['aurinha', null, 'o1', 'c1']);
    });

    test('pedido sem atribuicao nao faz o UPDATE', async () => {
      mockBanco();
      const res = await pedido({});
      expect(res.status).toBeLessThan(500);
      expect(chamadasDeAtribuicao()).toHaveLength(0);
    });

    test('base sem a migration 313 nao derruba o pedido', async () => {
      mockBanco({ updateFalha: Object.assign(new Error('column "origem" does not exist'), { code: '42703' }) });
      const res = await pedido({ origem: 'aurinha', hub_conversation_id: CONVERSA });
      expect(res.status).toBeLessThan(500);
      expect(chamadasDeAtribuicao()).toHaveLength(1);
    });
  });
});
