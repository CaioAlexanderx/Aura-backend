// ============================================================
// AURA KARATÊ — Testes Integração: editar/remover uma baixa (F5)
//   PATCH  /financial/annuities/:annuityId/payments/:paymentId
//   DELETE /financial/annuities/:annuityId/payments/:paymentId
//
// recomputeAnnuityFromLedger já tem suíte própria (unit,
// tests/unit/karateAnnuityRecompute.test.js) cobrindo o rebuild FIFO a
// fundo — aqui o foco é a FIAÇÃO HTTP: guard, validação, mutação correta
// do ledger (linha vs grupo por operation_id), mapeamento de erro do
// motor -> status code, shape da resposta e auditoria. recompute é
// mockado (module mock, mantendo AnnuityPaymentError REAL). Mesmo padrão
// de tests/integration/karateAnnuityReceive.test.js.
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../src/services/karateAnnuityLedger', () => {
  const actual = jest.requireActual('../../src/services/karateAnnuityLedger');
  return { ...actual, recomputeAnnuityFromLedger: jest.fn() };
});
jest.mock('../../src/services/karateFinanceAudit', () => ({
  logFinanceAudit: jest.fn().mockResolvedValue(undefined),
  actorFromReq: jest.fn(() => ({ actorUserId: 'u1' })),
  resolveActorLabel: jest.fn(async () => 'Usuário Teste'),
  VALID_SOURCES: ['ui', 'batch', 'campaign', 'webhook', 'api'],
  VALID_TARGET_TYPES: ['annuity', 'installment'],
}));

let app, db, ledgerSvc, financeAudit;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  ledgerSvc = require('../../src/services/karateAnnuityLedger');
  financeAudit = require('../../src/services/karateFinanceAudit');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const annuityId = 'a1000000-0000-0000-0000-00000000000a';
const paymentId = 'p1000000-0000-0000-0000-00000000000p';
const base = `/api/v1/federation/${fedId}/financial/annuities/${annuityId}/payments/${paymentId}`;

const authHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client' }, SECRET, { expiresIn: '1h' })}`,
});

function mockCompanyAccess() {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
}

// Client transacional mockado — intercepta BEGIN/COMMIT/ROLLBACK, o SELECT
// de existência/lock da linha (FOR UPDATE OF p), o UPDATE/DELETE da(s)
// linha(s) de ledger. recomputeAnnuityFromLedger em si é mockado (module
// mock acima) — não precisa ser interpretado aqui.
function makeClient({ beforeRow, deletedRows } = {}) {
  const calls = { update: [], delete: [] };
  const query = jest.fn((sql, params) => {
    const text = String(sql).trim();
    if (/^BEGIN/.test(text)) return Promise.resolve({});
    if (/^COMMIT/.test(text)) return Promise.resolve({});
    if (/^ROLLBACK/.test(text)) return Promise.resolve({});
    if (/^SELECT p\.\*, h\.dojo_id/.test(text)) {
      return Promise.resolve({ rows: beforeRow ? [beforeRow] : [] });
    }
    if (/^UPDATE karate_annuity_payments/.test(text)) {
      calls.update.push({ sql: text, params });
      return Promise.resolve({ rows: [] });
    }
    if (/^DELETE FROM karate_annuity_payments/.test(text)) {
      calls.delete.push({ sql: text, params });
      return Promise.resolve({ rows: deletedRows || [] });
    }
    throw new Error('query inesperada no mock de client: ' + text);
  });
  return { query, release: jest.fn(), calls };
}

function recomputeResult(overrides = {}) {
  return {
    federation_id: fedId,
    annuity_id: annuityId,
    header: { id: annuityId, dojo_id: 'dojo-1', practitioner_id: null, status: 'paid', amount: 100, due_date: '2026-05-31', paid_at: '2026-06-01T12:00:00-03:00' },
    installments: [
      { id: 'inst-a', seq: 1, kind: 'anuidade', amount: 100, amount_paid: 100, status: 'paid', due_date: '2026-05-31', paid_at: '2026-06-01T12:00:00-03:00', payment_method: 'pix', transaction_id: 'txn-a' },
    ],
    ledger: [],
    ...overrides,
  };
}

function baseLedgerRow(overrides = {}) {
  return {
    id: paymentId,
    federation_id: fedId,
    installment_id: 'inst-a',
    annuity_id: annuityId,
    amount: 40,
    paid_at: '2026-06-01T12:00:00-03:00',
    payment_method: 'pix',
    created_by: 'u1',
    operation_id: null,
    created_at: '2026-06-01T12:00:00-03:00',
    dojo_id: 'dojo-1',
    practitioner_id: null,
    ...overrides,
  };
}

afterEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  ledgerSvc.recomputeAnnuityFromLedger.mockReset();
  financeAudit.logFinanceAudit.mockClear();
});

