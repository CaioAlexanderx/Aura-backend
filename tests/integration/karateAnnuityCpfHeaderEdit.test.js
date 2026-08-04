// ============================================================
// AURA KARATÊ — Testes Integração: PATCH /financial/annuities/cpf/:practitionerId/:annuityId
// (edição do HEADER da anuidade de PRATICANTE — metade "CPF" do PATCH
// .../annuities/dojos/:dojoId/:annuityId, ver tests/integration/
// karateAnnuityHeaderEdit.test.js). Praticante só tem plan='anual' (N=1),
// então este PATCH é mais enxuto (sem plan/installments[]/filiacao) —
// só amount/reference_period/due_date da parcela única.
//
// Mesmo padrão de tests/integration/karateAnnuityPaymentEdit.test.js:
// recomputeAnnuityFromLedger é mockado (module mock, mantendo
// AnnuityPaymentError REAL); só a camada client (BEGIN/SELECT/UPDATE/
// COMMIT) é simulada por um fake local que entende as queries exatas
// emitidas pela rota.
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
const practitionerId = 'c1000000-0000-0000-0000-00000000000c';
const annuityId = 'a1000000-0000-0000-0000-00000000000a';
const base = `/api/v1/federation/${fedId}/financial/annuities/cpf/${practitionerId}/${annuityId}`;

const authHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client' }, SECRET, { expiresIn: '1h' })}`,
});

function mockCompanyAccess() {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
}

afterEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  ledgerSvc.recomputeAnnuityFromLedger.mockReset();
  financeAudit.logFinanceAudit.mockClear();
});

function histRow(overrides = {}) {
  return {
    id: annuityId, practitioner_id: practitionerId, federation_id: fedId,
    reference_period: '2026', plan: 'anual', amount: 500,
    due_date: '2026-05-31', status: 'paid',
    ...overrides,
  };
}

function installmentRow(overrides = {}) {
  return {
    id: 'inst-cpf-1', annuity_id: annuityId, federation_id: fedId, seq: 1,
    kind: 'anuidade', amount: 500, amount_paid: 500, status: 'paid',
    due_date: '2026-05-31', paid_at: '2026-06-01T12:00:00-03:00',
    transaction_id: 'txn-cpf-1',
    ...overrides,
  };
}

function recomputeResult(overrides = {}) {
  return {
    federation_id: fedId,
    annuity_id: annuityId,
    header: { id: annuityId, dojo_id: null, practitioner_id: practitionerId, plan: 'anual', status: 'paid', amount: 700, reference_period: '2026', due_date: '2026-05-31', paid_at: '2026-06-01T12:00:00-03:00' },
    installments: [
      { id: 'inst-cpf-1', seq: 1, kind: 'anuidade', amount: 700, amount_paid: 500, status: 'partial', due_date: '2026-05-31', paid_at: '2026-06-01T12:00:00-03:00', payment_method: 'pix', transaction_id: 'txn-cpf-1' },
    ],
    ledger: [],
    ...overrides,
  };
}

