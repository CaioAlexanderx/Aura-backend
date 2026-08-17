// ============================================================
// AURA. -- Testes: POST /pdv/sale-com-sinal (F2 -- venda com sinal)
//
// A lojista fecha a venda recebendo parte agora e o restante numa data
// combinada. Motivador: Sheid Mania (camisas personalizadas).
//
// O que estes testes travam:
//   1. sales pelo valor CHEIO (a NFC-e sai na conclusao, nao no sinal)
//   2. sale_payments SO do sinal -> e so ele que entra no caixa hoje
//   3. saldo = total - sinal, 1x, na data combinada, com JUROS ZERO
//      (mesmo quando a empresa tem juros de crediario configurado)
//   4. cliente find-or-create: a venda nunca trava por falta de cadastro
//   5. validacao 0 < sinal < total, sem piso de sinal
//
// Router ISOLADO (private.js e de outro bloco). App abaixo replica
// requireAuth + requireCompanyAccess + mount, igual tests/routes/*.
// Mock por CONTEUDO DO SQL (mockImplementation por texto), nunca fila
// posicional -- a ordem interna das queries pode mudar sem quebrar o teste.
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
const cust = '11111111-2222-3333-4444-555555555555';
const prod = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess()); // admin bypassa o SELECT no banco
  scoped.use('/pdv', pdvRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}
const app = buildApp();

