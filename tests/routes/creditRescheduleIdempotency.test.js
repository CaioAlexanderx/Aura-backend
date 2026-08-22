// ============================================================
// AURA. -- POST /credit/customers/:cid/accounts/:aid/reschedule
//          idempotência da renegociação (21/08/2026)
//
// Relato Valen: a MESMA renegociação (54x de R$100) foi aplicada DUAS vezes,
// 33s de intervalo. O servidor aplicou e commitou nas duas — a resposta não
// chegou no app na primeira, o lojista viu o toast genérico de erro e clicou
// de novo. Cada clique cancela o carnê inteiro e recria: o cliente "mae do
// douglas" acumulou 91 parcelas canceladas.
//
// O que estes testes travam:
//   1. aplicação normal grava o recibo (com impressão digital do pedido)
//   2. clique repetido SEM Idempotency-Key, dentro da janela -> replay,
//      sem tocar em NENHUMA parcela
//   3. Idempotency-Key repetida -> replay pela chave
//   4. migration 300 pendente (42P01) -> aplica normalmente, sem proteção
//
// Mock por CONTEÚDO DO SQL (nunca fila posicional), igual tests/routes/*.
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');

let db;
let rescheduleRouter;

// A rota guarda `receiptsTableAvailable` em cache de módulo — cada teste precisa
// de um require limpo para não herdar o "tabela não existe" do vizinho. Depois
// do resetModules o mock de database é OUTRA instância: re-require nos dois.
beforeEach(() => {
  jest.resetModules();
  db = require('../../src/config/database');
  db.query.mockReset();
  db.connect.mockReset();
  rescheduleRouter = require('../../src/routes/creditReschedule');
});

const SECRET = 'aura-test-secret-2026';
const cid  = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const cust = '11111111-2222-3333-4444-555555555555';
const adminAuth = { Authorization: `Bearer ${jwt.sign({ id: 'a1', role: 'admin' }, SECRET, { expiresIn: '1h' })}` };

function buildApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/credit', rescheduleRouter);
  app.use('/api/v1/companies/:id', scoped);
  return app;
}

const RESULT_ANTERIOR = {
  open_remaining: 5400, target_total: 5400, delta: 0,
  installments_count: 54, schedule: [], adjustment: null, new_balance: 5400,
};

/**
 * @param receipt  null = nenhum recibo; objeto = recibo encontrado no replay
 * @param missing  true = tabela de recibos ainda não existe (42P01)
 */
function mockPool({ receipt = null, missing = false } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM customers WHERE id/i.test(s))            return Promise.resolve({ rows: [{ id: cust }] });
    if (/pdv_settings->>'crediario_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled: 'true' }] });
    if (/FROM credit_reschedule_receipts/i.test(s)) {
      if (missing) { const e = new Error('relation does not exist'); e.code = '42P01'; return Promise.reject(e); }
      return Promise.resolve({ rows: receipt ? [{ result: receipt }] : [] });
    }
    if (/FROM credit_plan_configs/i.test(s)) return Promise.resolve({ rows: [{ period_unit: 'month', period_count: 1 }] });
    return Promise.resolve({ rows: [] });
  });
}

