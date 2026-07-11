// ============================================================
// AURA KARATÊ — Testes unitários Track B (backend financeiro + anuidades)
//
// Cobertura:
//   1. karateFinanceService.computeAnnuityStatus — lógica pura
//   2. karateFees GET/PUT — tabela de anuidades append-only
//   3. karateAnnuities charge → pix → confirm (status paid + NFS-e)
//   4. Status de dojô a partir de anuidades (annuity_history)
//
// IMPORTANTE: a ordem dos mocks DEVE bater com a ordem real das queries
// do handler (BEGIN → checagens → advisory lock → INSERT → COMMIT).
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/nuvemfiscal');

const db     = require('../src/config/database');
const fiscal = require('../src/services/nuvemfiscal');

// Module-scope afterEach: drains mockResolvedValueOnce queues after every
// test so that early-return (422) tests don't leave stale resolved values
// that bleed into the next test's db.query consumers.
// mockReset() clears the queued implementations (clearAllMocks does NOT).
// Each describe's own beforeEach re-establishes its mocks before the next test.
afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ── Lógica pura (sem DB) ───────────────────────────────────────
describe('karateFinanceService — computeAnnuityStatus', () => {
  const { computeAnnuityStatus } = require('../src/services/karateFinanceService');

  it('retorna no_charge quando annuity é null (sem cobrança)', () => {
    expect(computeAnnuityStatus(null)).toBe('no_charge');
  });

  it('retorna paid quando status=paid', () => {
    expect(computeAnnuityStatus({ status: 'paid', due_date: '2026-03-01' })).toBe('paid');
  });

  it('retorna due quando due_date é futuro e status != paid', () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    expect(computeAnnuityStatus({ status: 'pending', due_date: future.toISOString().split('T')[0] })).toBe('due');
  });

  it('retorna overdue quando vencida há <= 90 dias', () => {
    const past = new Date();
    past.setDate(past.getDate() - 45);
    expect(computeAnnuityStatus({ status: 'pending', due_date: past.toISOString().split('T')[0] })).toBe('overdue');
  });

  it('retorna defaulting quando vencida há 91–180 dias', () => {
    const past = new Date();
    past.setDate(past.getDate() - 120);
    expect(computeAnnuityStatus({ status: 'pending', due_date: past.toISOString().split('T')[0] })).toBe('defaulting');
  });

  it('retorna suspended quando vencida há > 180 dias', () => {
    const past = new Date();
    past.setDate(past.getDate() - 200);
    expect(computeAnnuityStatus({ status: 'pending', due_date: past.toISOString().split('T')[0] })).toBe('suspended');
  });

  it('retorna no_charge quando due_date é null e status != paid', () => {
    expect(computeAnnuityStatus({ status: 'pending', due_date: null })).toBe('no_charge');
  });
});

// ── Testes HTTP ──────────────────────────────────────────────────────
const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

const makeToken = (overrides) => jwt.sign(
  Object.assign({ id: 'user-test-uuid', role: 'admin', plan: 'expansao' }, overrides || {}),
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);
const adminToken = makeToken();

const FED_ID    = 'fed-uuid-001';
const DOJO_ID   = 'dojo-uuid-001';
const HIST_ID   = 'hist-uuid-001';
const TX_ID     = 'tx-uuid-001';
const INTENT_ID = 'intent-uuid-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id/financial', require('../src/routes/karateAnnuities'));
  app.use('/federation/:id/financial', require('../src/routes/karateExpenses'));
  app.use('/federation/:id/financial', require('../src/routes/karateFees'));
  app.use('/federation/:id/financial', require('../src/routes/karateFinancial'));
  return app;
}

// ── Suite: GET /financial/fees ────────────────────────────────────
describe('GET /federation/:id/financial/fees', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({
      rows: [
        { id: 'fee-1', fee_type: 'dojo', size_tier: 'up_to_40', amount: 500.00, effective_from: '2026-01-01' },
        { id: 'fee-2', fee_type: 'cpf',  size_tier: null,        amount: 120.00, effective_from: '2026-01-01' },
      ],
    });
  });

  it('retorna tabela vigente com amount como float', (done) => {
    request(app)
      .get('/federation/' + FED_ID + '/financial/fees')
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body[0].fee_type).toBe('dojo');
        expect(typeof res.body[0].amount).toBe('number');
        done();
      });
  });
});