// Client transacional mockado — intercepta BEGIN/COMMIT/ROLLBACK, o SELECT
// do header (FOR UPDATE), o SELECT de duplicidade de reference_period, o
// SELECT das parcelas (FOR UPDATE) e os UPDATEs de installment/transaction/
// header. recomputeAnnuityFromLedger em si é mockado (module mock acima).
function makeClient({ hist, installments, dupRows } = {}) {
  const calls = { updateInstallment: [], updateTransaction: [], updateHeader: [] };
  const query = jest.fn((sql, params) => {
    const text = String(sql).trim();
    if (/^BEGIN/.test(text)) return Promise.resolve({});
    if (/^COMMIT/.test(text)) return Promise.resolve({});
    if (/^ROLLBACK/.test(text)) return Promise.resolve({});
    if (/^SELECT id, practitioner_id, federation_id, reference_period, plan, amount, due_date, status/.test(text)) {
      return Promise.resolve({ rows: hist ? [hist] : [] });
    }
    if (/^SELECT id FROM karate_dojo_annuity_history\s+WHERE practitioner_id/.test(text)) {
      return Promise.resolve({ rows: dupRows || [] });
    }
    if (/^SELECT \* FROM karate_annuity_installments/.test(text)) {
      return Promise.resolve({ rows: installments || [] });
    }
    if (/^UPDATE karate_annuity_installments SET amount/.test(text)) {
      calls.updateInstallment.push({ sql: text, params });
      return Promise.resolve({ rows: [] });
    }
    if (/^UPDATE transactions SET amount/.test(text)) {
      calls.updateTransaction.push({ sql: text, params });
      return Promise.resolve({ rows: [] });
    }
    if (/^UPDATE karate_dojo_annuity_history SET reference_period/.test(text)) {
      calls.updateHeader.push({ sql: text, params });
      return Promise.resolve({ rows: [] });
    }
    throw new Error('query inesperada no mock de client: ' + text);
  });
  return { query, release: jest.fn(), calls };
}

