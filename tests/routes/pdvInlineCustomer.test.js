// ============================================================
// AURA. -- F5: cliente da venda vai no campo do CLIENTE
//
// O PDV do Studio mandava o nome do cliente em `seller_name` -- o campo do
// VENDEDOR -- e nunca vinculava customer_id. Na tela de Vendas isso vira
// "Consumidor" no titulo e o nome do cliente na posicao de quem vendeu.
// E o cliente nunca passa a existir no cadastro.
//
// Agora POST /pdv/sale aceita `customer` inline e resolve (ou cria) dentro
// da propria transacao da venda.
//
// O que estes testes travam:
//   1. venda comum com `customer` inline grava customer_id
//   2. cliente existente e REUSADO, nao duplicado
//   3. cliente continua OPCIONAL na venda comum -- sem nada, segue sem 422
//      (regra antiga do PDV do Negocio: cliente nunca foi obrigatorio)
//   4. na venda com sinal, ausencia de cliente continua 422 -- o saldo e de
//      alguem
//   5. customer_id explicito continua mandando
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

function mockClient({ existingCustomer = null } = {}) {
  const query = jest.fn().mockImplementation((sql) => {
    const s = String(sql || '');
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: {} }] });
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });
    if (/SELECT id FROM customers/i.test(s)) {
      return Promise.resolve({ rows: existingCustomer ? [{ id: existingCustomer }] : [] });
    }
    if (/INSERT INTO customers/i.test(s)) return Promise.resolve({ rows: [{ id: 'cust-novo' }] });
    if (/FROM products p JOIN companies c/i.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Camisa', cost_price: '30.00', stock_qty: '50', stock_company_id: cid }] });
    }
    if (/INSERT INTO sales/i.test(s)) return Promise.resolve({ rows: [{ id: 'sale-1', total_amount: '240.00' }] });
    if (/INSERT INTO customer_credit_profiles/i.test(s)) {
      return Promise.resolve({ rows: [{ id: 'p1', status: 'active', credit_score: 700 }] });
    }
    if (/INSERT INTO credit_plan_configs/i.test(s)) {
      return Promise.resolve({ rows: [{ id: 'c1', max_installments: 12, interest_rate: '0' }] });
    }
    if (/INSERT INTO customer_credit_transactions/i.test(s)) return Promise.resolve({ rows: [{ id: 'tx' }] });
    if (/INSERT INTO credit_installments/i.test(s)) return Promise.resolve({ rows: [{ id: 'inst' }] });
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
}

const callsMatching = (client, re) => client.query.mock.calls.filter((c) => re.test(String(c[0] || '')));
const saleParams = (client) => (callsMatching(client, /INSERT INTO sales/i)[0] || [])[1];

const ITEMS = [{ product_id: prod, quantity: 1, unit_price: 240 }];
const sell = (body) => request(app).post(`/api/v1/companies/${cid}/pdv/sale`).set(adminAuth).send({ items: ITEMS, ...body });

describe('POST /pdv/sale — cliente inline (F5)', () => {
  test('cria o cliente e grava o customer_id na venda', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    const res = await sell({
      payment_method: 'pix',
      customer: { name: 'Maria Sheid', phone: '11988887777' },
    });

    expect(res.status).toBe(201);
    expect(callsMatching(client, /INSERT INTO customers/i)).toHaveLength(1);
    // customer_id é o 2º parâmetro do INSERT INTO sales
    expect(saleParams(client)[1]).toBe('cust-novo');
  });

  test('cliente já cadastrado é reusado, não duplicado', async () => {
    const client = mockClient({ existingCustomer: 'cust-antigo' });
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    await sell({ payment_method: 'pix', customer: { name: 'Maria', phone: '11988887777' } });

    expect(callsMatching(client, /INSERT INTO customers/i)).toHaveLength(0);
    expect(saleParams(client)[1]).toBe('cust-antigo');
  });

  test('customer_id explícito continua mandando, sem criar nada', async () => {
    const client = mockClient({ existingCustomer: 'cust-x' });
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    await sell({ payment_method: 'pix', customer_id: 'cust-x', customer: { name: 'Ignorado' } });

    expect(callsMatching(client, /INSERT INTO customers/i)).toHaveLength(0);
    expect(saleParams(client)[1]).toBe('cust-x');
  });

  // Guarda do PDV do Negócio: cliente nunca foi obrigatório na venda comum.
  // Se isto quebrar, toda venda anônima passou a exigir cadastro.
  test('venda SEM cliente continua passando, sem 422', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    const res = await sell({ payment_method: 'dinheiro' });

    expect(res.status).toBe(201);
    expect(callsMatching(client, /INSERT INTO customers/i)).toHaveLength(0);
    expect(saleParams(client)[1]).toBeNull();
  });

  test('objeto customer vazio não cria cadastro nem derruba a venda', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    const res = await sell({ payment_method: 'dinheiro', customer: {} });

    expect(res.status).toBe(201);
    expect(callsMatching(client, /INSERT INTO customers/i)).toHaveLength(0);
    expect(saleParams(client)[1]).toBeNull();
  });

  // Na venda com sinal o saldo é de ALGUÉM — ali a exigência continua.
  test('venda com sinal sem cliente continua 422', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale-com-sinal`).set(adminAuth)
      .send({ items: ITEMS, sinal: { method: 'pix', amount: 100 }, saldo_due_date: '2026-08-24', customer: {} });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SINAL_REQUIRES_CUSTOMER');
  });

  // seller_name é do VENDEDOR. Continua existindo e sendo gravado — o que
  // muda é que o nome do CLIENTE deixa de ser enfiado nele.
  test('seller_name segue funcionando pra quem realmente vendeu', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    db.query.mockResolvedValue({ rows: [] });

    await sell({
      payment_method: 'pix',
      seller_name: 'Joana (vendedora)',
      customer: { name: 'Maria Sheid' },
    });

    const p = saleParams(client);
    expect(p[1]).toBe('cust-novo');           // cliente
    expect(p).toContain('Joana (vendedora)'); // vendedora, no campo dela
  });
});
