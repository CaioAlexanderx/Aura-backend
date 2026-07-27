// ============================================================
// AURA KARATÊ — Testes Integração: PATCH /financial/annuities/dojos/:dojoId/:annuityId
// (edição do HEADER da anuidade — valor/plano/período/vencimentos das
// parcelas, independente do status — Decisão do Caio, 23/07/2026).
//
// Diferente de tests/integration/karateAnnuityPaymentEdit.test.js (que
// mocka recomputeAnnuityFromLedger), AQUI o motor de recompute/rollup fica
// REAL (karateAnnuityLedger.js e karateAnnuityService.js não são
// mockados) — só a camada de conexão com o Postgres é substituída por um
// fake em memória (tests/helpers/fakeAnnuityDb.js) que entende as queries
// exatas emitidas pela rota + pelo recompute. Isso garante que o FIFO
// exercitado aqui (troca de plano, reordenação por due_date) é o
// comportamento REAL de produção, não uma simulação da lógica.
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createFakeClient } = require('../helpers/fakeAnnuityDb');

jest.mock('../../src/services/karateFinanceAudit', () => ({
  logFinanceAudit: jest.fn().mockResolvedValue(undefined),
  actorFromReq: jest.fn(() => ({ actorUserId: 'u1' })),
  resolveActorLabel: jest.fn(async () => 'Usuário Teste'),
  VALID_SOURCES: ['ui', 'batch', 'campaign', 'webhook', 'api'],
  VALID_TARGET_TYPES: ['annuity', 'installment'],
}));

let app, db, financeAudit;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  financeAudit = require('../../src/services/karateFinanceAudit');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const annuityId = 'a1000000-0000-0000-0000-00000000000a';
const base = `/api/v1/federation/${fedId}/financial/annuities/dojos/${dojoId}/${annuityId}`;

const authHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client' }, SECRET, { expiresIn: '1h' })}`,
});

function mockCompanyAccess() {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
  // best-effort reconcileInstallmentTransactions (roda depois do commit,
  // via db.query direto — não é o client transacional) — qualquer coisa
  // que sobrar resolve pra {rows:[]}.
  db.query.mockResolvedValue({ rows: [] });
}

afterEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  financeAudit.logFinanceAudit.mockClear();
});

function baseState(overrides = {}) {
  return {
    header: {
      id: annuityId, dojo_id: dojoId, federation_id: fedId,
      reference_period: '2026', plan: 'anual', amount: 500,
      due_date: '2026-05-31', status: 'pending', paid_at: null,
      payment_method: null, transaction_id: null,
    },
    installments: [],
    payments: [],
    transactions: new Map(),
    txByIdemKey: new Map(),
    fees: [],
    companies: new Map([[dojoId, { name: 'Dojô Teste' }]]),
    otherHeaders: [],
    ...overrides,
  };
}

function installFakeClient(state) {
  const client = createFakeClient(state);
  db.connect.mockResolvedValueOnce(client);
  return client;
}

