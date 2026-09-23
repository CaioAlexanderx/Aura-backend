// ============================================================
// AURA. — Matcon M1: paginas publicas (sem login)
//
//   GET  /orcamento/:token          → orcamento Matcon no formato PublicQuote
//                                     + kind "matcon" (so quando o token nao
//                                     e de orcamento do Studio)
//   POST /orcamento/:token/respond  → aceitar = approved, recusar = lost
//   GET  /acompanhar/:token         → entrega: tipo "entrega", 5 etapas,
//                                     itens "6 de 10 sc" depois da 1a viagem
//                                     e proxima_entrega
//
// O que NAO pode sair: telefone, endereco, sobrenome (o link e
// reencaminhavel).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const quotePublic = require('../src/routes/studioQuotePublic');
const trackPublic = require('../src/routes/studioTrackPublic');

let db;
beforeAll(() => { db = require('../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const app = express();
app.use(express.json());
app.use('/orcamento', quotePublic);
app.use('/acompanhar', trackPublic);

const TOKEN = 'ab'.repeat(16);
const callsMatching = (fn, re) => fn.mock.calls.filter((c) => re.test(String(c[0] || '')));

function matconQuote(extra) {
  return {
    id: 'q1', public_token: TOKEN, status: 'open', valid_until: '2026-10-03', vencido: false,
    customer_name: 'Joao da Silva', total: 1207.81, responded_at: null, response_note: null,
    items: [
      { product_id: 'p1', name: 'Cimento CP-II', unit: 'sc', quantity: 10, unit_price: 38.9, discount: 0 },
      { product_id: null, name: 'Porcelanato', unit: 'm²', quantity: 13.92, unit_price: 59.9, discount: 5 },
    ],
    trade_name: 'Casa do Construtor', legal_name: 'Casa LTDA', site_name: null, logo_url: null,
    primary_color: '#EF4444', secondary_color: null, font_family: null,
    dc_whatsapp: '(11) 3333-4444', dc_phone: null, instagram: null,
    ...extra,
  };
}

describe('GET /orcamento/:token — orcamento Matcon', () => {
  test('token que nao e do Studio cai no Matcon com kind "matcon" e conta que fecha', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM studio_quotes q/i.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM matcon_quotes q/i.test(s)) return Promise.resolve({ rows: [matconQuote()] });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app).get(`/orcamento/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('matcon');
    expect(res.body.status).toBe('sent');
    // fim do dia de validade no fuso de SP (new Date() no app nao volta um dia)
    expect(res.body.expires_at).toBe('2026-10-03T23:59:59-03:00');
    expect(res.body.customer_name).toBe('Joao');
    expect(res.body.shop).toMatchObject({ name: 'Casa do Construtor', whatsapp: '1133334444', primary_color: '#EF4444' });
    expect(res.body.items[1]).toEqual({ description: 'Porcelanato', quantity: 13.92, unit_price: 59.9, customization: null, unit: 'm²' });
    // linha = qtd x preco cheio; desconto de item + do orcamento no rodape
    expect(res.body.subtotal).toBe(1222.81);
    expect(res.body.total).toBe(1207.81);
    expect(res.body.discount).toBe(15);
    expect(JSON.stringify(res.body)).not.toMatch(/customer_phone|11999/);
  });

  test.each([
    ['approved', false, 'accepted'],
    ['lost', false, 'rejected'],
    ['expired', false, 'expired'],
    ['open', true, 'expired'],
  ])('status %s (vencido=%s) aparece como %s', async (status, vencido, publico) => {
    db.query.mockImplementation((sql) => Promise.resolve({
      rows: /FROM matcon_quotes q/i.test(String(sql)) ? [matconQuote({ status, vencido })] : [],
    }));
    const res = await request(app).get(`/orcamento/${TOKEN}`);
    expect(res.body.status).toBe(publico);
  });

  test('token de ninguem: 404 de sempre', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get(`/orcamento/${TOKEN}`);
    expect(res.status).toBe(404);
  });

  test('orcamento do Studio continua sem kind e sem consultar o Matcon', async () => {
    db.query.mockImplementation((sql) => Promise.resolve({
      rows: /FROM studio_quotes q/i.test(String(sql))
        ? [{ id: 's1', token: TOKEN, status: 'sent', expires_at: '2026-10-01T00:00:00Z', items: [], subtotal: 10, discount: 0, total: 10 }]
        : [],
    }));
    const res = await request(app).get(`/orcamento/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBeUndefined();
    expect(callsMatching(db.query, /matcon_quotes/i)).toHaveLength(0);
  });
});

describe('POST /orcamento/:token/respond — orcamento Matcon', () => {
  function mockClient(matcon) {
    const query = jest.fn().mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM studio_quotes WHERE token/i.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM matcon_quotes WHERE public_token/i.test(s)) return Promise.resolve({ rows: matcon ? [matcon] : [] });
      return Promise.resolve({ rows: [] });
    });
    const client = { query, release: jest.fn() };
    db.connect.mockResolvedValue(client);
    return client;
  }

  test('aceitar grava approved (+ approved_at) e responde na lingua do Studio', async () => {
    const client = mockClient({ id: 'q1', status: 'open', vencido: false });
    const res = await request(app).post(`/orcamento/${TOKEN}/respond`).send({ action: 'accept' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: 'accept', new_status: 'accepted' });
    const [sql, params] = callsMatching(client.query, /UPDATE matcon_quotes/i)[0];
    expect(sql).toMatch(/approved_at\s+= CASE WHEN \$1::text = 'approved'/);
    expect(params[0]).toBe('approved');
    expect(callsMatching(client.query, /^COMMIT$/)).toHaveLength(1);
  });

  test('recusar grava lost', async () => {
    const client = mockClient({ id: 'q1', status: 'open', vencido: false });
    const res = await request(app).post(`/orcamento/${TOKEN}/respond`).send({ action: 'reject', note: 'achei caro' });
    expect(res.body.new_status).toBe('rejected');
    const [, params] = callsMatching(client.query, /UPDATE matcon_quotes/i)[0];
    expect(params).toEqual(['lost', 'achei caro', 'q1']);
  });

  test('ja respondido: 409', async () => {
    mockClient({ id: 'q1', status: 'approved', vencido: false });
    const res = await request(app).post(`/orcamento/${TOKEN}/respond`).send({ action: 'accept' });
    expect(res.status).toBe(409);
  });

  test('vencido: 410 e marca expired', async () => {
    const client = mockClient({ id: 'q1', status: 'open', vencido: true });
    const res = await request(app).post(`/orcamento/${TOKEN}/respond`).send({ action: 'accept' });
    expect(res.status).toBe(410);
    expect(callsMatching(client.query, /SET status = 'expired'/i)).toHaveLength(1);
  });
});

