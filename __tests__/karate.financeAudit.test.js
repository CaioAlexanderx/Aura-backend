// ============================================================
// AURA KARATÊ — Fase G3: testes do rastro de ações financeiras
// (karate_finance_audit_log)
//
// Cobertura:
//   (a) baixa manual (POST /installments/:id/pay) grava autor (actor_label
//       resolvido do usuário autenticado) + before/after.
//   (b) baixa via webhook (confirmIntent source='webhook') grava
//       actor_label='webhook', actor_user_id=null.
//   (c) falha ao GRAVAR o log (INSERT rejeita) NÃO derruba a operação
//       financeira principal — nem no service (confirmIntent), nem no
//       módulo isolado (logFinanceAudit nunca lança).
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/nuvemfiscal');

const db = require('../src/config/database');
const { logFinanceAudit } = require('../src/services/karateFinanceAudit');

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ── Unidade: karateFinanceAudit.logFinanceAudit ─────────────────────
describe('karateFinanceAudit.logFinanceAudit', () => {
  it('grava actor_label resolvido do usuário (users.full_name) + before/after (a)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ full_name: 'Caio Pantoja', email: 'caio@example.com' }] }) // resolve actor
      .mockResolvedValueOnce({ rows: [] }); // INSERT

    await logFinanceAudit({
      federationId: 'fed-1',
      action: 'installment_pay',
      targetType: 'installment',
      targetId: 'inst-1',
      dojoId: 'dojo-1',
      actorUserId: 'user-1',
      source: 'ui',
      before: { status: 'pending', amount: 500 },
      after: { status: 'paid', amount: 500 },
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO karate_finance_audit_log/);
    expect(params[0]).toBe('fed-1');           // federation_id
    expect(params[1]).toBe('installment_pay'); // action
    expect(params[2]).toBe('installment');     // target_type
    expect(params[3]).toBe('inst-1');          // target_id
    expect(params[6]).toBe('user-1');          // actor_user_id
    expect(params[7]).toBe('Caio Pantoja');    // actor_label
    expect(params[8]).toBe('ui');              // source
    expect(JSON.parse(params[9])).toEqual({ status: 'pending', amount: 500 });  // before
    expect(JSON.parse(params[10])).toEqual({ status: 'paid', amount: 500 });    // after
  });

  it('actor_label = "webhook" quando source=webhook, sem consultar users (b)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // só o INSERT

    await logFinanceAudit({
      federationId: 'fed-1',
      action: 'intent_confirm',
      targetType: 'installment',
      targetId: 'inst-2',
      actorUserId: null,
      source: 'webhook',
      before: { status: 'pending' },
      after: { status: 'paid' },
    });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [, params] = db.query.mock.calls[0];
    expect(params[6]).toBeNull();      // actor_user_id
    expect(params[7]).toBe('webhook'); // actor_label
    expect(params[8]).toBe('webhook'); // source
  });

  it('INSERT rejeita -> logFinanceAudit NUNCA lança (resolve normalmente) (c)', async () => {
    db.query.mockRejectedValueOnce(new Error('relation "karate_finance_audit_log" does not exist'));

    await expect(logFinanceAudit({
      federationId: 'fed-1',
      action: 'void',
      targetType: 'annuity',
      targetId: 'ann-1',
      actorUserId: null,
      source: 'api',
      before: null,
      after: null,
    })).resolves.toBeUndefined();
  });

  it('falha ao RESOLVER o actor (SELECT users rejeita) também não lança — cai pro rótulo default', async () => {
    db.query
      .mockRejectedValueOnce(new Error('connection lost'))  // resolve actor falha
      .mockResolvedValueOnce({ rows: [] });                  // INSERT ainda tenta rodar

    await expect(logFinanceAudit({
      federationId: 'fed-1',
      action: 'installment_pay',
      targetType: 'installment',
      targetId: 'inst-3',
      actorUserId: 'user-2',
      source: 'ui',
    })).resolves.toBeUndefined();
  });
});