describe('PATCH /financial/annuities/:annuityId/payments/:paymentId', () => {
  test('sem token -> 401', async () => {
    const res = await request(app).patch(base).send({ amount: 50 });
    expect(res.status).toBe(401);
    expect(ledgerSvc.recomputeAnnuityFromLedger).not.toHaveBeenCalled();
  });

  test('payment_method inválido -> 422, nunca abre conexão', async () => {
    mockCompanyAccess();
    const res = await request(app).patch(base).set(authHeader()).send({ payment_method: 'bitcoin' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('nenhum campo -> 400', async () => {
    mockCompanyAccess();
    const res = await request(app).patch(base).set(authHeader()).send({});
    expect(res.status).toBe(400);
  });

  test('paid_at vazio explícito -> 422', async () => {
    mockCompanyAccess();
    const res = await request(app).patch(base).set(authHeader()).send({ paid_at: '' });
    expect(res.status).toBe(422);
  });

  test('amount <= 0 -> 422', async () => {
    mockCompanyAccess();
    const res = await request(app).patch(base).set(authHeader()).send({ amount: 0 });
    expect(res.status).toBe(422);
  });

  test('baixa não encontrada -> 404, ROLLBACK, recompute não chamado', async () => {
    mockCompanyAccess();
    const client = makeClient({ beforeRow: null });
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).patch(base).set(authHeader()).send({ amount: 50 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(ledgerSvc.recomputeAnnuityFromLedger).not.toHaveBeenCalled();
  });

  test('edita amount: faz UPDATE no ledger com o novo valor, chama recompute, responde header/installments e grava auditoria', async () => {
    mockCompanyAccess();
    const client = makeClient({ beforeRow: baseLedgerRow({ amount: 40, payment_method: 'pix' }) });
    db.connect.mockResolvedValueOnce(client);
    ledgerSvc.recomputeAnnuityFromLedger.mockResolvedValueOnce(recomputeResult());

    const res = await request(app).patch(base).set(authHeader()).send({ amount: 100 });

    expect(res.status).toBe(200);
    expect(res.body.payment_id).toBe(paymentId);
    expect(res.body.header.status).toBe('paid');
    expect(res.body.installments[0].status).toBe('paid');

    expect(client.calls.update).toHaveLength(1);
    expect(client.calls.update[0].sql).toMatch(/amount = \$1/);
    expect(client.calls.update[0].params[0]).toBe(100);

    const call = ledgerSvc.recomputeAnnuityFromLedger.mock.calls[0][1];
    expect(call.federation_id).toBe(fedId);
    expect(call.annuity_id).toBe(annuityId);

    expect(financeAudit.logFinanceAudit).toHaveBeenCalledTimes(1);
    const auditEntry = financeAudit.logFinanceAudit.mock.calls[0][0];
    expect(auditEntry.action).toBe('payment_edit');
    expect(auditEntry.targetType).toBe('annuity');
    expect(auditEntry.targetId).toBe(annuityId);
    expect(auditEntry.before.amount).toBe(40);
    expect(auditEntry.after.amount).toBe(100);
  });

  test('edita só paid_at/payment_method: NÃO inclui amount no SET, saldo não muda', async () => {
    mockCompanyAccess();
    const client = makeClient({ beforeRow: baseLedgerRow({ amount: 40, payment_method: 'pix' }) });
    db.connect.mockResolvedValueOnce(client);
    ledgerSvc.recomputeAnnuityFromLedger.mockResolvedValueOnce(recomputeResult({
      installments: [{ id: 'inst-a', seq: 1, kind: 'anuidade', amount: 100, amount_paid: 40, status: 'partial', due_date: '2026-05-31', paid_at: null, payment_method: 'dinheiro', transaction_id: 'txn-a' }],
    }));

    const res = await request(app).patch(base).set(authHeader()).send({ payment_method: 'dinheiro', paid_at: '2026-06-10' });

    expect(res.status).toBe(200);
    expect(client.calls.update[0].sql).not.toMatch(/amount = /);
    expect(client.calls.update[0].sql).toMatch(/paid_at = \$1::timestamptz/);
    expect(client.calls.update[0].sql).toMatch(/payment_method = \$2/);
    expect(client.calls.update[0].params).toEqual(['2026-06-10T12:00:00-03:00', 'dinheiro', paymentId]);
  });

  test('recompute recusa por saldo (AMOUNT_EXCEEDS_BALANCE) -> 422, ROLLBACK', async () => {
    mockCompanyAccess();
    const client = makeClient({ beforeRow: baseLedgerRow() });
    db.connect.mockResolvedValueOnce(client);
    const { AnnuityPaymentError } = jest.requireActual('../../src/services/karateAnnuityLedger');
    ledgerSvc.recomputeAnnuityFromLedger.mockRejectedValueOnce(
      new AnnuityPaymentError('AMOUNT_EXCEEDS_BALANCE', 'excede saldo', 422, { amount: 999, balance: 100 })
    );

    const res = await request(app).patch(base).set(authHeader()).send({ amount: 999 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('DELETE /financial/annuities/:annuityId/payments/:paymentId', () => {
  test('sem token -> 401', async () => {
    const res = await request(app).delete(base);
    expect(res.status).toBe(401);
    expect(ledgerSvc.recomputeAnnuityFromLedger).not.toHaveBeenCalled();
  });

  test('baixa não encontrada -> 404', async () => {
    mockCompanyAccess();
    const client = makeClient({ beforeRow: null });
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).delete(base).set(authHeader());
    expect(res.status).toBe(404);
    expect(ledgerSvc.recomputeAnnuityFromLedger).not.toHaveBeenCalled();
  });

  test('sem operation_id: remove só a linha (DELETE por id, não por grupo)', async () => {
    mockCompanyAccess();
    const row = baseLedgerRow({ operation_id: null });
    const client = makeClient({ beforeRow: row, deletedRows: [row] });
    db.connect.mockResolvedValueOnce(client);
    ledgerSvc.recomputeAnnuityFromLedger.mockResolvedValueOnce(recomputeResult({
      installments: [{ id: 'inst-a', seq: 1, kind: 'anuidade', amount: 100, amount_paid: 0, status: 'pending', due_date: '2026-05-31', paid_at: null, payment_method: null, transaction_id: 'txn-a' }],
    }));

    const res = await request(app).delete(base).set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.removed_group).toBe(false);
    expect(res.body.deleted).toHaveLength(1);
    expect(res.body.installments[0].status).toBe('pending');

    expect(client.calls.delete).toHaveLength(1);
    expect(client.calls.delete[0].sql).toMatch(/WHERE id = \$1/);
    expect(client.calls.delete[0].params).toEqual([paymentId]);
  });

  test('com operation_id: remove o GRUPO inteiro (mesma operation_id), não só a linha', async () => {
    mockCompanyAccess();
    const row = baseLedgerRow({ operation_id: 'op-abc' });
    const sibling = baseLedgerRow({ id: 'pay-2', installment_id: 'inst-b', amount: 20, operation_id: 'op-abc' });
    const client = makeClient({ beforeRow: row, deletedRows: [row, sibling] });
    db.connect.mockResolvedValueOnce(client);
    ledgerSvc.recomputeAnnuityFromLedger.mockResolvedValueOnce(recomputeResult({
      installments: [
        { id: 'inst-a', seq: 1, kind: 'anuidade', amount: 100, amount_paid: 0, status: 'pending', due_date: '2026-05-31', paid_at: null, payment_method: null, transaction_id: 'txn-a' },
        { id: 'inst-b', seq: 2, kind: 'anuidade', amount: 100, amount_paid: 0, status: 'pending', due_date: '2026-08-31', paid_at: null, payment_method: null, transaction_id: 'txn-b' },
      ],
    }));

    const res = await request(app).delete(base).set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.removed_group).toBe(true);
    expect(res.body.deleted).toHaveLength(2);

    expect(client.calls.delete).toHaveLength(1);
    expect(client.calls.delete[0].sql).toMatch(/operation_id = \$3/);
    expect(client.calls.delete[0].params).toEqual([annuityId, fedId, 'op-abc']);
  });

  test('remoção reabre a parcela (recompute devolve status pending) e a resposta reflete isso; auditoria gravada', async () => {
    mockCompanyAccess();
    const row = baseLedgerRow({ operation_id: null });
    const client = makeClient({ beforeRow: row, deletedRows: [row] });
    db.connect.mockResolvedValueOnce(client);
    ledgerSvc.recomputeAnnuityFromLedger.mockResolvedValueOnce(recomputeResult({
      header: { id: annuityId, dojo_id: 'dojo-1', practitioner_id: null, status: 'pending', amount: 100, due_date: '2026-05-31', paid_at: null },
      installments: [{ id: 'inst-a', seq: 1, kind: 'anuidade', amount: 100, amount_paid: 0, status: 'pending', due_date: '2026-05-31', paid_at: null, payment_method: null, transaction_id: 'txn-a' }],
    }));

    const res = await request(app).delete(base).set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.header.status).toBe('pending');
    expect(res.body.installments[0].status).toBe('pending');

    expect(financeAudit.logFinanceAudit).toHaveBeenCalledTimes(1);
    const auditEntry = financeAudit.logFinanceAudit.mock.calls[0][0];
    expect(auditEntry.action).toBe('payment_delete');
    expect(auditEntry.targetType).toBe('annuity');
    expect(auditEntry.before.removed_group).toBe(false);
    expect(auditEntry.before.removed).toHaveLength(1);
  });

  test('anuidade não encontrada durante recompute (edge de corrida) -> 404 propagado, ROLLBACK', async () => {
    mockCompanyAccess();
    const row = baseLedgerRow();
    const client = makeClient({ beforeRow: row, deletedRows: [row] });
    db.connect.mockResolvedValueOnce(client);
    const { AnnuityPaymentError } = jest.requireActual('../../src/services/karateAnnuityLedger');
    ledgerSvc.recomputeAnnuityFromLedger.mockRejectedValueOnce(
      new AnnuityPaymentError('ANNUITY_NOT_FOUND', 'Nenhuma parcela encontrada', 404)
    );

    const res = await request(app).delete(base).set(authHeader());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ANNUITY_NOT_FOUND');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