// Despacha por CONTEUDO do SQL. `over` permite sobrescrever/adicionar
// respostas caso a caso sem reescrever o dispatcher inteiro.
function mockClient({ interestRate = '0', existingCustomer = null, customerInsertFails = false } = {}) {
  const query = jest.fn().mockImplementation((sql) => {
    const s = String(sql || '');

    // --- caixa / settings ---
    if (/SELECT pdv_settings FROM companies/i.test(s)) return Promise.resolve({ rows: [{ pdv_settings: {} }] });
    if (/FROM caixa_sessoes/i.test(s)) return Promise.resolve({ rows: [] });

    // --- cliente ---
    if (/SELECT id FROM customers/i.test(s)) {
      return Promise.resolve({ rows: existingCustomer ? [{ id: existingCustomer }] : [] });
    }
    if (/INSERT INTO customers/i.test(s)) {
      if (customerInsertFails) {
        const e = new Error('duplicate key'); e.code = '23505';
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: [{ id: 'cust-novo-1' }] });
    }

    // --- produto / venda ---
    if (/FROM products p JOIN companies c/i.test(s)) {
      return Promise.resolve({ rows: [{ name: 'Camisa personalizada', cost_price: '30.00', stock_qty: '50', stock_company_id: cid }] });
    }
    if (/INSERT INTO sales/i.test(s)) {
      return Promise.resolve({ rows: [{ id: 'sale-1', total_amount: '240.00', status: 'completed' }] });
    }

    // --- crediario ---
    if (/INSERT INTO customer_credit_profiles/i.test(s)) {
      return Promise.resolve({ rows: [{ id: 'prof-1', status: 'active', credit_score: 700 }] });
    }
    if (/INSERT INTO credit_plan_configs/i.test(s)) {
      return Promise.resolve({ rows: [{ id: 'conf-1', max_installments: 12, interest_rate: interestRate }] });
    }
    if (/INSERT INTO customer_credit_transactions/i.test(s)) {
      return Promise.resolve({ rows: [{ id: 'tx-1', type: 'debit', amount: '140.00' }] });
    }
    if (/INSERT INTO credit_installments/i.test(s)) {
      return Promise.resolve({ rows: [{ id: 'inst-1' }] });
    }

    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
}

// db.query e usado SO depois do COMMIT (itens da venda + saldo do cliente).
function mockPostCommit() {
  db.query.mockImplementation((sql) => {
    if (/FROM customer_credit_balances/i.test(String(sql))) {
      return Promise.resolve({ rows: [{ balance: '140.00' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

const callsMatching = (client, re) => client.query.mock.calls.filter((c) => re.test(String(c[0] || '')));
const paramsOf = (client, re) => (callsMatching(client, re)[0] || [])[1];

const BODY = {
  items: [{ product_id: prod, quantity: 1, unit_price: 240 }],
  sinal: { method: 'pix', amount: 100 },
  saldo_due_date: '2026-08-24',
  customer_id: cust,
};
const post = (body) => request(app).post(`/api/v1/companies/${cid}/pdv/sale-com-sinal`).set(adminAuth).send(body);

describe('POST /pdv/sale-com-sinal -- desenho da venda', () => {
  test('201: venda pelo valor CHEIO, sinal no caixa, saldo 1/1 na data combinada', async () => {
    const client = mockClient({ existingCustomer: cust });
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    const res = await post(BODY);
    expect(res.status).toBe(201);

    // 1. sales pelo valor cheio -- a NFC-e sai aqui, nao no sinal
    const saleParams = paramsOf(client, /INSERT INTO sales/i);
    expect(saleParams).toContain(240);
    expect(saleParams).toContain(cust);

    // 2. sale_payments SO do sinal, na forma escolhida
    const payCalls = callsMatching(client, /INSERT INTO sale_payments/i);
    expect(payCalls).toHaveLength(1);
    expect(payCalls[0][1]).toEqual(expect.arrayContaining(['pix', 100]));

    // 3. saldo = 240 - 100, parcela 1/1 na data combinada
    const instCalls = callsMatching(client, /INSERT INTO credit_installments/i);
    expect(instCalls).toHaveLength(1);
    expect(instCalls[0][1]).toEqual(expect.arrayContaining([1, 1, 140, '2026-08-24']));

    // 4. debit do saldo no ledger
    expect(paramsOf(client, /INSERT INTO customer_credit_transactions/i)).toContain(140);

    expect(res.body.signal).toMatchObject({
      amount: 100, method: 'pix', balance: 140, balance_due_date: '2026-08-24',
    });
    expect(res.body.signal.installment).toMatchObject({ installment_number: 1, amount_due: 140 });
  });

  test('so o SINAL entra no caixa hoje -- o saldo vai como A Receber pendente', async () => {
    const client = mockClient({ existingCustomer: cust });
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    await post(BODY);

    const txCalls = callsMatching(client, /INSERT INTO transactions/i);
    const caixa = txCalls.find((c) => String(c[1]?.[4] || '').startsWith('pdv-sale-'));
    const receber = txCalls.find((c) => String(c[1]?.[4] || '').startsWith('pdv-credit-receivable-'));

    expect(caixa[1]).toContain(100);            // sinal, nao o total
    expect(caixa[0]).toMatch(/'confirmed'/);
    expect(receber[1]).toContain(140);          // saldo
    expect(receber[0]).toMatch(/'pending'/);
    expect(receber[1]).toContain('2026-08-24'); // vence na data combinada (F1)
  });

  test('venda com sinal NAO e marcada como parcelada', async () => {
    const client = mockClient({ existingCustomer: cust });
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    await post(BODY);

    const upd = callsMatching(client, /UPDATE sales/i);
    expect(upd).toHaveLength(1);
    expect(upd[0][1]).toContain(false); // is_installment
  });

  // Guarda do "juros 0%: e reserva, nao financiamento". Sem o interestRate
  // explicito no createCreditSale, o saldo herdaria os 10% da empresa e a
  // parcela sairia 154 em vez de 140.
  test('juros ZERO mesmo com juros de crediario configurado na empresa', async () => {
    const client = mockClient({ existingCustomer: cust, interestRate: '0.10' });
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    await post(BODY);

    const instParams = paramsOf(client, /INSERT INTO credit_installments/i);
    expect(instParams).toContain(140);
    expect(instParams).not.toContain(154);

    const snapshot = JSON.parse(paramsOf(client, /UPDATE sales/i)[2]);
    expect(snapshot.interest_rate).toBe(0);
  });
});

describe('POST /pdv/sale-com-sinal -- cliente', () => {
  test('sem customer_id: cria o cliente na hora e usa na venda', async () => {
    const client = mockClient({ existingCustomer: null });
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    const res = await post({
      ...BODY,
      customer_id: undefined,
      customer: { name: 'Maria Sheid', phone: '11988887777' },
    });

    expect(res.status).toBe(201);
    const insParams = paramsOf(client, /INSERT INTO customers/i);
    expect(insParams).toEqual(expect.arrayContaining([cid, 'Maria Sheid', '11988887777']));
    // o cliente recem-criado e o dono da venda e do saldo
    expect(paramsOf(client, /INSERT INTO sales/i)).toContain('cust-novo-1');
    expect(res.body.signal.customer_id).toBe('cust-novo-1');
  });

  test('cliente ja existente (mesmo telefone): reusa, nao duplica cadastro', async () => {
    const client = mockClient({ existingCustomer: 'cust-existente-9' });
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    const res = await post({
      ...BODY,
      customer_id: undefined,
      customer: { name: 'Maria Sheid', phone: '11988887777' },
    });

    expect(res.status).toBe(201);
    expect(callsMatching(client, /INSERT INTO customers/i)).toHaveLength(0);
    expect(paramsOf(client, /INSERT INTO sales/i)).toContain('cust-existente-9');
  });

  test('conflito de CPF no INSERT: cai no cadastro existente em vez de estourar', async () => {
    // Primeira busca nao acha (cadastro sem telefone), o INSERT bate no unique
    // de CPF e a re-busca encontra. Mesmo fallback do /credit/quick-customer.
    let findCalls = 0;
    const client = mockClient({ customerInsertFails: true });
    client.query.mockImplementation(((orig) => (sql) => {
      const s = String(sql || '');
      if (/SELECT id FROM customers/i.test(s)) {
        findCalls++;
        return Promise.resolve({ rows: findCalls === 1 ? [] : [{ id: 'cust-do-cpf' }] });
      }
      return orig(sql);
    })(client.query.getMockImplementation()));
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    const res = await post({
      ...BODY,
      customer_id: undefined,
      customer: { name: 'Maria Sheid', cpf_cnpj: '12345678901' },
    });

    expect(res.status).toBe(201);
    expect(paramsOf(client, /INSERT INTO sales/i)).toContain('cust-do-cpf');
  });

  test('422 quando nao ha NENHUM identificador do cliente', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    const res = await post({ ...BODY, customer_id: undefined, customer: {} });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SINAL_REQUIRES_CUSTOMER');
    expect(callsMatching(client, /INSERT INTO sales/i)).toHaveLength(0);
  });

  test('404 quando o customer_id nao e da empresa', async () => {
    const client = mockClient({ existingCustomer: null });
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    const res = await post(BODY);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
    expect(callsMatching(client, /INSERT INTO sales/i)).toHaveLength(0);
  });
});

describe('POST /pdv/sale-com-sinal -- validacao', () => {
  test('422 quando o sinal cobre o total inteiro (nao sobra saldo)', async () => {
    const client = mockClient({ existingCustomer: cust });
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    const res = await post({ ...BODY, sinal: { method: 'pix', amount: 240 } });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SINAL_INVALIDO');
    expect(res.body.total_amount).toBe(240);
    expect(callsMatching(client, /INSERT INTO credit_installments/i)).toHaveLength(0);
  });

  test('422 quando o sinal e zero ou negativo', async () => {
    const res = await post({ ...BODY, sinal: { method: 'pix', amount: 0 } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SINAL_INVALIDO');
  });

  // Sem piso de sinal (decisao de produto): R$ 0,01 num total de 240 passa.
  test('sinal minusculo passa -- nao ha piso de sinal', async () => {
    const client = mockClient({ existingCustomer: cust });
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    const res = await post({ ...BODY, sinal: { method: 'dinheiro', amount: 0.01 } });

    expect(res.status).toBe(201);
    expect(paramsOf(client, /INSERT INTO credit_installments/i)).toContain(239.99);
  });

  test('422 em forma de pagamento invalida no sinal (crediario nao e sinal)', async () => {
    const res = await post({ ...BODY, sinal: { method: 'crediario', amount: 100 } });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SINAL_METHOD_INVALIDO');
  });

  test('422 em data de vencimento ausente ou malformada', async () => {
    for (const d of [undefined, '', '24/08/2026', '2026-13-40']) {
      const res = await post({ ...BODY, saldo_due_date: d });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SALDO_DUE_DATE_INVALIDA');
    }
  });

  test('401 sem token', async () => {
    const res = await request(app).post(`/api/v1/companies/${cid}/pdv/sale-com-sinal`).send(BODY);
    expect(res.status).toBe(401);
  });
});

// A extracao do POST /sale em handleSale nao pode ter mudado a venda comum.
describe('POST /pdv/sale -- regressao apos a extracao do handler', () => {
  test('venda a vista continua sem parcela e sem crediario', async () => {
    const client = mockClient({ existingCustomer: cust });
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`).set(adminAuth)
      .send({ items: [{ product_id: prod, quantity: 1, unit_price: 240 }], payment_method: 'dinheiro' });

    expect(res.status).toBe(201);
    expect(callsMatching(client, /INSERT INTO credit_installments/i)).toHaveLength(0);
    expect(callsMatching(client, /INSERT INTO customer_credit_transactions/i)).toHaveLength(0);
    expect(paramsOf(client, /INSERT INTO sale_payments/i)).toEqual(expect.arrayContaining(['dinheiro', 240]));
  });

  test('crediario sem cliente continua 422 CREDIARIO_REQUIRES_CUSTOMER', async () => {
    const client = mockClient();
    db.connect.mockResolvedValue(client);
    mockPostCommit();

    const res = await request(app)
      .post(`/api/v1/companies/${cid}/pdv/sale`).set(adminAuth)
      .send({ items: [{ product_id: prod, quantity: 1, unit_price: 240 }], payment_method: 'crediario' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CREDIARIO_REQUIRES_CUSTOMER');
  });
});
