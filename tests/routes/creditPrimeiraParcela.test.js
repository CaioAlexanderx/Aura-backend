// ============================================================
// AURA. -- Crediario: primeira parcela em janeiro (13/10/2026)
//
// Plano da temporada: vender em dezembro e a primeira parcela cair em
// janeiro. O campo `first_due_date` ja existia em POST /credit/installments
// (obrigatorio); agora e OPCIONAL, tem janela e a resposta devolve as datas.
//
// O que estes testes travam:
//   1. sem o campo: 1a parcela = hoje + 1 mes (mesmo default de manual-entry/PDV)
//   2. com o campo (janeiro): a 1a parcela e a data pedida e as demais seguem
//      mensalmente a partir dela
//   3. passado => 422 FIRST_DUE_DATE_PAST; > 90 dias => 422 FIRST_DUE_DATE_TOO_FAR;
//      formato/data impossivel => 400; hoje e hoje+90 passam (limites inclusivos)
//   4. recusa nao grava nada (nenhum INSERT, nenhum BEGIN)
//   5. dia 31 nao pula fevereiro; periodicidade semanal/dias continua igual
//   6. GET /plan-config devolve first_due_date_max_days
//
// Mock por CONTEUDO DO SQL, nunca fila posicional.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');

let db;
let router;
let nowSpy;

