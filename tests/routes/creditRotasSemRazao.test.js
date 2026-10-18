// ============================================================
// AURA. -- tq-20 (18/10/2026): rotas de parcela sem razao DESLIGADAS
//
// Achado do t3-08 (Aura-backend#858): duas rotas sem chamador no aura-app
// mexiam em credit_installments sem mexer em customer_credit_transactions:
//   - POST  /credit/installments             criava parcela SEM debito (e com
//                                            juros lineares x n parcelas)
//   - PATCH /credit/installments/:iid/cancel cancelava parcela sem tirar a
//                                            divida do saldo
// Agora as duas respondem 410 Gone apontando o caminho certo, sem abrir
// conexao nem gravar nada. As vizinhas (GET, /pay) seguem vivas.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');

let db;
let router;

const SECRET = 'aura-test-secret-2026';
const cid  = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const cust = '11111111-2222-3333-4444-555555555555';
const iid  = '99999999-8888-7777-6666-555555555555';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '3000d' })}` };

function poolPadrao(extra) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    // crediario ligado na loja (assertCrediarioEnabled); o resto devolve vazio.
    if (/pdv_settings->>'crediario_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled: 'true' }] });
    if (extra) { const r = extra(s); if (r) return Promise.resolve(r); }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.resetModules();
  db = require('../../src/config/database');
  db.query.mockReset();
  db.connect.mockReset();
  poolPadrao();
  router = require('../../src/routes/creditInstallments');
});

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

// Nenhuma escrita: nem conexao de transacao, nem INSERT/UPDATE/DELETE pelo pool.
function semEscrita() {
  expect(db.connect).not.toHaveBeenCalled();
  const escritas = db.query.mock.calls
    .filter((c) => /\b(INSERT|UPDATE|DELETE)\b/i.test(String(c[0] || '')));
  expect(escritas).toHaveLength(0);
}

describe('POST /credit/installments -- desligada', () => {
  test('410 com o caminho certo (lancamento manual) e nada gravado', async () => {
    const res = await request(buildApp())
      .post(`/api/v1/companies/${cid}/credit/installments`).set(adminAuth)
      .send({ customer_id: cust, total_amount: 300, installments: 3 });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('ROUTE_GONE_USE_MANUAL_ENTRY');
    expect(res.body.error).toMatch(/lancamento manual/i);
    expect(res.body.error).toMatch(/\/credit\/manual-entry/);
    expect(res.body.use_instead).toEqual([{ method: 'POST', path: '/credit/manual-entry' }]);
    semEscrita();
  });

  test('corpo com juros, carne e venda tambem nao grava (era o caso do juros x n)', async () => {
    const res = await request(buildApp())
      .post(`/api/v1/companies/${cid}/credit/installments`).set(adminAuth)
      .send({ customer_id: cust, total_amount: 1000, installments: 10, sale_id: 's1', account_id: 'a1', first_due_date: '2027-01-15' });
    expect(res.status).toBe(410);
    semEscrita();
  });

  test('corpo vazio tambem e 410 (nao 400): a rota nao existe mais', async () => {
    const res = await request(buildApp())
      .post(`/api/v1/companies/${cid}/credit/installments`).set(adminAuth).send({});
    expect(res.status).toBe(410);
    semEscrita();
  });

  test('sem login continua 401 (o desligamento nao abre a rota)', async () => {
    const res = await request(buildApp())
      .post(`/api/v1/companies/${cid}/credit/installments`).send({});
    expect(res.status).toBe(401);
  });
});

describe('PATCH /credit/installments/:iid/cancel -- desligada', () => {
  test('410 com o caminho certo (desfazer lancamento) e nada gravado', async () => {
    const res = await request(buildApp())
      .patch(`/api/v1/companies/${cid}/credit/installments/${iid}/cancel`).set(adminAuth).send({});
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('ROUTE_GONE_USE_UNDO_ENTRY');
    expect(res.body.error).toMatch(/Desfazer lancamento/);
    expect(res.body.error).toMatch(/DELETE \/credit\/transaction\/:txid/);
    expect(res.body.use_instead).toEqual([{ method: 'DELETE', path: '/credit/transaction/:txid' }]);
    semEscrita();
  });
});

describe('vizinhas seguem vivas', () => {
  test('GET /credit/installments nao e 410', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.connect.mockResolvedValue(client);
    const res = await request(buildApp())
      .get(`/api/v1/companies/${cid}/credit/installments`).set(adminAuth);
    expect(res.status).not.toBe(410);
    expect(res.status).not.toBe(404);
  });

  test('PATCH /installments/:iid/pay nao e 410', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
    db.connect.mockResolvedValue(client);
    const res = await request(buildApp())
      .patch(`/api/v1/companies/${cid}/credit/installments/${iid}/pay`).set(adminAuth).send({});
    expect(res.status).not.toBe(410);
  });
});
