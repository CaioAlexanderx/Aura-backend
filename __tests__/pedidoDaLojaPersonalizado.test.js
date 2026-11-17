// ============================================================
// AURA. — Pedido da loja comum com peca personalizavel (p-184, loja unica
// 3.4b, 17/11/2026). Banco simulado; o caminho inteiro no Postgres de
// verdade esta em pedidoDaLojaPersonalizado.banco.test.js, e a paridade do
// pedido so de prateleira em pedidoDaLojaSoPrateleira.paridade.test.js.
//
//   - a validacao e a cotacao sao as da vitrine Studio (mesma mensagem,
//     mesmo preco com opcoes e servico de arte);
//   - o personalizado nao confere estoque nem variante; a prateleira do
//     mesmo pedido, sim;
//   - o Pix do Mercado Pago vale 72 h (D10); o cartao cobra a arte como
//     item proprio, no pedido novo e na repeticao do toque;
//   - sem sinal (D11): o total e o pedido inteiro;
//   - POST /sacola/precos cota o personalizado e nao fala de estoque;
//   - o job do Pix: 72 h para o pedido da loja comum com personalizado.
// ============================================================
'use strict';

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
    payment_id: 'mp-pix-1', qrcode: 'QR', payload: 'PAYLOAD', expires_at: '2026-11-20T15:00:00.000Z',
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
const { etapaInicialDoPedido, ehPecaPersonalizada, temPersonalizacao } = require('../src/services/personalizavel');
const { situacaoDoPixVencido, PRAZO_HORAS_STUDIO } = require('../src/jobs/lojaPixExpiradoJob');

const CID = 'c0000000-0000-0000-0000-0000000000b4';
const BLUSA = '11111111-1111-1111-1111-111111111111';
const CANECA = '44444444-4444-4444-4444-444444444444';
const VARIANTE_FALSA = '55555555-5555-5555-5555-555555555555';

const SERVICO_ARTE = {
  id: 'art_service', type: 'option', label: 'Arte',
  config: { is_art_service: true, choices: [
    { value: 'none', label: 'Envio pronta', price_delta: 0 },
    { value: 'designer', label: 'Criem', price_delta: 30 },
  ] },
};
const CONFIG = {
  fields: [
    { id: 'nome', type: 'text', label: 'Nome', required: true },
    { id: 'foto', type: 'image', label: 'Foto' },
    SERVICO_ARTE,
  ],
};

const peca = (extra) => ({
  image_url: null, is_active: true, promo_price: null, promo_starts_at: null, promo_ends_at: null,
  is_personalizable: false, customization_config: null, ...extra,
});
let produtos;
let config;
let transacao;
let pedidoGravado;
let itensGravados;

function leitura(sql) {
  if (/information_schema\.columns/.test(sql)) return { rows: [{ n: 2 }] };
  if (/FROM digital_channel_config/.test(sql)) return { rows: [config] };
  if (/FROM studio_pricing_rules/.test(sql)) return { rows: [] };
  if (/SELECT product_id, COUNT\(\*\) AS cnt/.test(sql)) return { rows: [] };
  if (/FROM product_variants pv/.test(sql)) return { rows: [] };
  if (/FROM products/.test(sql)) return { rows: produtos };
  if (/SELECT id FROM digital_orders WHERE company_id = \$1 AND idempotency_key/.test(sql)) {
    return { rows: pedidoGravado ? [{ id: pedidoGravado.id }] : [] };
  }
  if (/SELECT \* FROM digital_orders WHERE company_id = \$1 AND idempotency_key/.test(sql)) {
    return { rows: pedidoGravado ? [pedidoGravado] : [] };
  }
  if (/FROM digital_order_items WHERE order_id/.test(sql)) return { rows: itensGravados };
  return { rows: [] };
}

