// ============================================================
// AURA. — Matcon M1: a venda que nasce de um orcamento (quote_id)
//
// O Caixa abre o orcamento convertido e manda `quote_id` no POST
// /pdv/sale. Este arquivo trava:
//   1. com quote_id: sales.quote_id, matcon_quotes.converted_sale_id e a
//      1a entrega (separating, hoje + matcon_default_delivery_days) com
//      TODOS os itens da venda — tudo DENTRO da transacao, antes do COMMIT;
//   2. orcamento de outra loja, perdido ou ja convertido: a venda inteira
//      volta (ROLLBACK) com o codigo certo;
//   3. SEM quote_id: o gancho nao faz nenhuma consulta (venda comum igual);
//   4. cancelar a venda (DELETE /pdv/sale e POST /sales/:id/cancel) tira
//      as entregas da esteira e libera o orcamento;
//   5. has_pending_delivery no detalhe e nas listas, calculado DENTRO do
//      SELECT que ja existia (sem ida extra ao banco).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../src/middleware/auth');
const pdvRouter = require('../src/routes/pdv');
const salesRouter = require('../src/routes/sales');
const hooks = require('../src/services/matconSaleHooks');

let db;
beforeAll(() => { db = require('../src/config/database'); });
beforeEach(() => { jest.resetAllMocks(); hooks._resetCache(); });

const SECRET = 'aura-test-secret-2026';
const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const qid = '3b1f6a2e-0c4d-4e8f-9a7b-1c2d3e4f5a6b';
const prod = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const cust = '11111111-2222-4333-8444-555555555555';
const saleId = '99999999-8888-4777-8666-555555555555';
const admin = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

const app = express();
app.use(express.json());
const scoped = express.Router({ mergeParams: true });
scoped.use(requireAuth);
scoped.use(requireCompanyAccess());
scoped.use('/pdv', pdvRouter);
scoped.use('/sales', salesRouter);
app.use('/api/v1/companies/:id', scoped);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));

const callsMatching = (fn, re) => fn.mock.calls.filter((c) => re.test(String(c[0] || '')));

function mockSaleClient({ quote = { id: qid, status: 'approved', converted_sale_id: null, customer_name: 'Joao', customer_phone: '1199' }, settings = { matcon_default_delivery_days: 3 } } = {}) {
  const query = jest.fn().mockImplementation((sql) => {
    const s = String(sql || '');
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: settings }] });
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM customers WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ id: cust, name: 'Joao da Silva', phone: '11999990000', street: 'Rua das Acacias', address_number: '233', city: 'Campinas' }] });
    }
    if (/FROM products p JOIN companies c/i.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Cimento', cost_price: '30', stock_qty: '100', stock_company_id: cid }] });
    }
    if (/INSERT INTO sales/i.test(s)) {
      return Promise.resolve({ rows: [{ id: saleId, customer_id: cust, total_amount: '389.00', status: 'completed', tracker_token: null }] });
    }
    if (/FROM matcon_quotes\s+WHERE id = \$1 AND company_id = \$2\s+FOR UPDATE/i.test(s)) {
      return Promise.resolve({ rows: quote ? [quote] : [] });
    }
    if (/INSERT INTO matcon_deliveries/i.test(s)) return Promise.resolve({ rows: [{ id: 'deliv-1', public_token: 'a'.repeat(32) }] });
    return Promise.resolve({ rows: [] });
  });
  const client = { query, release: jest.fn() };
  db.connect.mockResolvedValue(client);
  db.query.mockResolvedValue({ rows: [] });
  return client;
}

const BODY = {
  items: [{ product_id: prod, quantity: 10, unit_price: 38.9 }],
  customer_id: cust,
  payment_method: 'dinheiro',
  sale_date: '2026-09-23',
};
const post = (body) => request(app).post(`/api/v1/companies/${cid}/pdv/sale`).set(admin).send(body);