// ── Integração: POST /financial/payments/:intentId/confirm (manual) ──
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const makeToken = (overrides) => jwt.sign(
  Object.assign({ id: 'user-test-uuid', role: 'admin', plan: 'expansao' }, overrides || {}),
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);
const adminToken = makeToken();

const FED_ID = 'fed-uuid-g3';
const HIST_ID = 'hist-uuid-g3';
const TX_ID = 'tx-uuid-g3';
const INTENT_ID = 'intent-uuid-g3';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id/financial', require('../src/routes/karateAnnuities'));
  return app;
}

describe('POST /financial/payments/:intentId/confirm — grava autor + before/after (a)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  it('confirma o pagamento E grava 1 linha de auditoria com actor_user_id do JWT e before/after', (done) => {
    const INTENT_ROW = {
      id: INTENT_ID,
      federation_id: FED_ID,
      transaction_id: TX_ID,
      status: 'pending',
      amount: 500,
      source_type: null,
      source_id: null,
      annuity_history_id: HIST_ID,
      dojo_id: null, // sem dojo_id -> pula o bloco de NFS-e (mantém o teste focado)
      practitioner_id: null,
      reference_period: '2026',
      annuity_amount: 500,
      annuity_status: 'pending',
    };

    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce({})                       // BEGIN
      .mockResolvedValueOnce({ rows: [INTENT_ROW] })    // SELECT intent
      .mockResolvedValueOnce({ rows: [] })              // UPDATE intent status=paid
      .mockResolvedValueOnce({ rows: [] })              // UPDATE annuity_history status=paid
      .mockResolvedValueOnce({ rows: [] })              // UPDATE transactions status=confirmed
      .mockResolvedValueOnce({});                       // COMMIT

    // db.query (pool, fora da transação) — resolve actor_label + INSERT de auditoria
    db.query
      .mockResolvedValueOnce({ rows: [{ full_name: 'Caio Pantoja', email: 'caio@example.com' }] })
      .mockResolvedValueOnce({ rows: [] }); // INSERT karate_finance_audit_log

    request(app)
      .post('/federation/' + FED_ID + '/financial/payments/' + INTENT_ID + '/confirm')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ emit_nfse: false })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('paid');

        // A auditoria foi gravada via db.query (pool) — 2 chamadas: resolve
        // actor + INSERT (a transação em si usa client.query, contado à parte).
        const insertCall = db.query.mock.calls.find((c) => /INSERT INTO karate_finance_audit_log/.test(c[0]));
        expect(insertCall).toBeTruthy();
        const params = insertCall[1];
        expect(params[0]).toBe(FED_ID);          // federation_id
        expect(params[1]).toBe('intent_confirm'); // action
        expect(params[2]).toBe('annuity');        // target_type (header legado, sem parcela)
        expect(params[3]).toBe(HIST_ID);          // target_id
        expect(params[6]).toBe('user-test-uuid'); // actor_user_id (vem do JWT)
        expect(params[7]).toBe('Caio Pantoja');   // actor_label
        expect(params[8]).toBe('ui');             // source (manual -> 'ui')
        const before = JSON.parse(params[9]);
        const after = JSON.parse(params[10]);
        expect(before.status).toBe('pending');
        expect(after.status).toBe('paid');
        done();
      });
  });
});

// ── Integração: webhook confirma pagamento -> actor_label='webhook' (b) ──
function buildWebhookApp() {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/karate-payments', require('../src/routes/karateWebhooks'));
  return app;
}

