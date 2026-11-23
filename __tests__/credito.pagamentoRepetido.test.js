// ============================================================
// AURA. — Crediário: trava contra pagamento repetido nas rotas (23/11/2026)
//
// Caso Looks Da Jenny (21/11): o mesmo recebimento entrou duas vezes na
// ficha, o segundo de outro computador com a data voltada um dia. Regra do
// Caio: pagamento com o MESMO valor e a MESMA data de pagamento para a MESMA
// cliente na MESMA loja pede confirmação antes de gravar.
//
// O que estes testes travam, nas três rotas que gravam recebimento:
//   1. achou igual e o corpo não traz confirmar_repetido -> 409
//      { code: 'PAGAMENTO_REPETIDO', data_pagamento, valor }, sem applyPayment
//      e com ROLLBACK
//   2. confirmar_repetido: true -> grava como hoje (nem procura)
//   3. sem igual -> mesma resposta de hoje
//   4. Idempotency-Key já gravada -> replay, nunca o 409
//   5. a busca usa o dia escolhido (paid_at), não o dia de hoje
//
// O SQL da busca roda contra Postgres real em
// credito.pagamentoRepetido.banco.test.js. Aqui o mock é por CONTEÚDO DO SQL.
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

const LOJA    = '3a1c2b4d-0000-4000-8000-000000000001';
const CLIENTE = '3a1c2b4d-0000-4000-8000-000000000002';

const creditRouter = require('../src/routes/credit');
const installmentsRouter = require('../src/routes/creditInstallments');
const app = express();
app.use(express.json());
app.use('/companies/:id/credit', creditRouter);
app.use('/companies/:id/credit', installmentsRouter);

const mockClient = { query: jest.fn(), release: jest.fn() };

const ehBuscaDoIgual = (s) => /type = 'payment'/.test(s) && /AT TIME ZONE 'America\/Sao_Paulo'\)::date/.test(s);
const ehBuscaDaChave = (s) => /SELECT 1 FROM customer_credit_transactions/.test(s) && /idempotency_key = \$2/.test(s);

// `igual`: a busca acha um pagamento igual. `chaveGravada`: a Idempotency-Key já existe.
function despachar({ igual = false, chaveGravada = false } = {}) {
  const responder = (sql, params) => {
    const s = String(sql || '');
    if (/crediario_enabled/i.test(s)) return Promise.resolve({ rows: [{ enabled: 'true' }] });
    if (/FROM customers WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ id: params[0], name: 'Cliente', phone: null, cpf_cnpj: null, company_id: LOJA }] });
    }
    if (ehBuscaDaChave(s)) return Promise.resolve({ rows: chaveGravada ? [{ '?column?': 1 }] : [] });
    if (ehBuscaDoIgual(s)) return Promise.resolve({ rows: igual ? [{ id: 'tx-antigo' }] : [] });
    if (/FROM credit_installments WHERE id=\$1 AND company_id=\$2 FOR UPDATE/.test(s)) {
      return Promise.resolve({ rows: [{ id: 'inst-1', customer_id: CLIENTE, amount_due: '150.00', covered_amount: '0', status: 'pending', account_id: null }] });
    }
    if (/FROM credit_installments WHERE id=\$1/.test(s)) {
      return Promise.resolve({ rows: [{ id: 'inst-1', amount_due: '150.00', covered_amount: '150.00', status: 'paid' }] });
    }
    if (/FROM customer_credit_balances/i.test(s)) return Promise.resolve({ rows: [{ balance: '0' }] });
    return Promise.resolve({ rows: [] });
  };
  db.query.mockImplementation(responder);
  mockClient.query.mockImplementation(responder);
  db.connect = jest.fn().mockResolvedValue(mockClient);
}

const buscas = () => mockClient.query.mock.calls.filter(([sql]) => ehBuscaDoIgual(String(sql)));
const rollbacks = () => mockClient.query.mock.calls.filter(([sql]) => String(sql) === 'ROLLBACK');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  mockClient.query.mockReset();
  mockApplyPayment.mockReset();
  mockApplyPayment.mockResolvedValue({
    transaction: { id: 'tx-novo', type: 'payment', amount: '150.00', payment_method: 'pix', created_at: '2026-11-21T15:00:00Z' },
    covered_installments: [{ id: 'inst-1', covered: 150, status: 'paid' }],
    settled_receivables: [],
    charges_detail: [],
    new_balance: 0,
    legacy_amount: 0,
  });
});