describe('POST /pdv/sale com quote_id', () => {
  test('grava o vinculo nos dois lados e cria a 1a entrega com todos os itens, antes do COMMIT', async () => {
    const client = mockSaleClient();

    const res = await post({ ...BODY, quote_id: qid });

    expect(res.status).toBe(201);
    expect(res.body.matcon).toEqual({ quote_id: qid, delivery_id: 'deliv-1', delivery_token: 'a'.repeat(32) });
    expect(res.body.sale.quote_id).toBe(qid);

    const [, qParams] = callsMatching(client.query, /UPDATE matcon_quotes\s+SET status = 'approved'/i)[0];
    expect(qParams).toEqual([saleId, qid]);
    const [, sParams] = callsMatching(client.query, /UPDATE sales SET quote_id/i)[0];
    expect(sParams).toEqual([qid, saleId, cid]);

    const [dSql, dParams] = callsMatching(client.query, /INSERT INTO matcon_deliveries/i)[0];
    expect(dSql).toMatch(/'separating'/);
    expect(dSql).toMatch(/COALESCE\(\$3::date, \(NOW\(\) AT TIME ZONE 'America\/Sao_Paulo'\)::date \+ \$4::int\)/);
    expect(dParams[0]).toBe(cid);
    expect(dParams[1]).toBe(saleId);
    expect(dParams[3]).toBe(3); // matcon_default_delivery_days
    expect(dParams[4]).toBe('Joao da Silva');
    expect(dParams[6]).toBe('Rua das Acacias, 233 - Campinas');

    const [iSql, iParams] = callsMatching(client.query, /INSERT INTO matcon_delivery_items/i)[0];
    expect(iSql).toMatch(/FROM sale_items si\s+WHERE si\.sale_id = \$2/);
    expect(iParams).toEqual(['deliv-1', saleId]);

    // Tudo antes do COMMIT: se o Matcon falhar, a venda volta junto.
    const ordem = client.query.mock.calls.map((c) => String(c[0]));
    const iCommit = ordem.indexOf('COMMIT');
    const iDeliv = ordem.findIndex((s) => /INSERT INTO matcon_delivery_items/.test(s));
    expect(iDeliv).toBeGreaterThan(-1);
    expect(iDeliv).toBeLessThan(iCommit);
  });

  test('prazo padrao do contrato (2 dias) quando a loja nao configurou', async () => {
    const client = mockSaleClient({ settings: {} });
    await post({ ...BODY, quote_id: qid });
    const [, dParams] = callsMatching(client.query, /INSERT INTO matcon_deliveries/i)[0];
    expect(dParams[3]).toBe(2);
  });

  test('orcamento de outra loja: 404 QUOTE_NOT_FOUND e a venda volta', async () => {
    const client = mockSaleClient({ quote: null });
    const res = await post({ ...BODY, quote_id: qid });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('QUOTE_NOT_FOUND');
    expect(callsMatching(client.query, /^ROLLBACK$/)).toHaveLength(1);
    expect(callsMatching(client.query, /^COMMIT$/)).toHaveLength(0);
  });

  test('orcamento ja convertido: 409 (evita pedido duplicado)', async () => {
    mockSaleClient({ quote: { id: qid, status: 'approved', converted_sale_id: 'outra-venda' } });
    const res = await post({ ...BODY, quote_id: qid });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QUOTE_ALREADY_CONVERTED');
  });

  test('orcamento perdido: 409 QUOTE_LOST', async () => {
    mockSaleClient({ quote: { id: qid, status: 'lost', converted_sale_id: null } });
    const res = await post({ ...BODY, quote_id: qid });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QUOTE_LOST');
  });

  test('orcamento aberto ou vencido tambem vira venda (o Caixa manda)', async () => {
    for (const status of ['open', 'expired']) {
      const client = mockSaleClient({ quote: { id: qid, status, converted_sale_id: null } });
      const res = await post({ ...BODY, quote_id: qid });
      expect(res.status).toBe(201);
      expect(callsMatching(client.query, /INSERT INTO matcon_deliveries/i)).toHaveLength(1);
    }
  });
});

