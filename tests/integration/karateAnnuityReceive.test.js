// ============================================================
// AURA KARATÊ — Testes Integração: F3 da reforma da anuidade
// Rotas HTTP canônicas sobre o motor F1 (applyAnnuityPayment):
//   POST /financial/annuities/:annuityId/receive/preview (dry-run)
//   POST /financial/annuities/:annuityId/receive          (commit)
//   GET  /financial/annuities/:annuityId/payments          (extrato)
//
// applyAnnuityPayment (karateAnnuityLedger.js) já tem suíte própria
// (tests/unit/karateAnnuityLedger.test.js) cobrindo FIFO/parcial/exato/
// transbordo/excedente/dedup a fundo — aqui o foco é a FIAÇÃO HTTP: guard,
// validação de payment_method, mapeamento de erro -> status code, shape
// da resposta, e a query do extrato. applyAnnuityPayment é mockado (module
// mock, mantendo AnnuityPaymentError REAL para os testes de mapeamento de
// erro via instanceof funcionarem). financeAudit também é mockado —
// best-effort, roda em conexão própria do pool, não é o que este arquivo
// testa.
//
// Padrão karateFederationDashboard.test.js: db.query.mockReset() em
// afterEach; role de acesso é SEMPRE o 1º db.query da cadeia
// (requireCompanyAccess).
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../src/services/karateAnnuityLedger', () => {
  const actual = jest.requireActual('../../src/services/karateAnnuityLedger');
  return { ...actual, applyAnnuityPayment: jest.fn() };
});
jest.mock('../../src/services/karateFinanceAudit', () => ({
  logFinanceAudit: jest.fn().mockResolvedValue(undefined),
  actorFromReq: jest.fn(() => ({ actorUserId: 'u1' })),
  resolveActorLabel: jest.fn(async () => 'Usuário Teste'),
  VALID_SOURCES: ['ui', 'batch', 'campaign', 'webhook', 'api'],
  VALID_TARGET_TYPES: ['annuity', 'installment'],
}));

let app, db, ledgerSvc;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  ledgerSvc = require('../../src/services/karateAnnuityLedger');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const annuityId = 'a1000000-0000-0000-0000-00000000000a';
const base = `/api/v1/federation/${fedId}/financial/annuities/${annuityId}`;

const authHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client' }, SECRET, { expiresIn: '1h' })}`,
});

function mockCompanyAccess() {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
}

afterEach(() => {
  db.query.mockReset();
  ledgerSvc.applyAnnuityPayment.mockReset();
});

function commitResult(overrides = {}) {
  return {
    dry_run: false,
    federation_id: fedId,
    annuity_id: annuityId,
    installment_id: null,
    amount: 40,
    payment_method: 'pix',
    paid_at: '2026-07-10T15:00:00.000Z',
    operation_id: null,
    allocations: [{
      installment_id: 'inst-1', annuity_id: annuityId, seq: 1, kind: 'anuidade',
      due_date: '2026-05-31', amount_due: 100, amount_paid_before: 0, amount_applied: 40,
      amount_paid_after: 40, balance_after: 60, status_before: 'pending', status_after: 'partial',
      closes_installment: false,
    }],
    total_applied: 40,
    remaining_unapplied: 0,
    balance_before: 100,
    balance_after: 60,
    header: { id: annuityId, dojo_id: 'dojo-1', practitioner_id: null, status: 'pending' },
    idempotent_hit: false,
    ...overrides,
  };
}