describe('POST /credit/customers/:cid/payments (ficha) — pagamento repetido', () => {
  const url = `/companies/${LOJA}/credit/customers/${CLIENTE}/payments`;

  it('igual no dia escolhido: 409 PAGAMENTO_REPETIDO, nada gravado', async () => {
    despachar({ igual: true });
    const res = await request(app).post(url)
      .set('Idempotency-Key', 'rfp-chave-1')
      .send({ amount: 150, method: 'pix', paid_at: '2026-11-20' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PAGAMENTO_REPETIDO', data_pagamento: '2026-11-20', valor: 150 });
    expect(typeof res.body.error).toBe('string');
    expect(mockApplyPayment).not.toHaveBeenCalled();
    expect(rollbacks().length).toBeGreaterThan(0);

    // procura pelo dia ESCOLHIDO, nesta loja, nesta cliente
    const [, params] = buscas()[0];
    expect(params).toEqual([LOJA, CLIENTE, 150, '2026-11-20']);
  });

  it('confirmar_repetido: true grava normalmente, sem procurar', async () => {
    despachar({ igual: true });
    const res = await request(app).post(url)
      .set('Idempotency-Key', 'rfp-chave-1')
      .send({ amount: 150, method: 'pix', paid_at: '2026-11-20', confirmar_repetido: true });

    expect(res.status).toBe(201);
    expect(res.body.transaction_id).toBe('tx-novo');
    expect(mockApplyPayment).toHaveBeenCalledTimes(1);
    expect(mockApplyPayment.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'rfp-chave-1', paidAt: '2026-11-20' });
    expect(buscas()).toHaveLength(0);
  });

  it('sem pagamento igual: mesma resposta de sempre', async () => {
    despachar({ igual: false });
    const res = await request(app).post(url).send({ amount: 150, method: 'pix' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ new_balance: 0, credit_generated: 0, transaction_id: 'tx-novo' });
    expect(mockApplyPayment).toHaveBeenCalledTimes(1);
    // sem paid_at: compara com hoje em Brasília
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    expect(buscas()[0][1][3]).toBe(hoje);
  });

  it('reenvio com a mesma Idempotency-Key já gravada: replay, nunca o 409', async () => {
    despachar({ igual: true, chaveGravada: true });
    const res = await request(app).post(url)
      .set('Idempotency-Key', 'rfp-chave-1')
      .send({ amount: 150, method: 'pix', paid_at: '2026-11-20' });

    expect(res.status).toBe(201);
    expect(mockApplyPayment).toHaveBeenCalledTimes(1);
    expect(buscas()).toHaveLength(0);
  });

  it('confirmar_repetido diferente de true não confirma', async () => {
    despachar({ igual: true });
    const res = await request(app).post(url).send({ amount: 150, method: 'pix', confirmar_repetido: 'sim' });
    expect(res.status).toBe(409);
    expect(mockApplyPayment).not.toHaveBeenCalled();
  });
});

describe('POST /credit/customer/:cid/payment (lista de clientes) — pagamento repetido', () => {
  const url = `/companies/${LOJA}/credit/customer/${CLIENTE}/payment`;

  it('igual hoje: 409 sem gravar', async () => {
    despachar({ igual: true });
    const res = await request(app).post(url)
      .set('Idempotency-Key', 'rp-chave-2')
      .send({ amount: 150, payment_method: 'dinheiro' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAGAMENTO_REPETIDO');
    expect(mockApplyPayment).not.toHaveBeenCalled();
  });

  it('confirmar_repetido: true grava', async () => {
    despachar({ igual: true });
    const res = await request(app).post(url)
      .send({ amount: 150, payment_method: 'dinheiro', confirmar_repetido: true });

    expect(res.status).toBe(201);
    expect(res.body.mode).toBe('global');
    expect(mockApplyPayment).toHaveBeenCalledTimes(1);
  });

  it('alocações: compara a soma e reconhece a chave da primeira alocação', async () => {
    despachar({ igual: true, chaveGravada: true });
    const res = await request(app).post(url)
      .set('Idempotency-Key', 'rp-chave-3')
      .send({ amount: 150, payment_method: 'pix', allocations: [{ account_id: 'c1', amount: 100 }, { account_id: 'c2', amount: 50 }] });

    expect(res.status).toBe(201);
    const chave = mockClient.query.mock.calls.find(([sql]) => ehBuscaDaChave(String(sql)));
    expect(chave[1]).toEqual([LOJA, 'rp-chave-3-alloc-0']);
  });

  it('alocações sem chave gravada: soma igual a um pagamento do dia -> 409', async () => {
    despachar({ igual: true });
    const res = await request(app).post(url)
      .send({ amount: 150, payment_method: 'pix', allocations: [{ account_id: 'c1', amount: 100 }, { account_id: 'c2', amount: 50 }] });

    expect(res.status).toBe(409);
    expect(buscas()[0][1][2]).toBe(150);
    expect(mockApplyPayment).not.toHaveBeenCalled();
  });
});

describe('PATCH /credit/installments/:iid/pay (parcela) — pagamento repetido', () => {
  const url = `/companies/${LOJA}/credit/installments/inst-1/pay`;

  it('igual hoje: 409 sem gravar', async () => {
    despachar({ igual: true });
    const res = await request(app).patch(url).send({ payment_method: 'pix' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PAGAMENTO_REPETIDO');
    expect(res.body.valor).toBe(150);
    expect(mockApplyPayment).not.toHaveBeenCalled();
  });

  it('confirmar_repetido: true grava', async () => {
    despachar({ igual: true });
    const res = await request(app).patch(url).send({ payment_method: 'pix', confirmar_repetido: true });

    expect(res.status).toBe(200);
    expect(mockApplyPayment).toHaveBeenCalledTimes(1);
  });

  it('sem igual: grava como sempre', async () => {
    despachar({ igual: false });
    const res = await request(app).patch(url).send({ payment_method: 'pix' });

    expect(res.status).toBe(200);
    expect(res.body.applied_to_requested).toBe(true);
  });
});
