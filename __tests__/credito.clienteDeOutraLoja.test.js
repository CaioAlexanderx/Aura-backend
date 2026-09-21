// ============================================================
// AURA. — Crediário: cliente cadastrado em outra loja do mesmo dono
// 16/09/2026 (Davi Calçados / Mary Lucy)
//
// O cadastro é do dono (ownerScope.js): a Matriz vendeu no crediário para
// uma cliente cadastrada na Villa Branca. A dívida ficou na Matriz, mas
// receber dava 404 "Cliente nao encontrado nesta empresa" -- a conferência
// exigia customers.company_id = loja da URL -- e o app mostrava "Confira os
// dados e tente de novo".
//
// O que estes testes travam:
//   1. receber aceita cliente do mesmo dono e aplica na loja da URL
//   2. cliente que a conferência não acha (outro dono) -> 404 com code
//   3. a ficha traz group_open (saldo nas outras lojas do dono)
//   4. falha no group_open nunca derruba a ficha
//
// O SQL da conferência foi validado contra o banco de produção com a
// própria Mary Lucy (Matriz acha, Villa Branca acha, outro dono não acha).
// Mock por CONTEÚDO DO SQL.
// ============================================================

jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const mockApplyPayment = jest.fn();
jest.mock('../src/services/creditLedger', () => ({
  ...jest.requireActual('../src/services/creditLedger'),
  applyPayment: (...args) => mockApplyPayment(...args),
}));

const MATRIZ = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const VILLA  = 'ea68b4d2-f051-46b1-9ac5-b8438c6cd5fc';
const MARY   = '8fbde0b9-2ec0-4bc9-be58-f86c31465fa6';

const creditRouter = require('../src/routes/credit');
const app = express();
app.use(express.json());
app.use('/companies/:id/credit', creditRouter);

const mockClient = { query: jest.fn(), release: jest.fn() };

// `achaCliente`: o que a conferência do dono devolve.
function despachar({ achaCliente = true, groupOpen = [], groupOpenFalha = false } = {}) {
  const responder = (sql, params) => {
    const s = String(sql || '');
    if (/crediario_enabled/i.test(s)) return Promise.resolve({ rows: [{ enabled: 'true' }] });
    if (/FROM customers WHERE id/i.test(s)) {
      return Promise.resolve({
        rows: achaCliente ? [{ id: params[0], name: 'Mary Lucy', phone: null, cpf_cnpj: null, company_id: VILLA }] : [],
      });
    }
    if (/cb\.company_id <> \$2/i.test(s)) {
      if (groupOpenFalha) return Promise.reject(new Error('statement timeout'));
      return Promise.resolve({ rows: groupOpen });
    }
    if (/FROM customer_credit_balances/i.test(s)) {
      return Promise.resolve({ rows: [{ balance: '99.99', total_debited: '99.99', total_paid: '0' }] });
    }
    return Promise.resolve({ rows: [] });
  };
  db.query.mockImplementation(responder);
  mockClient.query.mockImplementation(responder);
  db.connect = jest.fn().mockResolvedValue(mockClient);
}

const conferencias = (fn) => fn.mock.calls.filter(([sql]) => /FROM customers WHERE id/i.test(String(sql)));

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  mockClient.query.mockReset();
  mockApplyPayment.mockReset();
  mockApplyPayment.mockResolvedValue({
    transaction: { id: 'tx-1' },
    covered_installments: [{ id: 'inst-1', covered: 49.99, status: 'paid' }],
    charges_detail: [],
    new_balance: 50,
    legacy_amount: 0,
  });
});

describe('POST /credit/customers/:cid/payments — cliente de outra loja do dono', () => {
  it('recebe na Matriz a dívida da cliente cadastrada na Villa Branca', async () => {
    despachar();

    const res = await request(app)
      .post(`/companies/${MATRIZ}/credit/customers/${MARY}/payments`)
      .send({ amount: 49.99, method: 'dinheiro' });

    expect(res.status).toBe(201);
    expect(res.body.new_balance).toBe(50);

    // A dívida é da loja da URL: o pagamento é aplicado na Matriz.
    expect(mockApplyPayment).toHaveBeenCalledTimes(1);
    expect(mockApplyPayment.mock.calls[0][1]).toMatchObject({ companyId: MATRIZ, customerId: MARY });

    // A conferência é pelo dono, com [cliente, loja da URL].
    const [sql, params] = conferencias(mockClient.query)[0];
    expect(sql).toMatch(/owner_id/);
    expect(params).toEqual([MARY, MATRIZ]);
  });

  it('cliente que a conferência não acha: 404 com code, sem aplicar nada', async () => {
    despachar({ achaCliente: false });

    const res = await request(app)
      .post(`/companies/${MATRIZ}/credit/customers/${MARY}/payments`)
      .send({ amount: 49.99, method: 'dinheiro' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
    expect(mockApplyPayment).not.toHaveBeenCalled();
    expect(mockClient.query.mock.calls.some(([s]) => /ROLLBACK/.test(String(s)))).toBe(true);
  });

  it('a prévia também aceita a cliente do mesmo dono', async () => {
    despachar();

    const res = await request(app)
      .get(`/companies/${MATRIZ}/credit/customers/${MARY}/payments/preview?amount=49.99`);

    expect(res.status).toBe(200);
    const [sql, params] = conferencias(db.query)[0];
    expect(sql).toMatch(/owner_id/);
    expect(params).toEqual([MARY, MATRIZ]);
  });
});

describe('GET /credit/customer/:cid — saldo nas outras lojas do dono', () => {
  it('traz group_open com nome da loja e saldo numérico', async () => {
    despachar({ groupOpen: [{ company_id: VILLA, company_name: 'Davi Calçados Villa Branca', balance: '179.99' }] });

    const res = await request(app).get(`/companies/${MATRIZ}/credit/customer/${MARY}`);

    expect(res.status).toBe(200);
    expect(res.body.group_open).toEqual([
      { company_id: VILLA, company_name: 'Davi Calçados Villa Branca', balance: 179.99 },
    ]);
    const goCall = db.query.mock.calls.find(([s]) => /cb\.company_id <> \$2/i.test(String(s)));
    expect(goCall[0]).toMatch(/owner_id/);
    expect(goCall[1]).toEqual([MARY, MATRIZ]);
  });

  it('falha no group_open não derruba a ficha', async () => {
    despachar({ groupOpenFalha: true });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get(`/companies/${MATRIZ}/credit/customer/${MARY}`);

    expect(res.status).toBe(200);
    expect(res.body.group_open).toEqual([]);
    expect(res.body.balance).toBe(99.99);
    spy.mockRestore();
  });

  it('cliente de outro dono: 404 com code', async () => {
    despachar({ achaCliente: false });

    const res = await request(app).get(`/companies/${MATRIZ}/credit/customer/${MARY}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CUSTOMER_NOT_FOUND');
  });
});