describe('GET /acompanhar/:token — entrega do Matcon', () => {
  const ENTREGA = {
    id: 'd2', sale_id: '99999999-8888-4777-8666-555555555555', company_id: 'c1', cancelled_at: null,
    sale_status: 'completed', sale_number: 128, total_amount: 1207.81, created_at: '2026-09-20T12:00:00Z',
    customer_name: 'Joao da Silva', loja: 'Casa do Construtor', danfe_url: null,
  };

  function mockTracker({ entrega = ENTREGA, viagens, itens }) {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/FROM matcon_deliveries d\s+JOIN sales s/i.test(s)) return Promise.resolve({ rows: entrega ? [entrega] : [] });
      if (/FROM matcon_deliveries\s+WHERE sale_id = \$1 AND cancelled_at IS NULL\s+ORDER BY sequence/i.test(s)) return Promise.resolve({ rows: viagens });
      if (/AS entregue\s+FROM sale_items si/i.test(s)) return Promise.resolve({ rows: itens });
      return Promise.resolve({ rows: [] }); // sales, vitrine, OS, parcelas: nada
    });
  }

  test('depois da 1a viagem: itens "6 de 10 sc" e data da proxima', async () => {
    mockTracker({
      viagens: [
        { stage: 'delivered', sequence: 1, scheduled_for: '2026-09-23' },
        { stage: 'separating', sequence: 2, scheduled_for: '2026-09-26' },
      ],
      itens: [
        { nome: 'Cimento CP-II', total: 10, unidade: 'sc', entregue: 6 },
        { nome: 'Porcelanato', total: 13.92, unidade: 'm²', entregue: 13.92 },
      ],
    });

    const res = await request(app).get(`/acompanhar/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.tipo).toBe('entrega');
    expect(res.body.pedido).toBe('128');
    expect(res.body.cliente).toBe('Joao');
    expect(res.body.etapas.map((e) => e.key)).toEqual(['aprovado', 'separando', 'pronto', 'saiu', 'entregue']);
    expect(res.body.etapa_atual).toBe(1);
    expect(res.body.itens[0]).toEqual({ nome: 'Cimento CP-II', qtd: 10, entregue: 6, total: 10, unidade: 'sc' });
    expect(res.body.proxima_entrega).toBe('2026-09-26');
    expect(res.body.entrega_combinada).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/Rua|address|telefone|phone/i);
  });

  test('antes da 1a viagem: lista simples e a data combinada', async () => {
    mockTracker({
      viagens: [{ stage: 'out', sequence: 1, scheduled_for: '2026-09-24' }],
      itens: [{ nome: 'Cimento CP-II', total: 10, unidade: 'sc', entregue: 0 }],
    });
    const res = await request(app).get(`/acompanhar/${TOKEN}`);
    expect(res.body.etapa_atual).toBe(3); // saiu
    expect(res.body.itens[0]).toEqual({ nome: 'Cimento CP-II', qtd: 10 });
    expect(res.body.entrega_combinada).toBe('2026-09-24');
    expect(res.body.proxima_entrega).toBeNull();
  });

  test('tudo entregue: ultima etapa', async () => {
    mockTracker({
      viagens: [{ stage: 'delivered', sequence: 1, scheduled_for: '2026-09-23' }],
      itens: [{ nome: 'Cimento CP-II', total: 10, unidade: 'sc', entregue: 10 }],
    });
    const res = await request(app).get(`/acompanhar/${TOKEN}`);
    expect(res.body.etapa_atual).toBe(4);
    expect(res.body.proxima_entrega).toBeNull();
  });

  test('venda cancelada: cancelado true, sem itens', async () => {
    mockTracker({ entrega: { ...ENTREGA, cancelled_at: '2026-09-23T15:00:00Z' }, viagens: [], itens: [] });
    const res = await request(app).get(`/acompanhar/${TOKEN}`);
    expect(res.body).toEqual({ cancelado: true, loja: 'Casa do Construtor', cliente: 'Joao', pedido: '128', tipo: 'entrega' });
  });
});