function mockClient({ missing = false } = {}) {
  const query = jest.fn().mockImplementation((sql) => {
    const s = String(sql || '');
    if (/FROM credit_reschedule_receipts/i.test(s)) {
      if (missing) { const e = new Error('relation does not exist'); e.code = '42P01'; return Promise.reject(e); }
      return Promise.resolve({ rows: [] });
    }
    if (/INSERT INTO credit_reschedule_receipts/i.test(s)) {
      if (missing) { const e = new Error('relation does not exist'); e.code = '42P01'; return Promise.reject(e); }
      return Promise.resolve({ rows: [] });
    }
    // Parcelas abertas do escopo (FOR UPDATE) — 2 parcelas de R$2.700.
    if (/FROM credit_installments/i.test(s) && /FOR UPDATE/i.test(s)) {
      return Promise.resolve({ rows: [
        { id: 'inst-old-1', amount_due: '2700.00', covered_amount: '0' },
        { id: 'inst-old-2', amount_due: '2700.00', covered_amount: '0' },
      ] });
    }
    if (/INSERT INTO credit_installments/i.test(s)) return Promise.resolve({ rows: [{ id: 'inst-novo' }] });
    if (/FROM customer_credit_balances/i.test(s))   return Promise.resolve({ rows: [{ balance: '5400.00' }] });
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
}

const BODY = { total: 5400, installments: 54, first_due_date: '2026-09-20' };
const post = (app, body = BODY, headers = {}) =>
  request(app)
    .post(`/api/v1/companies/${cid}/credit/customers/${cust}/accounts/general/reschedule`)
    .set(adminAuth).set(headers).send(body);

const callsMatching = (client, re) => client.query.mock.calls.filter((c) => re.test(String(c[0] || '')));

describe('renegociação — idempotência', () => {
  test('primeira aplicação: 200, grava recibo com a impressão digital do pedido', async () => {
    mockPool();
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    const res = await post(buildApp());

    expect(res.status).toBe(200);
    expect(res.body.installments_count).toBe(54);
    expect(res.body.replayed).toBeUndefined();

    const receiptInsert = callsMatching(client, /INSERT INTO credit_reschedule_receipts/i)[0];
    expect(receiptInsert).toBeTruthy();
    // [company, customer, account(null), key, fingerprint, result]
    const fingerprint = receiptInsert[1][4];
    expect(fingerprint).toContain('5400.00');
    expect(fingerprint).toContain('2026-09-20');
    expect(receiptInsert[1][3]).toMatch(/^auto-/); // sem header -> key sintética

    // O carnê foi realmente refeito.
    expect(callsMatching(client, /INSERT INTO credit_installments/i)).toHaveLength(54);
    expect(callsMatching(client, /COMMIT/i)).toHaveLength(1);
  });

  test('clique repetido SEM Idempotency-Key: replay, sem tocar em parcela', async () => {
    mockPool({ receipt: RESULT_ANTERIOR });
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    const res = await post(buildApp());

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.installments_count).toBe(54);
    // Nem transação abriu: nenhuma parcela cancelada, nenhuma criada.
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('Idempotency-Key repetida: replay pela chave', async () => {
    mockPool({ receipt: RESULT_ANTERIOR });
    db.connect.mockResolvedValue(mockClient());

    const res = await post(buildApp(), BODY, { 'Idempotency-Key': 'rsc-abc-123' });

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    const lookup = db.query.mock.calls.find((c) => /FROM credit_reschedule_receipts/i.test(String(c[0])));
    expect(lookup[1]).toEqual([cid, 'rsc-abc-123']);
  });

  test('header presente mas chave NOVA a cada clique: a impressão digital segura', async () => {
    // O app manda `resched-...-Date.now()`: a chave nunca repete, então sozinha
    // não deduplica nada. Foi assim que a renegociação da Valen entrou 2x.
    // A busca por chave não acha; a por impressão digital acha.
    db.query.mockImplementation((sql, params) => {
      const s = String(sql || '');
      if (/FROM customers WHERE id/i.test(s))            return Promise.resolve({ rows: [{ id: cust }] });
      if (/pdv_settings->>'crediario_enabled'/i.test(s)) return Promise.resolve({ rows: [{ enabled: 'true' }] });
      if (/FROM credit_reschedule_receipts/i.test(s)) {
        const porChave = /idempotency_key = \$2/i.test(s);
        return Promise.resolve({ rows: porChave ? [] : [{ result: RESULT_ANTERIOR }] });
      }
      if (/FROM credit_plan_configs/i.test(s)) return Promise.resolve({ rows: [{ period_unit: 'month', period_count: 1 }] });
      return Promise.resolve({ rows: [] });
    });
    const client = mockClient();
    db.connect.mockResolvedValue(client);

    const res = await post(buildApp(), BODY, { 'Idempotency-Key': 'resched-' + Date.now() });

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(db.connect).not.toHaveBeenCalled(); // nenhuma parcela tocada
  });

  test('migration 300 pendente (42P01): aplica normalmente, sem proteção', async () => {
    mockPool({ missing: true });
    const client = mockClient({ missing: true });
    db.connect.mockResolvedValue(client);

    const res = await post(buildApp());

    expect(res.status).toBe(200);
    expect(res.body.installments_count).toBe(54);
    expect(callsMatching(client, /INSERT INTO credit_installments/i)).toHaveLength(54);
    expect(callsMatching(client, /COMMIT/i)).toHaveLength(1);
    // O SAVEPOINT protege a renegociação do erro da tabela ausente.
    expect(callsMatching(client, /ROLLBACK TO SAVEPOINT/i).length).toBeLessThanOrEqual(1);
  });
});
