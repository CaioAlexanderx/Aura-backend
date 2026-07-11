// ============================================================
// AURA KARATÊ — Testes Fase F5 (conciliação automática de pagamento)
//
// Cobertura:
//   1. karatePaymentProvider — sem config de federação, provider default
//      continua static_brcode (gate: sem credenciais, nada muda).
//   2. POST /webhooks/karate-payments
//      a) confirma pagamento em evento pago (source='webhook')
//      b) replay do MESMO evento é idempotente — não reaplica a baixa
//      c) token inválido (federação com segredo configurado) → 401
//      d) evento desconhecido → 200 no-op (nunca 500)
//      e) sem nenhum segredo configurado (federação nem env) → aceita
//
// O /confirm manual (POST /financial/payments/:intentId/confirm) NÃO
// muda de comportamento após o refactor pra karatePaymentService — a
// prova disso são os testes JÁ EXISTENTES em __tests__/karate.trackB.test.js
// (charge → pix → confirm), que continuam verdes sem nenhuma alteração.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ── 1. Provider resolution — sem config, cai no default static_brcode ──
describe('karatePaymentProvider — gate de credenciais', () => {
  const { createPixCharge } = require('../src/services/karatePaymentProvider');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sem linha em digital_channel_config: cria PIX mock static_brcode (comportamento identico ao atual)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // SELECT digital_channel_config (sem linha)

    const result = await createPixCharge({
      federationId: 'fed-001',
      amount: 100,
      txid: 'txid-001',
      description: 'Anuidade',
    });

    expect(result.provider).toBe('static_brcode');
    expect(result.status).toBe('pending');
    expect(result._warn).toMatch(/PIX nao configurado/);
  });

  it('com karate_payment_provider configurado mas sem pix_key: ainda cai no fallback mock static_brcode (só provider dinamico usa a config nova)', async () => {
    // karate_payment_provider vazio simula migration 224 aplicada mas
    // federação não optou pelo provider dinâmico — provider default.
    db.query.mockResolvedValueOnce({
      rows: [{ pix_key: null, pix_key_type: null, pix_holder_name: null, pix_holder_city: null,
               karate_payment_provider: null, karate_payment_provider_api_key: null,
               karate_payment_provider_base_url: null, karate_payment_provider_webhook_secret: null }],
    });

    const result = await createPixCharge({
      federationId: 'fed-002', amount: 50, txid: 'txid-002', description: 'Anuidade',
    });

    expect(result.provider).toBe('static_brcode');
  });
});

// ── 2. Webhook de pagamento ──────────────────────────────────────────
const express = require('express');
const request = require('supertest');

function buildWebhookApp() {
  const app = express();
  app.use(express.json());
  app.use('/webhooks/karate-payments', require('../src/routes/karateWebhooks'));
  return app;
}

const FED_ID    = 'fed-webhook-001';
const INTENT_ID = 'intent-webhook-001';
const TX_ID     = 'tx-webhook-001';
const PROVIDER_PAYMENT_ID = 'ext-payment-001';