describe('PATCH /financial/annuities/dojos/:dojoId/:annuityId — header da anuidade', () => {
  test('sem token -> 401', async () => {
    const res = await request(app).patch(base).send({ amount: 700 });
    expect(res.status).toBe(401);
  });

  test('nenhum campo -> 400, nunca abre conexão', async () => {
    mockCompanyAccess();
    const res = await request(app).patch(base).set(authHeader()).send({});
    expect(res.status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('plan inválido -> 422 VALIDATION_ERROR, nunca abre conexão', async () => {
    mockCompanyAccess();
    const res = await request(app).patch(base).set(authHeader()).send({ plan: 'mensal' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('anuidade não encontrada -> 404', async () => {
    mockCompanyAccess();
    const state = baseState({ header: null });
    installFakeClient(state);
    const res = await request(app).patch(base).set(authHeader()).send({ amount: 700 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('reference_period duplicado -> 409 CONFLICT', async () => {
    mockCompanyAccess();
    const state = baseState({
      otherHeaders: [{ id: 'other-annuity', dojo_id: dojoId, reference_period: '2027' }],
    });
    installFakeClient(state);
    const res = await request(app).patch(base).set(authHeader()).send({ reference_period: '2027' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  test('editar amount de anuidade JÁ PAGA funciona (sem bloqueio ALREADY_PAID) e recomputa saldo/status', async () => {
    mockCompanyAccess();
    const state = baseState({
      header: {
        id: annuityId, dojo_id: dojoId, federation_id: fedId,
        reference_period: '2026', plan: 'anual', amount: 500,
        due_date: '2026-05-31', status: 'paid', paid_at: '2026-05-10T12:00:00-03:00',
        payment_method: 'pix', transaction_id: 'tx-1',
      },
      installments: [{
        id: 'inst-1', annuity_id: annuityId, federation_id: fedId, seq: 1,
        amount: 500, amount_paid: 500, due_date: '2026-05-31', status: 'paid',
        kind: 'anuidade', payment_method: 'pix', paid_at: '2026-05-10T12:00:00-03:00',
        transaction_id: 'tx-1',
      }],
      payments: [{
        id: 'pay-1', federation_id: fedId, installment_id: 'inst-1', annuity_id: annuityId,
        amount: 500, paid_at: '2026-05-10T12:00:00-03:00', payment_method: 'pix',
        created_by: 'u1', operation_id: null, created_at: '2026-05-10T12:00:00-03:00',
      }],
      transactions: new Map([['tx-1', { id: 'tx-1', amount: 500, due_date: '2026-05-31', status: 'confirmed' }]]),
    });
    installFakeClient(state);

    const res = await request(app).patch(base).set(authHeader()).send({ amount: 700 });

    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(700);
    // ainda faltam 200 -> status deixa de ser 'paid' e vira 'partial' na parcela
    const inst = res.body.installments.find((i) => i.seq === 1);
    expect(inst.amount).toBe(700);
    expect(inst.amount_paid).toBe(500);
    expect(inst.status).toBe('partial');
    expect(res.body.status).toBe('pending'); // header: nem tudo pago

    expect(financeAudit.logFinanceAudit).toHaveBeenCalledTimes(1);
    const auditCall = financeAudit.logFinanceAudit.mock.calls[0][0];
    expect(auditCall.action).toBe('annuity_edit');
    expect(auditCall.targetType).toBe('annuity');
    expect(auditCall.targetId).toBe(annuityId);
    expect(auditCall.dojoId).toBe(dojoId);
    expect(auditCall.before.amount).toBe(500);
    expect(auditCall.after.amount).toBe(700);
  });

  test('trocar plano anual -> semestral com pagamento redistribui o ledger via FIFO', async () => {
    mockCompanyAccess();
    const state = baseState({
      header: {
        id: annuityId, dojo_id: dojoId, federation_id: fedId,
        reference_period: '2026', plan: 'anual', amount: 500,
        due_date: '2026-05-31', status: 'paid', paid_at: '2026-05-10T12:00:00-03:00',
        payment_method: 'pix', transaction_id: 'tx-1',
      },
      installments: [{
        id: 'inst-1', annuity_id: annuityId, federation_id: fedId, seq: 1,
        amount: 500, amount_paid: 500, due_date: '2026-05-31', status: 'paid',
        kind: 'anuidade', payment_method: 'pix', paid_at: '2026-05-10T12:00:00-03:00',
        transaction_id: 'tx-1',
      }],
      payments: [{
        id: 'pay-1', federation_id: fedId, installment_id: 'inst-1', annuity_id: annuityId,
        amount: 500, paid_at: '2026-05-10T12:00:00-03:00', payment_method: 'pix',
        created_by: 'u1', operation_id: null, created_at: '2026-05-10T12:00:00-03:00',
      }],
      transactions: new Map([['tx-1', { id: 'tx-1', amount: 500, due_date: '2026-05-31', status: 'confirmed' }]]),
      fees: [{ federation_id: fedId, fee_type: 'dojo', plan: 'semestral', amount: 280, due_months: [5, 11] }],
    });
    installFakeClient(state);

    const res = await request(app).patch(base).set(authHeader()).send({ plan: 'semestral' });

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('semestral');
    expect(res.body.amount).toBe(560); // 280 x 2

    const may = res.body.installments.find((i) => i.due_date === '2026-05-31' && i.kind === 'anuidade');
    const nov = res.body.installments.find((i) => i.due_date === '2026-11-30' && i.kind === 'anuidade');
    expect(may.amount).toBe(280);
    expect(may.status).toBe('paid');
    expect(may.amount_paid).toBe(280);
    expect(nov.amount).toBe(280);
    expect(nov.status).toBe('partial');
    expect(nov.amount_paid).toBe(220); // 500 - 280 transbordou pra próxima em aberto

    // a parcela original (seq=1) sobreviveu (mesmo id) — não foi recriada.
    expect(may.installment_id).toBe('inst-1');
  });

  test('editar só o vencimento de uma parcela (installments explícito) reordena o FIFO', async () => {
    mockCompanyAccess();
    const state = baseState({
      header: {
        id: annuityId, dojo_id: dojoId, federation_id: fedId,
        reference_period: '2026', plan: 'semestral', amount: 500,
        due_date: '2026-11-30', status: 'partial', paid_at: null,
        payment_method: 'pix', transaction_id: null,
      },
      installments: [
        {
          id: 'inst-1', annuity_id: annuityId, federation_id: fedId, seq: 1,
          amount: 250, amount_paid: 250, due_date: '2026-05-31', status: 'paid',
          kind: 'anuidade', payment_method: 'pix', paid_at: '2026-06-01T12:00:00-03:00', transaction_id: null,
        },
        {
          id: 'inst-2', annuity_id: annuityId, federation_id: fedId, seq: 2,
          amount: 250, amount_paid: 50, due_date: '2026-11-30', status: 'partial',
          kind: 'anuidade', payment_method: 'pix', paid_at: null, transaction_id: null,
        },
      ],
      payments: [
        {
          id: 'pay-1', federation_id: fedId, installment_id: 'inst-1', annuity_id: annuityId,
          amount: 250, paid_at: '2026-06-01T12:00:00-03:00', payment_method: 'pix',
          created_by: 'u1', operation_id: null, created_at: '2026-06-01T12:00:00-03:00',
        },
        {
          id: 'pay-2', federation_id: fedId, installment_id: 'inst-2', annuity_id: annuityId,
          amount: 50, paid_at: '2026-06-01T12:00:00-03:00', payment_method: 'pix',
          created_by: 'u1', operation_id: null, created_at: '2026-06-01T12:00:00-03:00',
        },
      ],
    });
    installFakeClient(state);

    // Troca as datas de vencimento (mesmos seq/amount) — seq=2 passa a
    // vencer ANTES de seq=1.
    const res = await request(app).patch(base).set(authHeader()).send({
      installments: [
        { seq: 1, due_date: '2026-11-30', amount: 250 },
        { seq: 2, due_date: '2026-05-31', amount: 250 },
      ],
    });

    expect(res.status).toBe(200);
    const seq1 = res.body.installments.find((i) => i.seq === 1);
    const seq2 = res.body.installments.find((i) => i.seq === 2);

    expect(seq1.due_date).toBe('2026-11-30');
    expect(seq2.due_date).toBe('2026-05-31');

    // FIFO reordenou: agora quem vence primeiro (seq=2) é quem fica 'paid'
    // cheio, e quem passou a vencer depois (seq=1) fica com o saldo parcial
    // — exatamente invertido do estado antes da edição.
    expect(seq2.status).toBe('paid');
    expect(seq2.amount_paid).toBe(250);
    expect(seq1.status).toBe('partial');
    expect(seq1.amount_paid).toBe(50);
  });

  test('novo total abaixo do já recebido -> 422 AMOUNT_BELOW_PAID, nada é alterado', async () => {
    mockCompanyAccess();
    const state = baseState({
      header: {
        id: annuityId, dojo_id: dojoId, federation_id: fedId,
        reference_period: '2026', plan: 'anual', amount: 500,
        due_date: '2026-05-31', status: 'paid', paid_at: '2026-05-10T12:00:00-03:00',
        payment_method: 'pix', transaction_id: 'tx-1',
      },
      installments: [{
        id: 'inst-1', annuity_id: annuityId, federation_id: fedId, seq: 1,
        amount: 500, amount_paid: 500, due_date: '2026-05-31', status: 'paid',
        kind: 'anuidade', payment_method: 'pix', paid_at: '2026-05-10T12:00:00-03:00', transaction_id: 'tx-1',
      }],
      payments: [{
        id: 'pay-1', federation_id: fedId, installment_id: 'inst-1', annuity_id: annuityId,
        amount: 500, paid_at: '2026-05-10T12:00:00-03:00', payment_method: 'pix',
        created_by: 'u1', operation_id: null, created_at: '2026-05-10T12:00:00-03:00',
      }],
    });
    installFakeClient(state);

    const res = await request(app).patch(base).set(authHeader()).send({ amount: 400 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AMOUNT_BELOW_PAID');
    expect(res.body.details).toEqual({ new_total: 400, paid_total: 500 });
    expect(financeAudit.logFinanceAudit).not.toHaveBeenCalled();

    // nada foi tocado (a validação roda ANTES de qualquer mutação).
    expect(state.installments[0].amount).toBe(500);
    expect(state.header.amount).toBe(500);
  });

  test('parcela de filiação (kind=filiacao) sobrevive intacta à edição da anuidade', async () => {
    mockCompanyAccess();
    const state = baseState({
      header: {
        id: annuityId, dojo_id: dojoId, federation_id: fedId,
        reference_period: '2026', plan: 'anual', amount: 500,
        due_date: '2026-05-31', status: 'pending', paid_at: null,
        payment_method: null, transaction_id: null,
      },
      installments: [
        {
          id: 'inst-fil', annuity_id: annuityId, federation_id: fedId, seq: 0,
          amount: 195, amount_paid: 0, due_date: '2026-03-15', status: 'pending',
          kind: 'filiacao', payment_method: null, paid_at: null, transaction_id: 'tx-fil',
        },
        {
          id: 'inst-1', annuity_id: annuityId, federation_id: fedId, seq: 1,
          amount: 500, amount_paid: 0, due_date: '2026-05-31', status: 'pending',
          kind: 'anuidade', payment_method: null, paid_at: null, transaction_id: 'tx-1',
        },
      ],
      payments: [],
      transactions: new Map([
        ['tx-fil', { id: 'tx-fil', amount: 195, due_date: '2026-03-15', status: 'pending' }],
        ['tx-1', { id: 'tx-1', amount: 500, due_date: '2026-05-31', status: 'pending' }],
      ]),
    });
    installFakeClient(state);

    const res = await request(app).patch(base).set(authHeader()).send({ amount: 600 });

    expect(res.status).toBe(200);
    const fil = res.body.installments.find((i) => i.kind === 'filiacao');
    const anu = res.body.installments.find((i) => i.kind === 'anuidade');

    expect(fil).toBeDefined();
    expect(fil.installment_id).toBe('inst-fil');
    expect(fil.amount).toBe(195);
    expect(fil.status).toBe('pending');

    expect(anu.amount).toBe(600);

    // a parcela de filiação nunca foi removida do estado (mesmo id, ainda lá).
    expect(state.installments.some((i) => i.id === 'inst-fil')).toBe(true);
  });

  test('seq duplicado em installments -> 422 VALIDATION_ERROR', async () => {
    mockCompanyAccess();
    const state = baseState({
      installments: [{
        id: 'inst-1', annuity_id: annuityId, federation_id: fedId, seq: 1,
        amount: 500, amount_paid: 0, due_date: '2026-05-31', status: 'pending', kind: 'anuidade',
      }],
    });
    installFakeClient(state);

    const res = await request(app).patch(base).set(authHeader()).send({
      installments: [
        { seq: 1, due_date: '2026-05-31', amount: 250 },
        { seq: 1, due_date: '2026-11-30', amount: 250 },
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