describe('POST /webhooks/karate-payments — grava actor_label="webhook" (b)', () => {
  let app;
  beforeAll(() => { app = buildWebhookApp(); });

  const FEDERATION_SECRET = 'segredo-federacao-g3';
  const PROVIDER_PAYMENT_ID = 'ext-payment-g3';

  it('confirma via webhook e grava auditoria com source=webhook, actor_user_id=null', (done) => {
    const INTENT_ROW = { id: INTENT_ID, federation_id: FED_ID, status: 'pending', provider: 'dynamic_provider' };
    const FULL_INTENT_ROW = {
      id: INTENT_ID, federation_id: FED_ID, transaction_id: TX_ID, status: 'pending',
      provider: 'dynamic_provider', source_type: null, source_id: null,
      annuity_history_id: HIST_ID, dojo_id: null, practitioner_id: null,
      reference_period: '2026', annuity_amount: 500, annuity_status: 'pending', amount: 500,
    };

    // db.query (pool): 1) find intent by provider id, 2) resolve segredo,
    // 3) log webhook_logs (best-effort), 4) INSERT karate_finance_audit_log
    // (actor_label='webhook' -> NÃO consulta users).
    db.query
      .mockResolvedValueOnce({ rows: [INTENT_ROW] })
      .mockResolvedValueOnce({ rows: [{ karate_payment_provider_webhook_secret: FEDERATION_SECRET }] })
      .mockResolvedValueOnce({ rows: [] }) // webhook_logs
      .mockResolvedValueOnce({ rows: [] }); // INSERT karate_finance_audit_log

    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce({})                          // BEGIN
      .mockResolvedValueOnce({ rows: [FULL_INTENT_ROW] })  // SELECT intent
      .mockResolvedValueOnce({ rows: [] })                 // UPDATE intent
      .mockResolvedValueOnce({ rows: [] })                 // UPDATE annuity_history
      .mockResolvedValueOnce({ rows: [] })                 // UPDATE transactions
      .mockResolvedValueOnce({});                          // COMMIT

    request(app)
      .post('/webhooks/karate-payments')
      .set('X-Webhook-Token', FEDERATION_SECRET)
      .send({ event: 'PAYMENT_CONFIRMED', payment: { id: PROVIDER_PAYMENT_ID } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.handled).toBe(true);

        const insertCall = db.query.mock.calls.find((c) => /INSERT INTO karate_finance_audit_log/.test(c[0]));
        expect(insertCall).toBeTruthy();
        const params = insertCall[1];
        expect(params[6]).toBeNull();       // actor_user_id
        expect(params[7]).toBe('webhook');  // actor_label
        expect(params[8]).toBe('webhook');  // source
        done();
      });
  });
});

// ── (c) falha ao gravar o log NÃO derruba confirmIntent (fim a fim) ──
describe('confirmIntent — falha no INSERT de auditoria não afeta a confirmação (c)', () => {
  it('COMMIT já aconteceu; INSERT de auditoria rejeita; confirmIntent ainda retorna code=OK', async () => {
    const dbLocal = db;
    const paymentSvc = require('../src/services/karatePaymentService');

    const INTENT_ROW = {
      id: 'intent-fail-log', federation_id: 'fed-x', transaction_id: 'tx-x', status: 'pending',
      source_type: null, source_id: null, annuity_history_id: 'hist-x',
      dojo_id: null, practitioner_id: null, reference_period: '2026',
      annuity_amount: 500, annuity_status: 'pending', amount: 500,
    };

    const mockClient = { query: jest.fn(), release: jest.fn() };
    dbLocal.connect.mockResolvedValue(mockClient);
    mockClient.query
      .mockResolvedValueOnce({})                     // BEGIN
      .mockResolvedValueOnce({ rows: [INTENT_ROW] }) // SELECT intent
      .mockResolvedValueOnce({ rows: [] })           // UPDATE annuity_history
      .mockResolvedValueOnce({ rows: [] })           // UPDATE transactions
      .mockResolvedValueOnce({});                    // COMMIT

    // Todo o subsistema de auditoria falha (resolve actor E/OU insert) —
    // simulamos rejeição direto na primeira chamada de db.query (pool).
    dbLocal.query.mockRejectedValueOnce(new Error('karate_finance_audit_log indisponível'));

    const result = await paymentSvc.confirmIntent('intent-fail-log', {
      source: 'manual',
      federationId: 'fed-x',
      actorUserId: 'user-z',
      emitNfse: false,
    });

    expect(result.code).toBe('OK');
    expect(result.status).toBe('paid');
    expect(result.transactionId).toBe('tx-x');
    // A transação principal foi commitada normalmente apesar do log falhar.
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });
});