// ── Suite: PUT /financial/fees ───────────────────────────────────
describe('PUT /federation/:id/financial/fees (nova vigência)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    // Ordem: BEGIN → verifica federação → INSERT fee_1 → INSERT fee_2 → COMMIT
    mockClient.query
      .mockResolvedValueOnce({})  // BEGIN
      .mockResolvedValueOnce({    // SELECT federação
        rows: [{ id: FED_ID }],
      })
      .mockResolvedValueOnce({    // INSERT fee dojo
        rows: [{ id: 'fee-new-1', fee_type: 'dojo', size_tier: 'up_to_40', amount: 600.00, effective_from: '2027-01-01' }],
      })
      .mockResolvedValueOnce({    // INSERT fee cpf
        rows: [{ id: 'fee-new-2', fee_type: 'cpf', size_tier: null, amount: 150.00, effective_from: '2027-01-01' }],
      })
      .mockResolvedValueOnce({});  // COMMIT
  });

  it('cria nova vigência append-only e retorna os novos registros', (done) => {
    request(app)
      .put('/federation/' + FED_ID + '/financial/fees')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        effective_from: '2027-01-01',
        fees: [
          { fee_type: 'dojo', size_tier: 'up_to_40', amount: 600 },
          { fee_type: 'cpf', amount: 150 },
        ],
      })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(2);
        expect(res.body[0].effective_from).toBe('2027-01-01');
        done();
      });
  });

  it('retorna 422 sem effective_from', (done) => {
    request(app)
      .put('/federation/' + FED_ID + '/financial/fees')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ fees: [{ fee_type: 'dojo', amount: 600 }] })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });

  it('retorna 422 com fee_type invalido', (done) => {
    request(app)
      .put('/federation/' + FED_ID + '/financial/fees')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({
        effective_from: '2027-01-01',
        fees: [{ fee_type: 'invalido', amount: 100 }],
      })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ── Suite: charge → pix → confirm ───────────────────────────────
describe('POST charge → pix → confirm (dojô anuidade)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  // ── charge ──
  describe('POST /annuities/dojos/:dojoId/charge', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      const mockClient = { query: jest.fn(), release: jest.fn() };
      db.connect.mockResolvedValue(mockClient);

      // Fase F1: amount manual ainda cria 1 parcela única (via
      // karate_annuity_installments), pois as views canônicas exigem que
      // TODO header tenha >=1 parcela. Ordem real do handler: BEGIN →
      // verifica dojô → advisory lock → checa existing → INSERT header →
      // INSERT installment (seq 1) → INSERT transaction → UPDATE installment
      // (transaction_id) → SELECT installments (rollup) → UPDATE header
      // (rollup) → COMMIT.
      mockClient.query
        .mockResolvedValueOnce({})   // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: DOJO_ID, name: 'Dojô SP' }] }) // SELECT dojô
        .mockResolvedValueOnce({ rows: [] })  // advisory lock
        .mockResolvedValueOnce({ rows: [] })  // check existing annuity_history
        .mockResolvedValueOnce({ rows: [{ id: HIST_ID }] })  // INSERT header
        .mockResolvedValueOnce({              // INSERT installment (seq 1)
          rows: [{
            id: 'inst-uuid-001', annuity_id: HIST_ID, seq: 1, amount: 500,
            due_date: '2026-12-31', status: 'pending', paid_at: null,
            transaction_id: null, payment_method: null,
          }],
        })
        .mockResolvedValueOnce({ rows: [{ id: TX_ID }] })  // INSERT transaction
        .mockResolvedValueOnce({})  // UPDATE installment.transaction_id
        .mockResolvedValueOnce({              // SELECT installments (rollup)
          rows: [{
            id: 'inst-uuid-001', annuity_id: HIST_ID, seq: 1, amount: 500,
            due_date: '2026-12-31', status: 'pending', paid_at: null,
            transaction_id: TX_ID, payment_method: null,
          }],
        })
        .mockResolvedValueOnce({              // UPDATE header (rollup)
          rows: [{
            id: HIST_ID,
            dojo_id: DOJO_ID,
            reference_period: '2026',
            amount: 500.00,
            due_date: '2026-12-31',
            status: 'pending',
            paid_at: null,
            transaction_id: TX_ID,
          }],
        })
        .mockResolvedValueOnce({});  // COMMIT
    });

    it('cria cobrança e retorna status=due', (done) => {
      request(app)
        .post('/federation/' + FED_ID + '/financial/annuities/dojos/' + DOJO_ID + '/charge')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ amount: 500, due_date: '2026-12-31', reference_period: '2026' })
        .end((err, res) => {
          if (err) return done(err);
          expect(res.status).toBe(201);
          expect(res.body.status).toBe('due');
          expect(res.body.dojo_id).toBe(DOJO_ID);
          expect(res.body.transaction_id).toBe(TX_ID);
          expect(res.body.annuity_history_id).toBe(HIST_ID);
          done();
        });
    });

    it('retorna 422 sem amount', (done) => {
      jest.clearAllMocks();
      request(app)
        .post('/federation/' + FED_ID + '/financial/annuities/dojos/' + DOJO_ID + '/charge')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ due_date: '2026-12-31', reference_period: '2026' })
        .end((err, res) => {
          if (err) return done(err);
          expect(res.status).toBe(422);
          done();
        });
    });
  });

  // ── pix ──
  describe('POST /annuities/dojos/:dojoId/pix', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      // Sem db.connect: pix usa db.query
      // Ordem: busca annuity_history → busca existing intents → busca pix_config → INSERT intent
      db.query
        .mockResolvedValueOnce({  // busca annuity + dojo_name
          rows: [{
            id: HIST_ID,
            dojo_id: DOJO_ID,
            reference_period: '2026',
            amount: 500.00,
            due_date: '2026-12-31',
            status: 'pending',
            transaction_id: TX_ID,
            dojo_name: 'Dojô SP',
          }],
        })
        .mockResolvedValueOnce({ rows: [] })  // busca existing pending intents
        .mockResolvedValueOnce({ rows: [] })  // fetchFederationPixConfig (nenhuma config)
        .mockResolvedValueOnce({              // INSERT karate_payment_intents
          rows: [{ id: INTENT_ID }],
        });
    });

    it('cria PIX intent e retorna payload (mock quando sem config)', (done) => {
      request(app)
        .post('/federation/' + FED_ID + '/financial/annuities/dojos/' + DOJO_ID + '/pix')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ annuity_history_id: HIST_ID })
        .end((err, res) => {
          if (err) return done(err);
          expect(res.status).toBe(201);
          expect(res.body.intent_id).toBe(INTENT_ID);
          expect(res.body.payload).toBeTruthy();
          expect(res.body.provider).toBe('static_brcode');
          done();
        });
    });

    it('retorna 422 sem annuity_history_id', (done) => {
      jest.clearAllMocks();
      request(app)
        .post('/federation/' + FED_ID + '/financial/annuities/dojos/' + DOJO_ID + '/pix')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({})
        .end((err, res) => {
          if (err) return done(err);
          expect(res.status).toBe(422);
          done();
        });
    });
  });

  // ── confirm ──
  describe('POST /financial/payments/:intentId/confirm', () => {
    // Shared intent row returned by the SELECT inside the transaction.
    // cnpj + inscricao_municipal must be present for the NFS-e block to run.
    const INTENT_ROW = {
      id: INTENT_ID,
      payment_intent_id: 'static-dojo-xxx-2026',
      provider: 'static_brcode',
      status: 'pending',
      annuity_history_id: HIST_ID,
      transaction_id: TX_ID,
      dojo_id: DOJO_ID,
      reference_period: '2026',
      annuity_amount: 500.00,
      annuity_status: 'pending',
    };

    // Federation row with cnpj + inscricao_municipal so the NFS-e block fires.
    const FED_ROW = {
      id: FED_ID,
      name: 'Federação SP',
      legal_name: 'Federação SP Ltda',
      cnpj: '12345678000100',
      inscricao_municipal: '123456',
      email: 'fed@example.com',
      phone: '11999999999',
      focus_company_id: null,
      certificate_uploaded: false,
      tax_regime: 'simples',
      address_street: 'Rua Teste',
      address_number: '1',
      address_neighborhood: 'Centro',
      address_city: 'São Paulo',
      address_state: 'SP',
      address_zip: '01310100',
      ibge_code: '3550308',
    };

    // Dojo row for the NFS-e block (tomador)
    const DOJO_ROW = { name: 'Dojô SP', cnpj: '98765432000100' };

    beforeEach(() => {
      jest.clearAllMocks();

      // fiscal.emitNfse: simulates Nuvem Fiscal returning authorized status
      fiscal.emitNfse = jest.fn().mockResolvedValue({
        status: 'autorizado',
        id: 'nfse-focus-001',
        numero: '42',
        link_pdf: null,
        link_xml: null,
        mensagem: null,
      });

      // client.query mocks — handles the DB transaction (BEGIN … COMMIT)
      const mockClient = { query: jest.fn(), release: jest.fn() };
      db.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({})                      // BEGIN
        .mockResolvedValueOnce({ rows: [INTENT_ROW] })  // SELECT intent JOIN annuity_history
        .mockResolvedValueOnce({ rows: [] })             // UPDATE intent status=paid
        .mockResolvedValueOnce({ rows: [] })             // UPDATE annuity_history status=paid
        .mockResolvedValueOnce({ rows: [] })             // UPDATE transaction status=paid
        .mockResolvedValueOnce({});                      // COMMIT

      // db.query mocks — handles the best-effort NFS-e block (post-COMMIT)
      db.query
        .mockResolvedValueOnce({ rows: [FED_ROW] })   // SELECT companies (federation fiscal data)
        .mockResolvedValueOnce({ rows: [DOJO_ROW] })  // SELECT companies (dojo name + cnpj)
        .mockResolvedValueOnce({ rows: [] })           // SELECT nfe_documents idempotency check
        .mockResolvedValueOnce({ rows: [] })           // INSERT nfe_documents (pending)
        .mockResolvedValueOnce({ rows: [] });          // UPDATE nfe_documents (after fiscal.emitNfse)
    });

    it('confirma pagamento, retorna status=paid e nfse_ref', (done) => {
      request(app)
        .post('/federation/' + FED_ID + '/financial/payments/' + INTENT_ID + '/confirm')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ emit_nfse: true })
        .end((err, res) => {
          if (err) return done(err);
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('paid');
          // nfse_ref is a generated code like "nfse-karate-<8chars>-<timestamp>"
          expect(res.body.nfse_ref).toMatch(/^nfse-karate-/);
          expect(res.body.idempotent_hit).toBe(false);
          done();
        });
    });

    it('confirma pagamento e retorna status=paid mesmo sem emissão NFS-e (emit_nfse=false)', (done) => {
      // No NFS-e block runs, so no extra db.query calls needed — reset to empty
      jest.clearAllMocks();
      const mockClient2 = { query: jest.fn(), release: jest.fn() };
      db.connect.mockResolvedValue(mockClient2);

      mockClient2.query
        .mockResolvedValueOnce({})                      // BEGIN
        .mockResolvedValueOnce({ rows: [INTENT_ROW] })  // SELECT intent JOIN annuity_history
        .mockResolvedValueOnce({ rows: [] })             // UPDATE intent status=paid
        .mockResolvedValueOnce({ rows: [] })             // UPDATE annuity_history status=paid
        .mockResolvedValueOnce({ rows: [] })             // UPDATE transaction status=paid
        .mockResolvedValueOnce({});                      // COMMIT

      request(app)
        .post('/federation/' + FED_ID + '/financial/payments/' + INTENT_ID + '/confirm')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({ emit_nfse: false })
        .end((err, res) => {
          if (err) return done(err);
          expect(res.status).toBe(200);
          expect(res.body.status).toBe('paid');
          expect(res.body.nfse_ref).toBeNull();
          expect(res.body.idempotent_hit).toBe(false);
          done();
        });
    });

    it('retorna 409 quando intent já está paid', (done) => {
      jest.clearAllMocks();
      const mockClient = { query: jest.fn(), release: jest.fn() };
      db.connect.mockResolvedValue(mockClient);

      mockClient.query
        .mockResolvedValueOnce({})  // BEGIN
        .mockResolvedValueOnce({    // SELECT intent (já pago)
          rows: [{
            id: INTENT_ID,
            status: 'paid',
            annuity_history_id: HIST_ID,
            transaction_id: TX_ID,
          }],
        })
        .mockResolvedValueOnce({});  // ROLLBACK

      request(app)
        .post('/federation/' + FED_ID + '/financial/payments/' + INTENT_ID + '/confirm')
        .set('Authorization', 'Bearer ' + adminToken)
        .send({})
        .end((err, res) => {
          if (err) return done(err);
          expect(res.status).toBe(409);
          expect(res.body.idempotent_hit).toBe(true);
          done();
        });
    });
  });
});

