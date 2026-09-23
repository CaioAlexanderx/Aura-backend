// ============================================================
// AURA. — Matcon M1: orcamentos e entregas (migration 352)
//
// O que este arquivo trava:
//   1. lista de orcamentos + summary da esteira (open/expiring/approved/
//      lost, com "vencendo" usando matcon_quote_warn_days);
//   2. criacao com validade padrao = hoje + matcon_quote_valid_days, conta
//      do total feita no servidor e cliente de outro dono recusado;
//   3. convert: aprova e devolve o carrinho, NAO cria venda; lost e ja
//      convertido viram 409;
//   4. entrega parcial: nunca entrega mais do que falta, e o saldo vira a
//      proxima entrega (sequence + 1);
//   5. gate: matcon_enabled desligado bloqueia SO a escrita (403
//      MATCON_DISABLED), leitura continua.
//
// Banco mockado por CONTEUDO do SQL (mesmo padrao de pdvSaleComSinal):
// a ordem interna das queries pode mudar sem quebrar o teste. O SQL de
// verdade foi exercitado contra um Postgres com a 352 aplicada no PR.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../src/middleware/auth');
const matconRouter = require('../src/routes/matconOrcamentosEntregas');

let db;
beforeAll(() => { db = require('../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const qid = '3b1f6a2e-0c4d-4e8f-9a7b-1c2d3e4f5a6b';
const did = '7d6c5b4a-3f2e-4d1c-8b9a-0f1e2d3c4b5a';
const saleId = 'aaaaaaaa-1111-4222-8333-444444444444';
const siCimento = 'bbbbbbbb-1111-4222-8333-444444444444';
const siPiso = 'cccccccc-1111-4222-8333-444444444444';
const prod = 'dddddddd-1111-4222-8333-444444444444';
const admin = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

const app = express();
app.use(express.json());
const scoped = express.Router({ mergeParams: true });
scoped.use(requireAuth);
scoped.use(requireCompanyAccess());
scoped.use('/matcon', matconRouter);
app.use('/api/v1/companies/:id', scoped);

const base = `/api/v1/companies/${cid}/matcon`;

const LIGADO = { matcon_enabled: true, matcon_quote_valid_days: 10, matcon_quote_warn_days: 2, matcon_default_delivery_days: 3 };

function quoteRow(extra) {
  return {
    id: qid, number: 7, status: 'open', customer_id: null, customer_name: 'Joao da Silva',
    customer_phone: '11999990000', seller_id: null, seller_name: 'Operadora',
    valid_until: '2026-10-03', public_token: 'f'.repeat(32),
    items: [{ product_id: prod, name: 'Cimento CP-II', unit: 'sc', quantity: 10, unit_price: 38.9, discount: 0 }],
    subtotal: 389, discount: 0, total: 389, notes: null, reference: 'obra Rua das Acacias',
    approved_at: null, converted_sale_id: null, sent_at: null,
    created_at: '2026-09-23T12:00:00.000Z', updated_at: '2026-09-23T12:00:00.000Z',
    ...extra,
  };
}

// Dispatcher do db.query por texto do SQL. `over` pode trocar qualquer
// resposta: chave = regex, valor = rows ou funcao(sql, params) -> rows.
function mockDb(over = [], settings = LIGADO) {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql || '');
    for (const [re, resp] of over) {
      if (re.test(s)) {
        const rows = typeof resp === 'function' ? resp(s, params) : resp;
        return rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows });
      }
    }
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: settings }] });
    return Promise.resolve({ rows: [] });
  });
}

const callsMatching = (fn, re) => fn.mock.calls.filter((c) => re.test(String(c[0] || '')));