describe('PATCH /financial/annuities/cpf/:practitionerId/:annuityId — header da anuidade CPF', () => {
  test('sem token -> 401', async () => {
    const res = await request(app).patch(base).send({ amount: 700 });
    expect(res.status).toBe(401);
    expect(ledgerSvc.recomputeAnnuityFromLedger).not.toHaveBeenCalled();
  });

  test('nenhum campo -> 400, nunca abre conexão', async () => {
    mockCompanyAccess();
    const res = await request(app).patch(base).set(authHeader()).send({});
    expect(res.status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('amount <= 0 -> 422 VALIDATION_ERROR, nunca abre conexão', async () => {
    mockCompanyAccess();
    const res = await request(app).patch(base).set(authHeader()).send({ amount: 0 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('anuidade não encontrada -> 404 (WHERE id/practitioner_id/federation_id não bate)', async () => {
    mockCompanyAccess();
    const client = makeClient({ hist: null });
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).patch(base).set(authHeader()).send({ amount: 700 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(ledgerSvc.recomputeAnnuityFromLedger).not.toHaveBeenCalled();
  });

  test('scope por practitioner_id: anuidade de OUTRO praticante -> 404 (fake client simula WHERE não bater)', async () => {
    // O fake client interpreta a query como "não encontrado" pra qualquer
    // annuityId/practitionerId — aqui simulamos exatamente o cenário em que
    // a anuidade pertence a outro practitioner_id (a query real faz
    // WHERE id=$1 AND practitioner_id=$2 AND federation_id=$3, então uma
    // anuidade de outro praticante nunca bate a linha inteira).
    mockCompanyAccess();
    const client = makeClient({ hist: null });
    db.connect.mockResolvedValueOnce(client);

    const otherPractBase = `/api/v1/federation/${fedId}/financial/annuities/cpf/other-practitioner-id/${annuityId}`;
    const res = await request(app).patch(otherPractBase).set(authHeader()).send({ amount: 700 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('reference_period duplicado -> 409 CONFLICT', async () => {
    mockCompanyAccess();
    const client = makeClient({
      hist: histRow(),
      dupRows: [{ id: 'other-annuity' }],
    });
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).patch(base).set(authHeader()).send({ reference_period: '2027' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(ledgerSvc.recomputeAnnuityFromLedger).not.toHaveBeenCalled();
  });

  test('edita amount + reference_period de anuidade JÁ PAGA: UPDATE na parcela, chama recompute, responde header/installments e grava auditoria', async () => {
    mockCompanyAccess();
    const client = makeClient({
      hist: histRow({ status: 'paid' }),
      installments: [installmentRow()],
    });
    db.connect.mockResolvedValueOnce(client);
    ledgerSvc.recomputeAnnuityFromLedger.mockResolvedValueOnce(recomputeResult());

    const res = await request(app).patch(base).set(authHeader()).send({ amount: 700, reference_period: '2027' });

    expect(res.status).toBe(200);
    expect(res.body.annuity_id).toBe(annuityId);
    expect(res.body.practitioner_id).toBe(practitionerId);
    expect(res.body.amount).toBe(700);
    expect(res.body.installments[0].status).toBe('partial');

    expect(client.calls.updateInstallment).toHaveLength(1);
    expect(client.calls.updateInstallment[0].params[0]).toBe(700);
    expect(client.calls.updateTransaction).toHaveLength(1);
    expect(client.calls.updateHeader).toHaveLength(1);
    expect(client.calls.updateHeader[0].params).toEqual(['2027', annuityId]);

    const call = ledgerSvc.recomputeAnnuityFromLedger.mock.calls[0][1];
    expect(call.federation_id).toBe(fedId);
    expect(call.annuity_id).toBe(annuityId);

    expect(financeAudit.logFinanceAudit).toHaveBeenCalledTimes(1);
    const auditEntry = financeAudit.logFinanceAudit.mock.calls[0][0];
    expect(auditEntry.action).toBe('annuity_edit');
    expect(auditEntry.practitionerId).toBe(practitionerId);
    expect(auditEntry.before.amount).toBe(500);
    expect(auditEntry.after.amount).toBe(700);
  });

  test('novo amount abaixo do já pago -> 422 AMOUNT_BELOW_PAID, ROLLBACK, recompute NUNCA chamado', async () => {
    mockCompanyAccess();
    const client = makeClient({
      hist: histRow({ status: 'paid' }),
      installments: [installmentRow({ amount: 500, amount_paid: 500 })],
    });
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app).patch(base).set(authHeader()).send({ amount: 300 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AMOUNT_BELOW_PAID');
    expect(res.body.details).toEqual({ new_total: 300, paid_total: 500 });
    expect(ledgerSvc.recomputeAnnuityFromLedger).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.calls.updateInstallment).toHaveLength(0);
  });

  test('só due_date: edita o vencimento da parcela única sem mexer no amount', async () => {
    mockCompanyAccess();
    const client = makeClient({
      hist: histRow(),
      installments: [installmentRow()],
    });
    db.connect.mockResolvedValueOnce(client);
    ledgerSvc.recomputeAnnuityFromLedger.mockResolvedValueOnce(recomputeResult({
      header: { id: annuityId, dojo_id: null, practitioner_id: practitionerId, plan: 'anual', status: 'paid', amount: 500, reference_period: '2026', due_date: '2026-08-31', paid_at: '2026-06-01T12:00:00-03:00' },
      installments: [installmentRow({ due_date: '2026-08-31' })],
    }));

    const res = await request(app).patch(base).set(authHeader()).send({ due_date: '2026-08-31' });

    expect(res.status).toBe(200);
    expect(client.calls.updateInstallment[0].params[0]).toBe(500); // amount inalterado (valor atual da parcela)
    expect(client.calls.updateInstallment[0].params[1]).toBe('2026-08-31');
  });

  test('recompute propaga erro do motor (ex.: ANNUITY_NOT_FOUND) -> status/código do erro, ROLLBACK', async () => {
    mockCompanyAccess();
    const client = makeClient({
      hist: histRow(),
      installments: [installmentRow()],
    });
    db.connect.mockResolvedValueOnce(client);
    const { AnnuityPaymentError } = jest.requireActual('../../src/services/karateAnnuityLedger');
    ledgerSvc.recomputeAnnuityFromLedger.mockRejectedValueOnce(
      new AnnuityPaymentError('ANNUITY_NOT_FOUND', 'Nenhuma parcela encontrada', 404)
    );

    const res = await request(app).patch(base).set(authHeader()).send({ amount: 700 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ANNUITY_NOT_FOUND');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