// ── Suite: status do dojô via anuidades (annuity_history) ──────────
describe('getDojoAnnuityStatus (via DB mock)', () => {
  const { getDojoAnnuityStatus } = require('../src/services/karateFinanceService');

  beforeEach(() => { jest.clearAllMocks(); });

  it('retorna status=paid quando anuidade está paga', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: HIST_ID,
        dojo_id: DOJO_ID,
        reference_period: '2026',
        amount: 500,
        due_date: '2026-12-31',
        paid_at: '2026-03-01',
        status: 'paid',
        transaction_id: TX_ID,
      }],
    });
    const result = await getDojoAnnuityStatus(DOJO_ID, '2026');
    expect(result.status).toBe('paid');
    expect(result.days_overdue).toBe(0);
    expect(result.amount).toBe(500);
  });

  it('retorna status=overdue quando anuidade vencida há 45 dias', async () => {
    const past = new Date();
    past.setDate(past.getDate() - 45);
    db.query.mockResolvedValueOnce({
      rows: [{
        id: HIST_ID,
        dojo_id: DOJO_ID,
        reference_period: '2026',
        amount: 500,
        due_date: past.toISOString().split('T')[0],
        paid_at: null,
        status: 'pending',
        transaction_id: TX_ID,
      }],
    });
    const result = await getDojoAnnuityStatus(DOJO_ID, '2026');
    expect(result.status).toBe('overdue');
    expect(result.days_overdue).toBeGreaterThanOrEqual(44);
    expect(result.days_overdue).toBeLessThanOrEqual(46);
  });

  it('retorna status=no_charge quando não há cobrança', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await getDojoAnnuityStatus(DOJO_ID, '2026');
    expect(result.status).toBe('no_charge');
    expect(result.amount).toBe(0);
  });
});

// ── Suite: POST /financial/expenses ─────────────────────────────
describe('POST /federation/:id/financial/expenses', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'exp-uuid-001',
        category: 'expense_cost',
        amount: 250.00,
        description: 'Aluguel gîmnásio',
        due_date: null,
        reference_type: null,
        reference_id: null,
        status: 'pending',
        created_at: new Date().toISOString(),
      }],
    });
  });

  it('cria saída e retorna 201', (done) => {
    request(app)
      .post('/federation/' + FED_ID + '/financial/expenses')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ amount: 250, category: 'expense_cost', description: 'Aluguel gimnásio' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.category).toBe('expense_cost');
        expect(typeof res.body.amount).toBe('number');
        done();
      });
  });

  it('retorna 422 com category inválida', (done) => {
    jest.clearAllMocks();
    request(app)
      .post('/federation/' + FED_ID + '/financial/expenses')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ amount: 100, category: 'invalida', description: 'teste' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});