beforeEach(() => {
  precoEfetivo._resetarParaTeste();
  vendaNaPromocao._resetarParaTeste();
  pedidoIdem._resetCache();
  produtos = [
    peca({ id: BLUSA, name: 'BLUSA', price: '50.00', stock_qty: 1 }),
    peca({ id: CANECA, name: 'CANECA', price: '40.00', stock_qty: 0, is_personalizable: true,
      customization_config: CONFIG }),
  ];
  config = { company_id: CID, pickup_enabled: true, pix_key: 'chave@loja.test', company_display_name: 'Loja' };
  transacao = [];
  pedidoGravado = null;
  itensGravados = [];
  mpGateway.gatewayAtivo.mockReset();
  mpGateway.gatewayAtivo.mockResolvedValue(null);
  mpService.createMpPixPayment.mockClear();
  mpService.createMpPreference.mockClear();
  db.query.mockReset();
  db.connect.mockReset();
  db.query.mockImplementation(async (sql) => leitura(String(sql)));
  db.connect.mockImplementation(() => ({
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      transacao.push({ sql: s, params });
      if (/INSERT INTO digital_orders/.test(s)) return { rows: [{ id: 'o1', order_number: 9, company_id: params[0] }] };
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
const pedir = (items, extra = {}) => request(app()).post('/storefront/loja/order').send({
  customer_name: 'Cliente', customer_phone: '11999999999', delivery_type: 'pickup',
  payment_method: 'pix', items, ...extra,
});
const insertDoPedido = () => transacao.find((q) => /INSERT INTO digital_orders/.test(q.sql));
const insertsDosItens = () => transacao.filter((q) => /INSERT INTO digital_order_items/.test(q.sql));

describe('POST /order com peca personalizavel', () => {
  test('pedido misto: Fila, customization no item e preco da cotacao com a arte', async () => {
    const r = await pedir([
      { product_id: BLUSA, quantity: 1 },
      // variant_id de outra peca: o personalizado ignora a variante.
      { product_id: CANECA, variant_id: VARIANTE_FALSA, quantity: 2,
        customization: { nome: 'Ana', art_service: 'designer', nome_fonte: 'serif' } },
    ]);
    expect(r.status).toBe(201);
    // 50 + (40 x 2 + 30 da arte, uma vez na linha) = 160. Sem sinal: o
    // total e o pedido inteiro.
    expect(r.body).toMatchObject({ subtotal: 160, total: 160, personalizado: true, studio_production_status: 'pending_art' });
    expect(r.body.itens[1]).toEqual({ product_id: CANECA, variant_id: null, unit_price: 40, subtotal: 110, personalizado: true });

    const pedido = insertDoPedido();
    // Por ultimo, depois das colunas opcionais (aqui, as do desconto).
    expect(pedido.sql).toMatch(/discount_reason, vertical, studio_production_status\s*\) VALUES/);
    expect(pedido.sql).toMatch(/\$25, \$26, 'studio', 'pending_art'\s*\) RETURNING/);
    expect(pedido.params).toHaveLength(26);

    const [blusa, caneca] = insertsDosItens();
    expect(blusa.sql).not.toMatch(/customization/);
    expect(caneca.sql).toMatch(/preco_lista, em_promocao,\s*customization, art_review_status\)/);
    expect(caneca.sql).toMatch(/\$11::jsonb, \$12\)/);
    expect(caneca.params).toEqual([
      'o1', CANECA, 'CANECA', null, 40, 2, 110, null, null, false,
      JSON.stringify({ nome: 'Ana', art_service: 'designer', nome_fonte: 'serif' }), null,
    ]);
  });

  test('base sem a 452: o item personalizado grava sem as colunas da promocao', async () => {
    db.connect.mockImplementation(() => ({
      query: jest.fn(async (sql, params) => {
        const s = String(sql);
        transacao.push({ sql: s, params });
        if (/information_schema\.columns/.test(s)) return { rows: [{ n: 0 }] };
        if (/INSERT INTO digital_orders/.test(s)) return { rows: [{ id: 'o1', order_number: 9, company_id: params[0] }] };
        return leitura(s);
      }),
      release: jest.fn(),
    }));
    const r = await pedir([{ product_id: CANECA, quantity: 1, customization: { nome: 'Ana' } }]);
    expect(r.status).toBe(201);
    const [caneca] = insertsDosItens();
    expect(caneca.sql).toMatch(/variant_id,\s*customization, art_review_status\)/);
    expect(caneca.sql).toMatch(/\$8, \$9::jsonb, \$10\)/);
    expect(caneca.params).toHaveLength(10);
  });

  test('arte propria: art_review_status pendente; item sem nada: aguardando personalizacao', async () => {
    produtos[1].customization_config = { fields: [{ id: 'nome', type: 'text', label: 'Nome' }, { id: 'foto', type: 'image', label: 'Foto' }] };
    const comArte = await pedir([{ product_id: CANECA, quantity: 1, customization: { foto: 'https://r2/arte.png' } }]);
    expect(comArte.status).toBe(201);
    expect(insertsDosItens()[0].params.slice(-1)).toEqual(['pendente']);

    transacao = [];
    const semNada = await pedir([{ product_id: CANECA, quantity: 1, customization: {} }]);
    expect(semNada.status).toBe(201);
    expect(semNada.body.studio_production_status).toBe('awaiting_customization');
    expect(insertDoPedido().sql).toMatch(/'studio', 'awaiting_customization'/);
  });

  test('customization que nao passa: 400 com a mensagem da vitrine Studio, nada gravado', async () => {
    const r = await pedir([
      { product_id: BLUSA, quantity: 1 },
      { product_id: CANECA, quantity: 1, customization: { foto: 'https://r2/arte.png' } },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Personalizacao de "CANECA": campo "Nome" obrigatorio');
    expect(transacao).toHaveLength(0);

    const semCustomization = await pedir([{ product_id: CANECA, quantity: 1 }]);
    expect(semCustomization.status).toBe(400);
    expect(semCustomization.body.error).toBe('Personalizacao de "CANECA": customization obrigatoria');
  });

  test('a prateleira do pedido misto continua conferindo estoque', async () => {
    const r = await pedir([
      { product_id: BLUSA, quantity: 2 },
      { product_id: CANECA, quantity: 5, customization: { nome: 'Ana' } },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Estoque insuficiente para "BLUSA". Disponivel: 1');
  });

  test('marcado sem configurador e prateleira: confere estoque como sempre', async () => {
    produtos[1].customization_config = null;
    const r = await pedir([{ product_id: CANECA, quantity: 1, customization: { nome: 'Ana' } }]);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Estoque insuficiente para "CANECA". Disponivel: 0');
  });

  test('Pix do Mercado Pago com personalizado vale 72 h (D10)', async () => {
    mpGateway.gatewayAtivo.mockResolvedValue({ access_token: 'tok' });
    const r = await pedir([{ product_id: CANECA, quantity: 1, customization: { nome: 'Ana' } }]);
    expect(r.status).toBe(201);
    expect(mpService.createMpPixPayment).toHaveBeenCalledTimes(1);
    expect(mpService.createMpPixPayment.mock.calls[0][0].horasDeValidade).toBe(PRAZO_HORAS_STUDIO);
    expect(PRAZO_HORAS_STUDIO).toBe(72);
  });

  test('cartao: a arte vira item proprio', async () => {
    mpGateway.gatewayAtivo.mockResolvedValue({ access_token: 'tok' });
    config.card_enabled = true;
    const r = await pedir([
      { product_id: BLUSA, quantity: 1 },
      { product_id: CANECA, quantity: 2, customization: { nome: 'Ana', art_service: 'designer' } },
    ], { payment_method: 'card' });
    expect(r.status).toBe(201);
    const itens = mpService.createMpPreference.mock.calls[0][0].orderItems;
    expect(itens.map((i) => [i.product_name, i.unit_price, i.quantity])).toEqual([
      ['BLUSA', 50, 1], ['CANECA', 40, 2], ['Servico de arte — CANECA', 30, 1],
    ]);
    expect(itens.reduce((s, i) => s + i.unit_price * i.quantity, 0)).toBe(r.body.total);
  });

  test('repeticao do toque sem resposta guardada: o cartao remontado cobra a arte', async () => {
    mpGateway.gatewayAtivo.mockResolvedValue({ access_token: 'tok' });
    config.card_enabled = true;
    pedidoGravado = {
      id: 'o1', order_number: 9, company_id: CID, vertical: 'studio', payment_method: 'card',
      status: 'pending_payment', total: '110', subtotal: '110', delivery_fee: '0',
      idempotency_key: 'chave-de-teste-0002', idempotency_response: null,
    };
    pedidoIdem.ESPERA.totalMs = 20;
    pedidoIdem.ESPERA.passoMs = 5;
    itensGravados = [{ product_id: CANECA, variant_id: null, quantity: 2, product_name: 'CANECA', unit_price: '40.00', subtotal: '110.00' }];
    const r = await request(app()).post('/storefront/loja/order').set('Idempotency-Key', 'chave-de-teste-0002').send({
      customer_name: 'Cliente', customer_phone: '11999999999', delivery_type: 'pickup', payment_method: 'card',
      items: [{ product_id: CANECA, quantity: 2, customization: { nome: 'Ana', art_service: 'designer' } }],
    });
    expect(r.status).toBe(200);
    const itens = mpService.createMpPreference.mock.calls[0][0].orderItems;
    expect(itens.map((i) => [i.product_name, Number(i.unit_price), Number(i.quantity)])).toEqual([
      ['CANECA', 40, 2], ['Servico de arte — CANECA', 30, 1],
    ]);
  });
});

describe('POST /sacola/precos com peca personalizada', () => {
  const precos = (items) => request(app()).post('/storefront/loja/sacola/precos').send({ items });

  test('cota com o customization e nao fala de estoque; a prateleira segue igual', async () => {
    const r = await precos([
      { product_id: BLUSA, quantity: 1 },
      { product_id: CANECA, quantity: 2, customization: { nome: 'Ana', art_service: 'designer' } },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.itens).toEqual([
      { indice: 0, product_id: BLUSA, variant_id: null, preco: 50, disponivel: true },
      { indice: 1, product_id: CANECA, variant_id: null, personalizado: true, preco: 40, subtotal: 110, disponivel: true },
    ]);
  });

  test('personalizacao que nao passa: indisponivel com motivo personalizacao', async () => {
    const r = await precos([{ product_id: CANECA, quantity: 1, customization: {} }]);
    expect(r.body.itens).toEqual([
      { indice: 0, product_id: CANECA, variant_id: null, personalizado: true, preco: null, subtotal: null,
        disponivel: false, motivo: 'personalizacao' },
    ]);
  });

  test('loja que esconde os precos: sem preco nem subtotal', async () => {
    config.show_prices = false;
    const r = await precos([{ product_id: CANECA, quantity: 1, customization: { nome: 'Ana' } }]);
    expect(r.body.itens[0]).toMatchObject({ preco: null, subtotal: null, disponivel: true });
  });
});

describe('regras puras', () => {
  test('ehPecaPersonalizada: marca E configurador', () => {
    expect(ehPecaPersonalizada({ is_personalizable: true, customization_config: { fields: [] } })).toBe(true);
    expect(ehPecaPersonalizada({ is_personalizable: true, customization_config: null })).toBe(false);
    expect(ehPecaPersonalizada({ is_personalizable: false, customization_config: { fields: [] } })).toBe(false);
    expect(ehPecaPersonalizada(undefined)).toBe(false);
  });

  test('etapaInicialDoPedido: toda linha com arte ou texto -> pending_art', () => {
    const cfg = { fields: [{ id: 'nome', type: 'text' }] };
    const linha = (c) => ({ customization: c, produto: { customization_config: cfg } });
    expect(etapaInicialDoPedido([linha({ nome: 'Ana' })])).toBe('pending_art');
    expect(etapaInicialDoPedido([linha({ nome: 'Ana' }), linha({ nome: ' ' })])).toBe('awaiting_customization');
    expect(etapaInicialDoPedido([linha(null)])).toBe('awaiting_customization');
  });

  test('temPersonalizacao continua a mesma do p-177 (exportada pela rota)', () => {
    const rota = require('../src/routes/studioPersonalizacaoDoPedido')._internals;
    expect(rota.temPersonalizacao).toBe(temPersonalizacao);
  });
});

describe('job do Pix: pedido da loja comum com personalizado', () => {
  const HORA = 3600 * 1000;
  const pedido = (vertical, horas) => ({
    payment_method: 'pix', status: 'pending_payment', payment_status: 'pending', vertical,
    studio_production_status: vertical ? 'pending_art' : null, deposit_paid: false,
    created_at: new Date(Date.now() - horas * HORA).toISOString(),
  });

  test('com personalizado (vertical studio): 50 h ainda nao venceu, 73 h venceu', () => {
    expect(situacaoDoPixVencido(pedido('studio', 50))).toEqual({ vencido: false, motivo: null });
    expect(situacaoDoPixVencido(pedido('studio', 73))).toEqual({ vencido: true, motivo: null });
  });

  test('so de prateleira (vertical nula): vence em 48 h, como sempre', () => {
    expect(situacaoDoPixVencido(pedido(null, 47))).toEqual({ vencido: false, motivo: null });
    expect(situacaoDoPixVencido(pedido(null, 49))).toEqual({ vencido: true, motivo: null });
  });
});
