// ============================================================
// AURA. -- Testes: taxa da maquininha (Configuracoes > PDV)
//
// Ligado o toggle, toda venda no cartao gera a despesa sozinha.
//
// O que estes testes travam:
//   1. credito ('cartao') e debito com aliquotas SEPARADAS
//   2. receita bruta INTACTA -- a taxa e despesa separada, nunca abatimento
//   3. lancada na COMPETENCIA da venda, status 'confirmed'
//   4. dinheiro / Pix / crediario NAO geram taxa
//   5. toggle desligado ou aliquota zero => nenhuma despesa
//   6. cancelar a venda leva a despesa junto (senao fica custo orfao)
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const pdvRouter = require('../../src/routes/pdv');

let db;
beforeAll(() => { db = require('../../src/config/database'); });
beforeEach(() => jest.resetAllMocks());

const SECRET = 'aura-test-secret-2026';
const cid  = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const prod = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/pdv', pdvRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();

const FEE_ON = { card_fee_enabled: true, card_fee_credit_pct: 3.5, card_fee_debit_pct: 1.5 };

function mockClient(pdvSettings = FEE_ON) {
  const query = jest.fn().mockImplementation((sql) => {
    const s = String(sql || '');
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: pdvSettings }] });
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM products p JOIN companies c/i.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Camisa', cost_price: '30.00', stock_qty: '50', stock_company_id: cid }] });
    }
    if (/INSERT INTO sales/i.test(s)) return Promise.resolve({ rows: [{ id: 'sale-1', total_amount: '200.00' }] });
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
}

const callsMatching = (client, re) => client.query.mock.calls.filter((c) => re.test(String(c[0] || '')));
// A despesa da taxa: INSERT em transactions cuja idempotency_key ($5) e a nossa.
const feeCall = (client) =>
  callsMatching(client, /INSERT INTO transactions/i)
    .find((c) => String(c[1]?.[4] || '').startsWith('pdv-card-fee-'));
const saleTxCall = (client) =>
  callsMatching(client, /INSERT INTO transactions/i)
    .find((c) => String(c[1]?.[4] || '').startsWith('pdv-sale-'));

const sell = (body) => request(app)
  .post(`/api/v1/companies/${cid}/pdv/sale`).set(adminAuth)
  .send({ items: [{ product_id: prod, quantity: 1, unit_price: 200 }], ...body });

describe('taxa da maquininha -- calculo', () => {
  test('credito: 3,5% sobre a venda no cartao', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    const res = await sell({ payment_method: 'cartao' });
    expect(res.status).toBe(201);

    const fee = feeCall(client);
    expect(fee[1][1]).toBe(7);                       // 200 * 3,5%
    expect(fee[1][4]).toBe('pdv-card-fee-sale-1');
    expect(fee[0]).toMatch(/'expense'/);
    expect(fee[0]).toMatch(/'confirmed'/);           // competencia, nao repasse
    expect(fee[0]).toMatch(/Taxas de cartão/);
    expect(res.body.card_fee).toMatchObject({ fee: 7, credit_pct: 3.5 });
  });

  test('debito usa a aliquota PROPRIA, nao a de credito', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    await sell({ payment_method: 'debito' });

    expect(feeCall(client)[1][1]).toBe(3);           // 200 * 1,5%, nao 7
  });

  test('venda dividida: cada forma na sua aliquota, numa despesa so', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    await sell({ payments: [
      { method: 'cartao',   value: 100 },
      { method: 'debito',   value: 60  },
      { method: 'dinheiro', value: 40  },
    ] });

    const fees = callsMatching(client, /INSERT INTO transactions/i)
      .filter((c) => String(c[1]?.[4] || '').startsWith('pdv-card-fee-'));
    expect(fees).toHaveLength(1);
    // 100 * 3,5% + 60 * 1,5% = 3,50 + 0,90 = 4,40. Os 40 em dinheiro ficam fora.
    expect(fees[0][1][1]).toBe(4.4);
    expect(fees[0][1][2]).toMatch(/credito.*3\.5%.*debito.*1\.5%/);
  });

  test('a receita bruta fica INTACTA -- a taxa nao abate a venda', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    await sell({ payment_method: 'cartao' });

    expect(saleTxCall(client)[1][1]).toBe(200);      // receita cheia, nao 193
    expect(saleTxCall(client)[0]).toMatch(/'income'/);
    expect(feeCall(client)[1][1]).toBe(7);           // despesa separada
  });
});

describe('taxa da maquininha -- quando NAO lanca', () => {
  test.each(['dinheiro', 'pix'])('%s nao gera taxa', async (method) => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    await sell({ payment_method: method });

    expect(feeCall(client)).toBeUndefined();
  });

  test('crediario nao gera taxa', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    await sell({ payment_method: 'crediario', customer_id: '11111111-2222-3333-4444-555555555555' });

    expect(feeCall(client)).toBeUndefined();
  });

  test('toggle desligado: nenhuma despesa mesmo com aliquota preenchida', async () => {
    const client = mockClient({ card_fee_enabled: false, card_fee_credit_pct: 3.5 });
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    const res = await sell({ payment_method: 'cartao' });

    expect(feeCall(client)).toBeUndefined();
    expect(res.body.card_fee).toBeNull();
  });

  test('toggle ligado com aliquota zero: nenhuma despesa de R$ 0,00', async () => {
    const client = mockClient({ card_fee_enabled: true, card_fee_credit_pct: 0, card_fee_debit_pct: 0 });
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    await sell({ payment_method: 'cartao' });

    expect(feeCall(client)).toBeUndefined();
  });

  test('pdv_settings ausente nao derruba a venda', async () => {
    const client = mockClient(null);
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    const res = await sell({ payment_method: 'cartao' });

    expect(res.status).toBe(201);
    expect(feeCall(client)).toBeUndefined();
  });
});

// Sem isso, cancelar a venda deixa a despesa de pe: a receita some e o custo
// fica. E o bug que o cancelamento por idempotency_key, uma a uma, provoca.
describe('cancelamento leva a taxa junto', () => {
  test('DELETE /sale apaga pdv-sale-<id> E pdv-card-fee-<id>', async () => {
    const client = mockClient();
    client.query.mockImplementation((sql) => {
      const s = String(sql || '');
      if (/SELECT id, customer_id, employee_id/i.test(s)) {
        return Promise.resolve({ rows: [{ id: 'sale-1', total_amount: '200.00', status: 'completed' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .delete(`/api/v1/companies/${cid}/pdv/sale/sale-1`).set(adminAuth);
    expect(res.status).toBe(200);

    const del = callsMatching(client, /DELETE FROM transactions/i);
    const keys = del.flatMap((c) => (Array.isArray(c[1]?.[0]) ? c[1][0] : [c[1]?.[0]]));
    expect(keys).toContain('pdv-sale-sale-1');
    expect(keys).toContain('pdv-card-fee-sale-1');
  });
});
