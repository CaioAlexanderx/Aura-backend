// ============================================================
// AURA KARATÊ — Testes Integração: consolidação F3 das 3 rotas de baixa
// legadas sobre o motor F1 (applyAnnuityPayment). Objetivo destes testes:
// provar que as 3 rotas NÃO escrevem mais amount_paid/status direto —
// elas delegam pro motor (mockado aqui; a lógica do motor já tem suíte
// própria em karateAnnuityLedger.test.js).
//
//   POST /annuities/dojos/:dojoId/:annuityId/pay   (baixa manual do dojô)
//   POST /annuities/dojos/:dojoId/pay              (lança + baixa em 1 passo)
//   POST /annuities/installments/:installmentId/pay (baixa de 1 parcela)
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
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const annuityId = 'a1000000-0000-0000-0000-00000000000a';
const installmentId = 'i1000000-0000-0000-0000-00000000000i';
const base = `/api/v1/federation/${fedId}/financial`;

const authHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client' }, SECRET, { expiresIn: '1h' })}`,
});

function mockCompanyAccess() {
  // Baseline: qualquer db.query() além das mockResolvedValueOnce
  // explicitamente enfileiradas no teste (ex.: os best-effort de
  // reconciliação de transactions/cancelamento de intents pendentes)
  // resolve pra {rows:[]} em vez de undefined -- sem isso, .catch() num
  // retorno undefined do mock quebra o try/catch da rota com um erro que
  // não tem nada a ver com o que o teste quer exercitar.
  db.query.mockResolvedValue({ rows: [] });
  db.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
}

afterEach(() => {
  db.query.mockReset();
  ledgerSvc.applyAnnuityPayment.mockReset();
});

function commitResult(overrides = {}) {
  return {
    dry_run: false, federation_id: fedId, annuity_id: annuityId, amount: 100,
    payment_method: 'pix', paid_at: '2026-07-10T15:00:00.000Z', operation_id: null,
    allocations: [{
      installment_id: installmentId, annuity_id: annuityId, seq: 1, kind: 'anuidade',
      due_date: '2026-05-31', amount_due: 100, amount_paid_before: 0, amount_applied: 100,
      amount_paid_after: 100, balance_after: 0, status_before: 'pending', status_after: 'paid',
      closes_installment: true,
    }],
    total_applied: 100, remaining_unapplied: 0, balance_before: 100, balance_after: 0,
    header: { id: annuityId, dojo_id: dojoId, practitioner_id: null, status: 'paid', transaction_id: 'tx-1' },
    idempotent_hit: false,
    ...overrides,
  };
}

describe('POST /annuities/dojos/:dojoId/:annuityId/pay — consolidação F3', () => {
  test('já paga -> 200 idempotent_hit:true, NUNCA chama o motor', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: annuityId, dojo_id: dojoId, federation_id: fedId, reference_period: '2026',
        amount: '100.00', due_date: '2026-05-31', status: 'paid', paid_at: new Date('2026-05-01'),
        transaction_id: 'tx-1', dojo_name: 'Dojô Teste',
      }],
    });

    const res = await request(app)
      .post(`${base}/annuities/dojos/${dojoId}/${annuityId}/pay`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.idempotent_hit).toBe(true);
    expect(ledgerSvc.applyAnnuityPayment).not.toHaveBeenCalled();
  });

  test('não paga, sem override: usa o SALDO EM ABERTO real (SUM amount-amount_paid), delega pro motor', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: annuityId, dojo_id: dojoId, federation_id: fedId, reference_period: '2026',
        amount: '100.00', due_date: '2026-05-31', status: 'pending', paid_at: null,
        transaction_id: null, dojo_name: 'Dojô Teste',
      }],
    });
    db.query.mockResolvedValueOnce({ rows: [{ balance: '35.00' }] }); // saldo real (parcial já pago em outra via)
    ledgerSvc.applyAnnuityPayment.mockResolvedValueOnce(commitResult({ amount: 35 }));

    const res = await request(app)
      .post(`${base}/annuities/dojos/${dojoId}/${annuityId}/pay`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(ledgerSvc.applyAnnuityPayment).toHaveBeenCalledTimes(1);
    const call = ledgerSvc.applyAnnuityPayment.mock.calls[0][0];
    expect(call.amount).toBe(35); // saldo, não os 100 do header
    expect(call.annuity_id).toBe(annuityId);
  });

  test('motor recusa excedente -> 422 propagado (não força status=paid como antes)', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: annuityId, dojo_id: dojoId, federation_id: fedId, reference_period: '2026',
        amount: '100.00', due_date: '2026-05-31', status: 'pending', paid_at: null,
        transaction_id: null, dojo_name: 'Dojô Teste',
      }],
    });
    const { AnnuityPaymentError } = jest.requireActual('../../src/services/karateAnnuityLedger');
    ledgerSvc.applyAnnuityPayment.mockRejectedValueOnce(
      new AnnuityPaymentError('AMOUNT_EXCEEDS_BALANCE', 'excede saldo', 422, { amount: 999, balance: 100 })
    );

    const res = await request(app)
      .post(`${base}/annuities/dojos/${dojoId}/${annuityId}/pay`)
      .set(authHeader())
      .send({ amount: 999 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AMOUNT_EXCEEDS_BALANCE');
  });
});

describe('POST /annuities/installments/:installmentId/pay — consolidação F3', () => {
  test('já paga -> 200 idempotent_hit:true, NUNCA chama o motor', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: installmentId, annuity_id: annuityId, amount: '100.00', amount_paid: '100.00', status: 'paid',
        due_date: '2026-05-31', paid_at: new Date('2026-05-01'), payment_method: 'pix', transaction_id: 'tx-1',
        federation_id: fedId, dojo_id: dojoId, practitioner_id: null, reference_period: '2026', plan: 'anual',
        ref_name: 'Dojô Teste', seq: 1,
      }],
    });

    const res = await request(app)
      .post(`${base}/annuities/installments/${installmentId}/pay`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.idempotent_hit).toBe(true);
    expect(ledgerSvc.applyAnnuityPayment).not.toHaveBeenCalled();
  });

  test('não paga, com transaction_id já setado: chama o motor com installment_id (escopa a UMA parcela)', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: installmentId, annuity_id: annuityId, amount: '100.00', amount_paid: '40.00', status: 'partial',
        due_date: '2026-05-31', paid_at: null, payment_method: null, transaction_id: 'tx-1',
        federation_id: fedId, dojo_id: dojoId, practitioner_id: null, reference_period: '2026', plan: 'anual',
        ref_name: 'Dojô Teste', seq: 1,
      }],
    });
    ledgerSvc.applyAnnuityPayment.mockResolvedValueOnce(commitResult({ amount: 60 }));

    const res = await request(app)
      .post(`${base}/annuities/installments/${installmentId}/pay`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(200);
    const call = ledgerSvc.applyAnnuityPayment.mock.calls[0][0];
    expect(call.installment_id).toBe(installmentId);
    expect(call.amount).toBe(60); // saldo real (100 - 40 já pago), não os 100 cheios
    expect(call.annuity_id).toBe(annuityId);
  });
});