const SECRET = 'aura-test-secret-2026';
const cid  = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const cust = '11111111-2222-3333-4444-555555555555';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '3000d' })}` };

// "Hoje" fixo: 10/12/2026 12:00 em Brasilia (15:00Z) -- dia de venda de dezembro.
const AGORA = Date.parse('2026-12-10T15:00:00Z');

beforeEach(() => {
  jest.resetModules();
  db = require('../../src/config/database');
  db.query.mockReset();
  db.connect.mockReset();
  router = require('../../src/routes/creditInstallments');
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(AGORA);
});
afterEach(() => nowSpy.mockRestore());

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/credit', router);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}

function mockBanco({ config = {} } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/pdv_settings->>'crediario_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled: 'true' }] });
    return Promise.resolve({ rows: [] });
  });
  const query = jest.fn().mockImplementation((sql, params) => {
    const s = String(sql || '');
    if (/credit_plan_configs/i.test(s)) {
      return Promise.resolve({ rows: [{
        company_id: cid, max_installments: 500, interest_rate: 0, period_unit: 'month', period_count: 1, ...config,
      }] });
    }
    if (/customer_credit_profiles/i.test(s)) {
      return Promise.resolve({ rows: [{ status: 'active', credit_score: 700 }] });
    }
    if (/INSERT INTO credit_installments/i.test(s)) {
      // [companyId, sale_id, customer_id, numero, total, valor, vencimento, account_id]
      return Promise.resolve({ rows: [{
        id: `inst-${params[3]}`, installment_number: params[3], total_installments: params[4],
        amount_due: params[5], due_date: params[6], status: 'pending',
      }] });
    }
    return Promise.resolve({ rows: [] });
  });
  const client = { query, release: jest.fn() };
  db.connect.mockResolvedValue(client);
  return client;
}

const post = (body) => request(buildApp())
  .post(`/api/v1/companies/${cid}/credit/installments`).set(adminAuth)
  .send({ customer_id: cust, total_amount: 300, installments: 3, ...body });

const gravacoes = (client) => client.query.mock.calls
  .filter((c) => /INSERT INTO credit_installments/i.test(String(c[0] || ''))).length;
const begins = (client) => client.query.mock.calls
  .filter((c) => /^BEGIN$/i.test(String(c[0] || '').trim())).length;

describe('POST /credit/installments -- sem first_due_date (comportamento de sempre)', () => {
  test('campo omitido: 1a parcela hoje + 1 mes, demais mensais', async () => {
    const client = mockBanco();
    const res = await post({});
    expect(res.status).toBe(201);
    expect(res.body.first_due_date).toBe('2027-01-10');
    expect(res.body.due_dates).toEqual(['2027-01-10', '2027-02-10', '2027-03-10']);
    expect(gravacoes(client)).toBe(3);
  });

  test('null e string vazia contam como omitido', async () => {
    mockBanco();
    const a = await post({ first_due_date: null });
    const b = await post({ first_due_date: '' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.due_dates).toEqual(['2027-01-10', '2027-02-10', '2027-03-10']);
    expect(b.body.due_dates).toEqual(['2027-01-10', '2027-02-10', '2027-03-10']);
  });

  test('o que ja era obrigatorio continua: sem customer_id => 400', async () => {
    const client = mockBanco();
    const res = await request(buildApp())
      .post(`/api/v1/companies/${cid}/credit/installments`).set(adminAuth)
      .send({ total_amount: 100, installments: 2 });
    expect(res.status).toBe(400);
    expect(begins(client)).toBe(0);
  });
});

describe('POST /credit/installments -- primeira parcela em janeiro', () => {
  test('vende em 10/12 e a 1a parcela e 15/01; demais seguem mensalmente', async () => {
    const client = mockBanco();
    const res = await post({ first_due_date: '2027-01-15', installments: 4, total_amount: 400 });
    expect(res.status).toBe(201);
    expect(res.body.first_due_date).toBe('2027-01-15');
    expect(res.body.due_dates).toEqual(['2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15']);
    expect(res.body.installments).toHaveLength(4);
    expect(res.body.installments.map((i) => i.installment_number)).toEqual([1, 2, 3, 4]);
    expect(gravacoes(client)).toBe(4);
  });

  test('aceita data com horario: o dia vale', async () => {
    mockBanco();
    const res = await post({ first_due_date: '2027-01-15T00:00:00.000Z' });
    expect(res.status).toBe(201);
    expect(res.body.first_due_date).toBe('2027-01-15');
  });

  test('hoje e o limite de 90 dias passam (inclusivos)', async () => {
    mockBanco();
    const hoje = await post({ first_due_date: '2026-12-10' });
    const limite = await post({ first_due_date: '2027-03-10' });
    expect(hoje.status).toBe(201);
    expect(limite.status).toBe(201);
    expect(hoje.body.due_dates[0]).toBe('2026-12-10');
    expect(limite.body.due_dates[0]).toBe('2027-03-10');
  });

  test('dia 31 nao pula fevereiro nem repete marco', async () => {
    mockBanco();
    const res = await post({ first_due_date: '2027-01-31', installments: 4, total_amount: 400 });
    expect(res.status).toBe(201);
    expect(res.body.due_dates).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  });

  test('periodicidade semanal da loja segue valendo a partir da data informada', async () => {
    mockBanco({ config: { period_unit: 'week', period_count: 2 } });
    const res = await post({ first_due_date: '2027-01-05' });
    expect(res.status).toBe(201);
    expect(res.body.due_dates).toEqual(['2027-01-05', '2027-01-19', '2027-02-02']);
  });
});

describe('POST /credit/installments -- janela da primeira parcela', () => {
  test('no passado => 422 FIRST_DUE_DATE_PAST e nada e gravado', async () => {
    const client = mockBanco();
    const res = await post({ first_due_date: '2026-12-09' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FIRST_DUE_DATE_PAST');
    expect(res.body.today).toBe('2026-12-10');
    expect(begins(client)).toBe(0);
    expect(gravacoes(client)).toBe(0);
  });

  test('alem de 90 dias => 422 FIRST_DUE_DATE_TOO_FAR com o limite', async () => {
    const client = mockBanco();
    const res = await post({ first_due_date: '2027-03-11' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'FIRST_DUE_DATE_TOO_FAR', max_days: 90, max_date: '2027-03-10' });
    expect(begins(client)).toBe(0);
    expect(gravacoes(client)).toBe(0);
  });

  test.each([
    ['texto livre', 'janeiro'],
    ['dia impossivel', '2027-02-30'],
    ['formato brasileiro', '15/01/2027'],
    ['numero', 20270115],
  ])('data invalida (%s) => 400 FIRST_DUE_DATE_INVALID', async (_nome, valor) => {
    const client = mockBanco();
    const res = await post({ first_due_date: valor });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('FIRST_DUE_DATE_INVALID');
    expect(gravacoes(client)).toBe(0);
  });
});

describe('GET /credit/plan-config', () => {
  test('devolve first_due_date_max_days junto da configuracao', async () => {
    mockBanco({ config: { max_installments: 12 } });
    const res = await request(buildApp())
      .get(`/api/v1/companies/${cid}/credit/plan-config`).set(adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.first_due_date_max_days).toBe(90);
    expect(res.body.max_installments).toBe(12);
  });
});