describe('POST /pdv/sale SEM quote_id — nada muda', () => {
  test('nenhuma consulta do Matcon e nenhum campo novo na resposta', async () => {
    const client = mockSaleClient();
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect(res.body.matcon).toBeUndefined();
    expect(callsMatching(client.query, /matcon_/i)).toHaveLength(0);
    expect(callsMatching(client.query, /UPDATE sales SET quote_id/i)).toHaveLength(0);
  });
});

describe('Cancelamento da venda', () => {
  function mockCancelClient({ tabela = true } = {}) {
    const query = jest.fn().mockImplementation((sql) => {
      const s = String(sql || '');
      if (/FROM sales WHERE id=\$1 AND company_id=\$2/i.test(s) || /FROM sales WHERE id = \$1 AND company_id = \$2 FOR UPDATE/i.test(s)) {
        return Promise.resolve({ rows: [{ id: saleId, total_amount: 389, status: 'completed', type: 'sale', customer_id: null, employee_id: null, coupon_id: null }] });
      }
      if (/to_regclass\('public\.matcon_deliveries'\)/i.test(s)) return Promise.resolve({ rows: [{ ok: tabela }] });
      if (/UPDATE matcon_deliveries\s+SET cancelled_at = NOW\(\)/i.test(s)) {
        return Promise.resolve({ rows: [{ deliveries_cancelled: 2, quotes_released: 1 }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const client = { query, release: jest.fn() };
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });
    return client;
  }

  test('DELETE /pdv/sale: entregas ganham cancelled_at e o orcamento perde o converted_sale_id', async () => {
    const client = mockCancelClient();
    const res = await request(app).delete(`/api/v1/companies/${cid}/pdv/sale/${saleId}`).set(admin);
    expect(res.status).toBe(200);
    const [sql, params] = callsMatching(client.query, /UPDATE matcon_deliveries\s+SET cancelled_at/i)[0];
    expect(sql).toMatch(/UPDATE matcon_quotes\s+SET converted_sale_id = NULL/);
    // O orcamento continua approved: o cliente aprovou, quem desfez foi a loja.
    expect(sql).not.toMatch(/status\s*=/);
    expect(params).toEqual([saleId, cid]);
    const ordem = client.query.mock.calls.map((c) => String(c[0]));
    expect(ordem.findIndex((s) => /UPDATE matcon_deliveries/.test(s))).toBeLessThan(ordem.indexOf('COMMIT'));
  });

  test('POST /sales/:id/cancel devolve deliveries_cancelled', async () => {
    mockCancelClient();
    const res = await request(app).post(`/api/v1/companies/${cid}/sales/${saleId}/cancel`).set(admin).send({});
    expect(res.status).toBe(200);
    expect(res.body.deliveries_cancelled).toBe(2);
  });

  test('banco sem a 352: nao tenta o UPDATE (nao aborta a transacao do cancelamento)', async () => {
    const client = mockCancelClient({ tabela: false });
    const res = await request(app).delete(`/api/v1/companies/${cid}/pdv/sale/${saleId}`).set(admin);
    expect(res.status).toBe(200);
    expect(callsMatching(client.query, /UPDATE matcon_deliveries/i)).toHaveLength(0);
  });
});

describe('has_pending_delivery — dentro do SELECT que ja existia', () => {
  // Backend nos EUA, banco em SP (~190 ms por ida): o selo nao pode custar
  // uma consulta a mais em toda tela de Vendas. A sondagem da tabela fica
  // em cache; o EXISTS vai no SELECT principal.
  function mockDetalhe({ tabela = true, pendente = true } = {}) {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/to_regclass\('public\.matcon_deliveries'\)/i.test(s)) return Promise.resolve({ rows: [{ ok: tabela }] });
      if (/FROM sales s LEFT JOIN users/i.test(s) || /FROM sales s\s+LEFT JOIN customers c/i.test(s)) {
        return Promise.resolve({ rows: [{ id: saleId, total_amount: 389, has_pending_delivery: tabela && pendente }] });
      }
      return Promise.resolve({ rows: [] });
    });
  }
  const consultasSoDoMatcon = () => db.query.mock.calls
    .map((c) => String(c[0]))
    .filter((s) => /matcon_deliveries/.test(s) && !/FROM sales s/.test(s) && !/to_regclass/.test(s));

  test('GET /pdv/sale/:id: EXISTS no SELECT principal, sem consulta separada', async () => {
    mockDetalhe();
    const res = await request(app).get(`/api/v1/companies/${cid}/pdv/sale/${saleId}`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body.has_pending_delivery).toBe(true);
    const [principal] = callsMatching(db.query, /FROM sales s LEFT JOIN users/i)[0];
    expect(principal).toMatch(/EXISTS \(SELECT 1 FROM matcon_deliveries md\s+WHERE md\.sale_id = s\.id/);
    expect(consultasSoDoMatcon()).toHaveLength(0);
  });

  test('GET /sales/:id (detalhe do app): mesmo desenho', async () => {
    mockDetalhe();
    const res = await request(app).get(`/api/v1/companies/${cid}/sales/${saleId}`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body.sale.has_pending_delivery).toBe(true);
    expect(consultasSoDoMatcon()).toHaveLength(0);
  });

  test('a sondagem da tabela e feita uma vez e fica em cache', async () => {
    mockDetalhe();
    await request(app).get(`/api/v1/companies/${cid}/pdv/sale/${saleId}`).set(admin);
    await request(app).get(`/api/v1/companies/${cid}/pdv/sale/${saleId}`).set(admin);
    await request(app).get(`/api/v1/companies/${cid}/sales/${saleId}`).set(admin);
    expect(callsMatching(db.query, /to_regclass/i)).toHaveLength(1);
  });

  test('listas (/sales e /pdv/sales): EXISTS no SELECT da lista, sem consulta separada', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/to_regclass/i.test(s)) return Promise.resolve({ rows: [{ ok: true }] });
      if (/COUNT\(\*\)::int AS total FROM sales/i.test(s)) return Promise.resolve({ rows: [{ total: 1 }] });
      if (/AS total_sales/i.test(s)) return Promise.resolve({ rows: [{ total_sales: 1, active_sales: 1, cancelled_sales: 0, revenue: 389, avg_ticket: 389 }] });
      if (/has_pending_delivery/i.test(s)) return Promise.resolve({ rows: [{ id: saleId, total_amount: 389, has_pending_delivery: true }] });
      return Promise.resolve({ rows: [] });
    });
    const r1 = await request(app).get(`/api/v1/companies/${cid}/sales`).set(admin);
    expect(r1.status).toBe(200);
    expect(r1.body.sales[0].has_pending_delivery).toBe(true);
    const r2 = await request(app).get(`/api/v1/companies/${cid}/pdv/sales`).set(admin);
    expect(r2.status).toBe(200);
    expect(r2.body.sales[0].has_pending_delivery).toBe(true);
    expect(consultasSoDoMatcon()).toHaveLength(0);
  });

  test('banco sem a 352: false no SELECT, sem citar a tabela e sem 500', async () => {
    mockDetalhe({ tabela: false });
    const res = await request(app).get(`/api/v1/companies/${cid}/pdv/sale/${saleId}`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body.has_pending_delivery).toBe(false);
    const [principal] = callsMatching(db.query, /FROM sales s LEFT JOIN users/i)[0];
    expect(principal).toMatch(/false AS has_pending_delivery/);
    expect(principal).not.toMatch(/matcon_deliveries/);
  });
});