describe('GET /matcon/quotes — lista e cabecalho da esteira', () => {
  test('devolve quotes + summary com count/total por estacao', async () => {
    mockDb([
      [/COUNT\(\*\) FILTER \(WHERE status = 'open'\)/i, [{
        open_count: 3, open_total: 4210.5, expiring_count: 1, expiring_total: 389,
        approved_count: 2, approved_total: 1500, lost_count: 1, lost_total: 240,
      }]],
      [/FROM matcon_quotes q\s+WHERE/i, [quoteRow()]],
    ]);

    const res = await request(app).get(`${base}/quotes?status=open&q=joao`).set(admin);

    expect(res.status).toBe(200);
    expect(res.body.quotes).toHaveLength(1);
    expect(res.body.quotes[0]).toMatchObject({ id: qid, number: 7, status: 'open', valid_until: '2026-10-03', total: 389 });
    expect(res.body.quotes[0].items[0]).toEqual({ product_id: prod, name: 'Cimento CP-II', unit: 'sc', quantity: 10, unit_price: 38.9, discount: 0 });
    expect(res.body.summary).toEqual({
      open: { count: 3, total: 4210.5 },
      expiring: { count: 1, total: 389 },
      approved: { count: 2, total: 1500 },
      lost: { count: 1, total: 240 },
    });
  });

  test('"vencendo" usa matcon_quote_warn_days da loja e o filtro vai parametrizado', async () => {
    mockDb();
    await request(app).get(`${base}/quotes?status=open&q=joao`).set(admin);

    const [sumSql, sumParams] = callsMatching(db.query, /expiring_count/i)[0];
    expect(sumSql).toMatch(/valid_until <= \(NOW\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date \+ \$2::int/);
    expect(sumParams).toEqual([cid, 2]);

    const [listSql, listParams] = callsMatching(db.query, /FROM matcon_quotes q\s+WHERE/i)[0];
    expect(listSql).toMatch(/q\.status = \$2/);
    expect(listParams).toEqual([cid, 'open', '%joao%', 100]);
  });

  test('busca so com digitos tambem procura pelo numero do orcamento', async () => {
    mockDb();
    await request(app).get(`${base}/quotes?q=42`).set(admin);
    const [listSql, listParams] = callsMatching(db.query, /FROM matcon_quotes q\s+WHERE/i)[0];
    expect(listSql).toMatch(/q\.number = \$3/);
    expect(listParams).toEqual([cid, '%42%', 42, 100]);
  });

  test('status fora da lista: 400 antes de ir ao banco', async () => {
    mockDb();
    const res = await request(app).get(`${base}/quotes?status=aberto`).set(admin);
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('POST /matcon/quotes — criacao', () => {
  const body = {
    items: [
      { product_id: prod, name: 'Cimento CP-II', unit: 'sc', quantity: 10, unit_price: 38.9 },
      { product_id: prod + '__variante', name: 'Porcelanato', unit: 'm²', quantity: 13.92, unit_price: 59.9, discount: 5 },
    ],
    discount: 10,
  };

  test('201: validade padrao = hoje + matcon_quote_valid_days (no banco, dia de SP) e total do servidor', async () => {
    mockDb([[/INSERT INTO matcon_quotes/i, [quoteRow({ subtotal: 1217.81, discount: 10, total: 1207.81 })]]]);

    const res = await request(app).post(`${base}/quotes`).set(admin).send(body);

    expect(res.status).toBe(201);
    expect(res.body.quote).toMatchObject({ id: qid, number: 7, total: 1207.81 });
    const [sql, params] = callsMatching(db.query, /INSERT INTO matcon_quotes/i)[0];
    expect(sql).toMatch(/COALESCE\(\$7::date, \(NOW\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date \+ \$8::int\)/);
    expect(params[6]).toBeNull();      // valid_until nao veio
    expect(params[7]).toBe(10);        // matcon_quote_valid_days
    // 10 x 38,90 + (13,92 x 59,90 = 833,81) - 5 = 1217,81; - 10 = 1207,81
    expect(params[9]).toBe(1217.81);
    expect(params[10]).toBe(10);
    expect(params[11]).toBe(1207.81);
    const itens = JSON.parse(params[8]);
    expect(itens[0]).toEqual({ product_id: prod, name: 'Cimento CP-II', unit: 'sc', quantity: 10, unit_price: 38.9, discount: 0 });
    // chave de variante do Caixa nao e um produto: vira null, nao trava
    expect(itens[1].product_id).toBeNull();
    expect(itens[1].quantity).toBe(13.92);
  });

  test('sem a chave na loja, validade padrao do contrato (7 dias)', async () => {
    mockDb([[/INSERT INTO matcon_quotes/i, [quoteRow()]]], { matcon_enabled: true });
    await request(app).post(`${base}/quotes`).set(admin).send(body);
    const [, params] = callsMatching(db.query, /INSERT INTO matcon_quotes/i)[0];
    expect(params[7]).toBe(7);
  });

  test('validade no passado: 400 sem gravar', async () => {
    mockDb();
    const res = await request(app).post(`${base}/quotes`).set(admin).send({ ...body, valid_until: '2020-01-01' });
    expect(res.status).toBe(400);
    expect(callsMatching(db.query, /INSERT INTO matcon_quotes/i)).toHaveLength(0);
  });

  test('sem itens: 400 com texto de gente', async () => {
    mockDb();
    const res = await request(app).post(`${base}/quotes`).set(admin).send({ items: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Adicione pelo menos um produto ao orçamento.');
  });

  test('cliente que nao e deste dono: 404 CUSTOMER_NOT_FOUND', async () => {
    mockDb([[/FROM customers WHERE id/i, []]]);
    const res = await request(app).post(`${base}/quotes`).set(admin)
      .send({ ...body, customer_id: 'eeeeeeee-1111-4222-8333-444444444444' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });

  test('nome e telefone vem do cadastro quando o body so manda customer_id', async () => {
    mockDb([
      [/FROM customers WHERE id/i, [{ id: 'eeeeeeee-1111-4222-8333-444444444444', name: 'Maria Souza', phone: '11988887777' }]],
      [/INSERT INTO matcon_quotes/i, [quoteRow()]],
    ]);
    await request(app).post(`${base}/quotes`).set(admin)
      .send({ ...body, customer_id: 'eeeeeeee-1111-4222-8333-444444444444' });
    const [, params] = callsMatching(db.query, /INSERT INTO matcon_quotes/i)[0];
    expect(params.slice(1, 4)).toEqual(['eeeeeeee-1111-4222-8333-444444444444', 'Maria Souza', '11988887777']);
  });
});

describe('POST /matcon/quotes/:qid/convert — virar pedido', () => {
  test('aprova e devolve o carrinho; nao toca em sales', async () => {
    mockDb([[/UPDATE matcon_quotes q\s+SET status = 'approved'/i, [quoteRow({ status: 'approved', approved_at: '2026-09-23T13:00:00Z' })]]]);

    const res = await request(app).post(`${base}/quotes/${qid}/convert`).set(admin);

    expect(res.status).toBe(200);
    expect(res.body.quote.status).toBe('approved');
    expect(res.body.cart).toEqual([{ product_id: prod, name: 'Cimento CP-II', unit: 'sc', quantity: 10, unit_price: 38.9 }]);
    const [sql] = callsMatching(db.query, /UPDATE matcon_quotes/i)[0];
    expect(sql).toMatch(/q\.status <> 'lost'/);
    expect(sql).toMatch(/q\.converted_sale_id IS NULL/);
    expect(callsMatching(db.query, /INSERT INTO sales|UPDATE sales/i)).toHaveLength(0);
  });

  test('orcamento perdido: 409 QUOTE_LOST', async () => {
    mockDb([[/FROM matcon_quotes q WHERE q\.id/i, [quoteRow({ status: 'lost' })]]]);
    const res = await request(app).post(`${base}/quotes/${qid}/convert`).set(admin);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QUOTE_LOST');
  });

  test('ja virou venda: 409 QUOTE_ALREADY_CONVERTED', async () => {
    mockDb([[/FROM matcon_quotes q WHERE q\.id/i, [quoteRow({ status: 'approved', converted_sale_id: saleId })]]]);
    const res = await request(app).post(`${base}/quotes/${qid}/convert`).set(admin);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QUOTE_ALREADY_CONVERTED');
  });
});

describe('PATCH /matcon/quotes/:qid', () => {
  test('orcamento que ja virou pedido nao muda de itens nem de situacao', async () => {
    mockDb([[/FROM matcon_quotes q WHERE q\.id/i, [quoteRow({ status: 'approved', converted_sale_id: saleId })]]]);
    const res = await request(app).patch(`${base}/quotes/${qid}`).set(admin).send({ status: 'lost' });
    expect(res.status).toBe(409);
    expect(callsMatching(db.query, /UPDATE matcon_quotes/i)).toHaveLength(0);
  });

  test('status expired nao e aceito pela tela (so o job grava)', async () => {
    mockDb([[/FROM matcon_quotes q WHERE q\.id/i, [quoteRow()]]]);
    const res = await request(app).patch(`${base}/quotes/${qid}`).set(admin).send({ status: 'expired' });
    expect(res.status).toBe(400);
  });

  test('reabrir orcamento vencido renova a validade', async () => {
    mockDb([
      [/FROM matcon_quotes q WHERE q\.id/i, [quoteRow({ status: 'expired', valid_until: '2020-01-01' })]],
      [/UPDATE matcon_quotes q/i, [quoteRow()]],
    ]);
    const res = await request(app).patch(`${base}/quotes/${qid}`).set(admin).send({ status: 'open' });
    expect(res.status).toBe(200);
    const [, params] = callsMatching(db.query, /UPDATE matcon_quotes q/i)[0];
    expect(params[2]).toBe('open');
    expect(params[8]).toBe(true);  // renovar
    expect(params[9]).toBe(10);    // matcon_quote_valid_days
  });
});

describe('Entregas', () => {
  function deliveryRow(extra) {
    return {
      id: did, sale_id: saleId, sale_number: 128, sequence: 1, stage: 'out',
      scheduled_for: '2026-09-26', delivered_by: null, customer_name: 'Joao',
      customer_phone: null, address: 'Rua das Acacias, 233', total: 1207.81,
      has_pending: true, public_token: 'e'.repeat(32), out_at: null, delivered_at: null,
      created_at: '2026-09-23T12:00:00Z', nfe_emission_id: null, nfe_number: null,
      nfe_status: null, danfe_url: null,
      items: [
        { sale_item_id: siCimento, product_id: prod, unit_price: 38.9, lot_code: null, name: 'Cimento', unit: 'sc', quantity: 10, sold_quantity: 10, delivered_before: 0 },
      ],
      ...extra,
    };
  }

  test('GET: lista no formato Delivery e summary com pending_orders', async () => {
    mockDb([
      [/separating_count/i, [{
        separating_count: 2, separating_total: 800, ready_count: 1, ready_total: 300,
        out_count: 1, out_total: 1207.81, delivered_today_count: 3, delivered_today_total: 900, pending_orders: 1,
      }]],
      [/FROM matcon_deliveries d\s+JOIN sales s/i, [deliveryRow()]],
    ]);
    const res = await request(app).get(`${base}/deliveries?day=today&stage=out`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body.deliveries[0]).toMatchObject({
      id: did, sale_number: 128, sequence: 1, stage: 'out', scheduled_for: '2026-09-26',
      total: 1207.81, has_pending: true, nfe_emission_id: null,
    });
    expect(res.body.deliveries[0].items[0]).toMatchObject({ sale_item_id: siCimento, sold_quantity: 10, delivered_before: 0, lot_code: null });
    expect(res.body.summary).toEqual({
      separating: { count: 2, total: 800 },
      ready: { count: 1, total: 300 },
      out: { count: 1, total: 1207.81 },
      delivered_today: { count: 3, total: 900 },
      pending_orders: 1,
    });
    const [sql, params] = callsMatching(db.query, /ORDER BY d\.scheduled_for/i)[0];
    expect(sql).toMatch(/d\.scheduled_for = \(NOW\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date/);
    expect(sql).toMatch(/d\.cancelled_at IS NULL/);
    expect(params).toEqual([cid, 'out', 200]);
  });

  test('PATCH stage=out carimba out_at; delivered carimba delivered_at', async () => {
    mockDb([
      [/UPDATE matcon_deliveries SET/i, [{ id: did }]],
      [/FROM matcon_deliveries d\s+JOIN sales s/i, [deliveryRow()]],
    ]);
    const res = await request(app).patch(`${base}/deliveries/${did}`).set(admin).send({ stage: 'out', delivered_by: '  Seu Zé ' });
    expect(res.status).toBe(200);
    const [sql, params] = callsMatching(db.query, /UPDATE matcon_deliveries SET/i)[0];
    expect(sql).toMatch(/out_at = CASE WHEN \$3::text IN \('out', 'delivered'\) THEN COALESCE\(out_at, NOW\(\)\)/);
    expect(sql).toMatch(/delivered_at = CASE WHEN \$3::text = 'delivered'/);
    expect(params).toEqual([did, cid, 'out', 'Seu Zé']);
  });

  describe('POST /:did/split — entrega parcial', () => {
    // client da transacao: a entrega aberta, os itens com o que ja foi.
    function mockSplitClient({ stage = 'out', itens } = {}) {
      const query = jest.fn().mockImplementation((sql) => {
        const s = String(sql || '');
        if (/FROM matcon_deliveries\s+WHERE id = \$1 AND company_id = \$2 AND cancelled_at IS NULL\s+FOR UPDATE/i.test(s)) {
          return Promise.resolve({ rows: [{ id: did, sale_id: saleId, stage, customer_name: 'Joao', customer_phone: null, address: 'Rua X' }] });
        }
        if (/AS planned_elsewhere/i.test(s)) return Promise.resolve({ rows: itens });
        if (/INSERT INTO matcon_deliveries/i.test(s)) return Promise.resolve({ rows: [{ id: 'next-1' }] });
        return Promise.resolve({ rows: [] });
      });
      const client = { query, release: jest.fn() };
      db.connect.mockResolvedValue(client);
      return client;
    }

    const ITENS = [
      { sale_item_id: siCimento, name: 'Cimento', sold: 10, delivered: 0, planned_elsewhere: 0 },
      { sale_item_id: siPiso, name: 'Porcelanato', sold: 13.92, delivered: 0, planned_elsewhere: 0 },
    ];

    test('entrega 6 de 10: esta fica delivered e a proxima nasce com o saldo (sequence + 1)', async () => {
      mockDb([[/FROM matcon_deliveries d\s+JOIN sales s/i, (sql, params) => params[1].map((id) => ({
        ...deliveryRow({ id, stage: id === did ? 'delivered' : 'separating', sequence: id === did ? 1 : 2 }),
      }))]]);
      const client = mockSplitClient({ itens: ITENS });

      const res = await request(app).post(`${base}/deliveries/${did}/split`).set(admin).send({
        items: [{ sale_item_id: siCimento, quantity: 6 }, { sale_item_id: siPiso, quantity: 13.92 }],
        delivered_by: 'Seu Zé',
      });

      expect(res.status).toBe(200);
      expect(res.body.delivered.stage).toBe('delivered');
      expect(res.body.next).not.toBeNull();
      expect(res.body.next.sequence).toBe(2);

      const [, upd] = callsMatching(client.query, /UPDATE matcon_delivery_items di/i)[0];
      expect(upd).toEqual([did, [siCimento, siPiso], [6, 13.92]]);
      const [insSql] = callsMatching(client.query, /INSERT INTO matcon_deliveries/i)[0];
      expect(insSql).toMatch(/COALESCE\(MAX\(sequence\), 0\) \+ 1/);
      // so o cimento tem saldo (4); o piso foi inteiro
      const [, saldo] = callsMatching(client.query, /INSERT INTO matcon_delivery_items/i)[0];
      expect(saldo).toEqual(['next-1', [siCimento], [4]]);
      expect(callsMatching(client.query, /^COMMIT$/)).toHaveLength(1);
    });

    test('nunca entrega mais do que falta: 400 e ROLLBACK', async () => {
      mockDb();
      const client = mockSplitClient({
        itens: [{ sale_item_id: siCimento, name: 'Cimento', sold: 10, delivered: 6, planned_elsewhere: 0 }],
      });
      const res = await request(app).post(`${base}/deliveries/${did}/split`).set(admin)
        .send({ items: [{ sale_item_id: siCimento, quantity: 5 }] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Cimento/);
      expect(res.body.error).toMatch(/4/);
      expect(callsMatching(client.query, /UPDATE matcon_delivery_items/i)).toHaveLength(0);
      expect(callsMatching(client.query, /^ROLLBACK$/)).toHaveLength(1);
    });

    test('entregou tudo o que faltava: nao cria proxima (next null)', async () => {
      mockDb([[/FROM matcon_deliveries d\s+JOIN sales s/i, [deliveryRow({ stage: 'delivered' })]]]);
      const client = mockSplitClient({
        itens: [{ sale_item_id: siCimento, name: 'Cimento', sold: 10, delivered: 6, planned_elsewhere: 0 }],
      });
      const res = await request(app).post(`${base}/deliveries/${did}/split`).set(admin)
        .send({ items: [{ sale_item_id: siCimento, quantity: 4 }] });
      expect(res.status).toBe(200);
      expect(res.body.next).toBeNull();
      expect(callsMatching(client.query, /INSERT INTO matcon_deliveries/i)).toHaveLength(0);
    });

    test('item que nao e desta entrega: 400', async () => {
      mockDb();
      mockSplitClient({ itens: ITENS });
      const res = await request(app).post(`${base}/deliveries/${did}/split`).set(admin)
        .send({ items: [{ sale_item_id: 'ffffffff-1111-4222-8333-444444444444', quantity: 1 }] });
      expect(res.status).toBe(400);
    });

    test('entrega ja entregue: 409', async () => {
      mockDb();
      mockSplitClient({ stage: 'delivered', itens: ITENS });
      const res = await request(app).post(`${base}/deliveries/${did}/split`).set(admin)
        .send({ items: [{ sale_item_id: siCimento, quantity: 1 }] });
      expect(res.status).toBe(409);
    });
  });
});

describe('Gate matcon_enabled — so a escrita', () => {
  const DESLIGADO = { matcon_enabled: false };
  const escritas = [
    ['post', '/quotes', { items: [{ name: 'x', quantity: 1, unit_price: 1 }] }],
    ['patch', `/quotes/${qid}`, { status: 'lost' }],
    ['post', `/quotes/${qid}/sent`, {}],
    ['post', `/quotes/${qid}/convert`, {}],
    ['post', '/deliveries', { sale_id: saleId }],
    ['patch', `/deliveries/${did}`, { stage: 'ready' }],
    ['post', `/deliveries/${did}/split`, { items: [{ sale_item_id: siCimento, quantity: 1 }] }],
  ];

  test.each(escritas)('%s %s com toggle off: 403 MATCON_DISABLED sem escrever', async (metodo, rota, body) => {
    mockDb([], DESLIGADO);
    const res = await request(app)[metodo](`${base}${rota}`).set(admin).send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('MATCON_DISABLED');
    expect(callsMatching(db.query, /INSERT|UPDATE/i)).toHaveLength(0);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('leitura continua liberada com o toggle off', async () => {
    mockDb([], DESLIGADO);
    expect((await request(app).get(`${base}/quotes`).set(admin)).status).toBe(200);
    expect((await request(app).get(`${base}/deliveries`).set(admin)).status).toBe(200);
  });
});

describe('Job diario: orcamento vencido vira expired', () => {
  const job = require('../src/jobs/matconQuoteExpiryJob');

  test('so open com valid_until ANTES de hoje (dia de SP) muda', async () => {
    db.query.mockResolvedValue({ rows: [{ n: 4 }] });
    const n = await job.expireMatconQuotes();
    expect(n).toBe(4);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'expired'/);
    expect(sql).toMatch(/WHERE status = 'open'/);
    expect(sql).toMatch(/valid_until < \(NOW\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date/);
  });

  test('banco sem a 352: nao derruba nada', async () => {
    const e = new Error('relation "matcon_quotes" does not exist'); e.code = '42P01';
    db.query.mockRejectedValue(e);
    await expect(job.expireMatconQuotes()).resolves.toBeNull();
  });
});