describe('POST /financial/annuities/:annuityId/receive — baixa livre (commit)', () => {
  test('sem token -> 401', async () => {
    const res = await request(app).post(`${base}/receive`).send({ amount: 40 });
    expect(res.status).toBe(401);
    expect(ledgerSvc.applyAnnuityPayment).not.toHaveBeenCalled();
  });

  test('payment_method inválido -> 422, nunca chama o motor', async () => {
    mockCompanyAccess();
    const res = await request(app)
      .post(`${base}/receive`)
      .set(authHeader())
      .send({ amount: 40, payment_method: 'bitcoin' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(ledgerSvc.applyAnnuityPayment).not.toHaveBeenCalled();
  });

  test('baixa PARCIAL: repassa amount/payment_method/paid_at pro motor e devolve o shape dele', async () => {
    mockCompanyAccess();
    ledgerSvc.applyAnnuityPayment.mockResolvedValueOnce(commitResult());

    const res = await request(app)
      .post(`${base}/receive`)
      .set(authHeader())
      .send({ amount: 40, payment_method: 'pix', paid_at: '2026-07-10' });

    expect(res.status).toBe(200);
    expect(res.body.idempotent_hit).toBe(false);
    expect(res.body.allocations).toHaveLength(1);
    expect(res.body.allocations[0].status_after).toBe('partial');
    expect(res.body.balance_after).toBe(60);

    const call = ledgerSvc.applyAnnuityPayment.mock.calls[0][0];
    expect(call.federation_id).toBe(fedId);
    expect(call.annuity_id).toBe(annuityId);
    expect(call.amount).toBe(40);
    expect(call.payment_method).toBe('pix');
    expect(call.dryRun).toBe(false);
    // paid_at 'YYYY-MM-DD' vira meio-dia BRT (CLAUDE.md armadilha #1 — nunca
    // meia-noite UTC crua, que viraria o dia anterior em BRT).
    expect(call.paid_at).toBe('2026-07-10T12:00:00-03:00');
  });

  test('baixa EXATA: fecha a parcela (closes_installment/status_after=paid) passa direto', async () => {
    mockCompanyAccess();
    ledgerSvc.applyAnnuityPayment.mockResolvedValueOnce(commitResult({
      amount: 100,
      allocations: [{
        installment_id: 'inst-1', annuity_id: annuityId, seq: 1, kind: 'anuidade',
        due_date: '2026-05-31', amount_due: 100, amount_paid_before: 0, amount_applied: 100,
        amount_paid_after: 100, balance_after: 0, status_before: 'pending', status_after: 'paid',
        closes_installment: true,
      }],
      balance_after: 0,
    }));

    const res = await request(app).post(`${base}/receive`).set(authHeader()).send({ amount: 100 });

    expect(res.status).toBe(200);
    expect(res.body.allocations[0].status_after).toBe('paid');
    expect(res.body.allocations[0].closes_installment).toBe(true);
    expect(res.body.balance_after).toBe(0);
  });

  test('EXCEDENTE (transborda o saldo) -> 422 AMOUNT_EXCEEDS_BALANCE, corpo com o code do motor', async () => {
    mockCompanyAccess();
    const { AnnuityPaymentError } = jest.requireActual('../../src/services/karateAnnuityLedger');
    ledgerSvc.applyAnnuityPayment.mockRejectedValueOnce(
      new AnnuityPaymentError('AMOUNT_EXCEEDS_BALANCE', 'Valor informado excede o saldo em aberto', 422, { amount: 999, balance: 100 })
    );

    const res = await request(app).post(`${base}/receive`).set(authHeader()).send({ amount: 999 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    expect(res.body.details).toEqual({ amount: 999, balance: 100 });
  });

  test('anuidade inexistente -> 404 ANNUITY_NOT_FOUND', async () => {
    mockCompanyAccess();
    const { AnnuityPaymentError } = jest.requireActual('../../src/services/karateAnnuityLedger');
    ledgerSvc.applyAnnuityPayment.mockRejectedValueOnce(
      new AnnuityPaymentError('ANNUITY_NOT_FOUND', 'Nenhuma parcela encontrada', 404)
    );

    const res = await request(app).post(`${base}/receive`).set(authHeader()).send({ amount: 40 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ANNUITY_NOT_FOUND');
  });

  test('operation_id: repassado pro motor; retry (idempotent_hit:true do motor) passa direto na resposta', async () => {
    mockCompanyAccess();
    ledgerSvc.applyAnnuityPayment.mockResolvedValueOnce(commitResult({ operation_id: 'op-abc', idempotent_hit: true }));

    const res = await request(app)
      .post(`${base}/receive`)
      .set(authHeader())
      .send({ amount: 40, operation_id: 'op-abc' });

    expect(res.status).toBe(200);
    expect(res.body.idempotent_hit).toBe(true);
    expect(res.body.operation_id).toBe('op-abc');
    expect(ledgerSvc.applyAnnuityPayment.mock.calls[0][0].operation_id).toBe('op-abc');
  });

  test('CONFLICT de operation_id (annuity_id/amount não batem com a chave já usada) -> 409', async () => {
    mockCompanyAccess();
    const { AnnuityPaymentError } = jest.requireActual('../../src/services/karateAnnuityLedger');
    ledgerSvc.applyAnnuityPayment.mockRejectedValueOnce(
      new AnnuityPaymentError('OPERATION_ID_CONFLICT', 'operation_id já usado para uma baixa diferente', 409)
    );

    const res = await request(app)
      .post(`${base}/receive`)
      .set(authHeader())
      .send({ amount: 40, operation_id: 'op-reused' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OPERATION_ID_CONFLICT');
  });
});

describe('POST /financial/annuities/:annuityId/receive/preview — dry-run', () => {
  test('preview chama o motor com dryRun:true e NUNCA grava (mesmo shape do commit)', async () => {
    mockCompanyAccess();
    const dry = commitResult({ dry_run: true, idempotent_hit: false });
    delete dry.header;
    ledgerSvc.applyAnnuityPayment.mockResolvedValueOnce({ ...dry, header: null });

    const res = await request(app)
      .post(`${base}/receive/preview`)
      .set(authHeader())
      .send({ amount: 40, payment_method: 'pix' });

    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.allocations).toHaveLength(1);
    // mesmo shape de campos que o commit (allocations/balance_before/balance_after/total_applied)
    expect(Object.keys(res.body).sort()).toEqual(
      expect.arrayContaining(['allocations', 'balance_after', 'balance_before', 'total_applied'])
    );
    expect(ledgerSvc.applyAnnuityPayment.mock.calls[0][0].dryRun).toBe(true);
  });

  test('preview com payment_method inválido -> 422 sem chamar o motor', async () => {
    mockCompanyAccess();
    const res = await request(app)
      .post(`${base}/receive/preview`)
      .set(authHeader())
      .send({ amount: 40, payment_method: 'boleto-fantasia' });

    expect(res.status).toBe(422);
    expect(ledgerSvc.applyAnnuityPayment).not.toHaveBeenCalled();
  });

  test('preview propaga AMOUNT_EXCEEDS_BALANCE igual ao commit (422)', async () => {
    mockCompanyAccess();
    const { AnnuityPaymentError } = jest.requireActual('../../src/services/karateAnnuityLedger');
    ledgerSvc.applyAnnuityPayment.mockRejectedValueOnce(
      new AnnuityPaymentError('AMOUNT_EXCEEDS_BALANCE', 'excede saldo', 422, { amount: 500, balance: 40 })
    );

    const res = await request(app).post(`${base}/receive/preview`).set(authHeader()).send({ amount: 500 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AMOUNT_EXCEEDS_BALANCE');
  });
});

describe('GET /financial/annuities/:annuityId/payments — extrato', () => {
  test('anuidade inexistente/fora da federação -> 404', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({ rows: [] }); // header SELECT

    const res = await request(app).get(`${base}/payments`).set(authHeader());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('lista ordenada por paid_at DESC (mais recente primeiro), valores numéricos', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({ rows: [{ id: annuityId, dojo_id: 'dojo-1', practitioner_id: null }] }); // header
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'pay-2', installment_id: 'inst-1', annuity_id: annuityId, amount: '40.00',
          paid_at: new Date('2026-07-15T12:00:00.000Z'), payment_method: 'pix', created_by: 'u1',
          operation_id: null, created_at: new Date('2026-07-15T12:00:01.000Z'), seq: 1, kind: 'anuidade',
        },
        {
          id: 'pay-1', installment_id: 'inst-1', annuity_id: annuityId, amount: '60.00',
          paid_at: new Date('2026-05-01T12:00:00.000Z'), payment_method: 'dinheiro', created_by: 'u1',
          operation_id: 'op-1', created_at: new Date('2026-05-01T12:00:01.000Z'), seq: 1, kind: 'anuidade',
        },
      ],
    });

    const res = await request(app).get(`${base}/payments`).set(authHeader());

    expect(res.status).toBe(200);
    expect(res.body.annuity_id).toBe(annuityId);
    expect(res.body.dojo_id).toBe('dojo-1');
    expect(res.body.count).toBe(2);
    expect(res.body.total).toBe(100);
    expect(res.body.data).toHaveLength(2);
    // ordem vem da query (mockada já na ordem esperada) -- valida que o
    // handler NÃO reordena/filtra por conta própria e expõe amount numérico
    expect(res.body.data[0].id).toBe('pay-2');
    expect(res.body.data[0].amount).toBe(40);
    expect(typeof res.body.data[0].amount).toBe('number');
    expect(res.body.data[1].id).toBe('pay-1');
    expect(res.body.data[1].operation_id).toBe('op-1');

    // ORDER BY paid_at DESC, created_at DESC na query em si
    const paymentsQuerySql = db.query.mock.calls[2][0];
    expect(paymentsQuerySql).toMatch(/ORDER BY p\.paid_at DESC, p\.created_at DESC/);
  });

  test('migration 247 ausente (42P01) -> extrato vazio, não 500', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({ rows: [{ id: annuityId, dojo_id: null, practitioner_id: 'p1' }] }); // header
    const err = new Error('relation "karate_annuity_payments" does not exist');
    err.code = '42P01';
    db.query.mockRejectedValueOnce(err);

    const res = await request(app).get(`${base}/payments`).set(authHeader());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});