describe('POST /webhooks/karate-payments', () => {
  let app;
  beforeAll(() => { app = buildWebhookApp(); });
  beforeEach(() => { jest.clearAllMocks(); });

  it('evento desconhecido -> 200 no-op (nunca 500)', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [] })  // _findIntentByProviderPaymentId (nao encontrado)
      .mockResolvedValue({ rows: [] });     // qualquer outra query (log best-effort)

    request(app)
      .post('/webhooks/karate-payments')
      .send({ event: 'PAYMENT_OVERDUE', payment: { id: PROVIDER_PAYMENT_ID } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.received).toBe(true);
        expect(res.body.handled).toBe(false);
        expect(res.body.event_ignored).toBe('PAYMENT_OVERDUE');
        done();
      });
  });

  it('sem nenhum segredo configurado (federação nem env): aceita sem exigir token', (done) => {
    db.query
      .mockResolvedValueOnce({ rows: [] })  // find intent -> nao encontrado (payload simples)
      .mockResolvedValue({ rows: [] });

    request(app)
      .post('/webhooks/karate-payments')
      .send({ event: 'PAYMENT_OVERDUE', payment: { id: 'unknown-id' } })
      // nenhum header de token enviado de proposito
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        done();
      });
  });

  it('token invalido quando a federação tem segredo configurado -> 401 (sem vazar detalhe)', (done) => {
    db.query
      .mockResolvedValueOnce({  // find intent -> encontrado, aponta pra federação com segredo
        rows: [{ id: INTENT_ID, federation_id: FED_ID, status: 'pending', provider: 'dynamic_provider' }],
      })
      .mockResolvedValueOnce({  // resolve segredo da federação
        rows: [{ karate_payment_provider_webhook_secret: 'segredo-federacao-xyz' }],
      });

    request(app)
      .post('/webhooks/karate-payments')
      .set('X-Webhook-Token', 'token-errado')
      .send({ event: 'PAYMENT_CONFIRMED', payment: { id: PROVIDER_PAYMENT_ID } })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(401);
        expect(res.body.error).toBeTruthy();
        expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/segredo-federacao-xyz/);
        done();
      });
  });

  describe('evento pago confirma o intent (source=webhook) e replay é idempotente', () => {
    const INTENT_ROW = {
      id: INTENT_ID,
      federation_id: FED_ID,
      status: 'pending',
      provider: 'dynamic_provider',
    };

    // Intent completo devolvido pelo SELECT dentro de confirmIntent
    // (sem annuity_history_id / source_type: caminho legado, sem dojo_id
    // -> nao dispara o bloco de NFS-e, mantendo o teste focado em
    // idempotência).
    const FULL_INTENT_ROW = {
      id: INTENT_ID,
      federation_id: FED_ID,
      transaction_id: TX_ID,
      status: 'pending',
      provider: 'dynamic_provider',
      source_type: null,
      source_id: null,
      annuity_history_id: null,
      dojo_id: null,
      reference_period: null,
      annuity_amount: null,
      annuity_status: null,
    };

    it('1a entrega: confirma o pagamento e baixa a transaction', (done) => {
      // 1) find intent by provider payment id
      db.query.mockResolvedValueOnce({ rows: [INTENT_ROW] });
      // 2) resolve segredo da federação (nenhum configurado)
      db.query.mockResolvedValueOnce({ rows: [{ karate_payment_provider_webhook_secret: null }] });
      // 3) log best-effort (webhook_logs) — fire and forget
      db.query.mockResolvedValueOnce({ rows: [] });

      const mockClient = { query: jest.fn(), release: jest.fn() };
      db.connect.mockResolvedValue(mockClient);
      mockClient.query
        .mockResolvedValueOnce({})                          // BEGIN
        .mockResolvedValueOnce({ rows: [FULL_INTENT_ROW] }) // SELECT intent (sem federation_id no WHERE — fluxo webhook)
        .mockResolvedValueOnce({ rows: [] })                 // UPDATE intent status=paid
        .mockResolvedValueOnce({ rows: [] })                 // UPDATE transactions status=confirmed
        .mockResolvedValueOnce({});                          // COMMIT

      request(app)
        .post('/webhooks/karate-payments')
        .send({ event: 'PAYMENT_CONFIRMED', payment: { id: PROVIDER_PAYMENT_ID } })
        .end((err, res) => {
          if (err) return done(err);
          expect(res.status).toBe(200);
          expect(res.body.handled).toBe(true);
          expect(res.body.transaction_id).toBe(TX_ID);
          expect(res.body.status).toBe('paid');
          // BEGIN, SELECT, UPDATE intent, UPDATE transaction, COMMIT = 5 chamadas.
          expect(mockClient.query).toHaveBeenCalledTimes(5);
          done();
        });
    });

    it('replay do MESMO evento: nao reaplica a baixa (idempotente, 200)', (done) => {
      // Mesma sequência de lookup, mas agora o intent já está 'paid'.
      db.query.mockResolvedValueOnce({ rows: [{ ...INTENT_ROW, status: 'paid' }] });
      db.query.mockResolvedValueOnce({ rows: [{ karate_payment_provider_webhook_secret: null }] });
      db.query.mockResolvedValueOnce({ rows: [] });

      const mockClient = { query: jest.fn(), release: jest.fn() };
      db.connect.mockResolvedValue(mockClient);
      mockClient.query
        .mockResolvedValueOnce({})                                       // BEGIN
        .mockResolvedValueOnce({ rows: [{ ...FULL_INTENT_ROW, status: 'paid' }] }) // SELECT intent (já pago)
        .mockResolvedValueOnce({});                                      // ROLLBACK

      request(app)
        .post('/webhooks/karate-payments')
        .send({ event: 'PAYMENT_CONFIRMED', payment: { id: PROVIDER_PAYMENT_ID } })
        .end((err, res) => {
          if (err) return done(err);
          expect(res.status).toBe(200);
          expect(res.body.idempotent_hit).toBe(true);
          expect(res.body.handled).toBe(false);
          // Só BEGIN + SELECT + ROLLBACK — NÃO chega a fazer o UPDATE de
          // novo (é isso que prova que o replay não baixa a parcela 2x).
          expect(mockClient.query).toHaveBeenCalledTimes(3);
          const calledSql = mockClient.query.mock.calls.map((c) => String(c[0]));
          expect(calledSql.some((s) => /UPDATE transactions/i.test(s))).toBe(false);
          done();
        });
    });
  });
});
