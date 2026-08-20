// ============================================================
// AURA KARATÊ — P0 Aura Pay: conciliação de pagamento de INSCRIÇÃO DE EVENTO
//
// Dois bugs históricos (dossiê do hub de eventos):
//   A) confirmIntent só tratava anuidade — PIX pago de inscrição de evento
//      confirmava o intent e deixava fee_paid=false para sempre (o
//      pending_payment_count do bracket nunca zerava sozinho).
//   B) resolvePaymentStatuses casava payment_intent_id contra o TXID cru
//      (`insc-<id>`), mas a coluna guarda o id do PROVIDER
//      (`static-<txid>` / id Asaas) — payment_status saía null p/ todos.
//
// Cobertura:
//   (1) confirmIntent event_registration → intent paid + fee_paid=true na
//       PRIMEIRA tabela que tiver a inscrição (para na primeira que acerta).
//   (2) tabela ausente (42P01) não envenena a transação (SAVEPOINT) — cai
//       para a próxima tabela.
//   (3) nenhuma tabela tem a inscrição → confirm ainda retorna OK (intent
//       pago; baixa órfã é log, não 500).
//   (4) regressão: intent de anuidade (dojo_annuity) continua baixando a
//       PARCELA e NÃO encosta nas tabelas de inscrição.
//   (5) POST /:slug/lookup — registrations[].payment_status vem do intent
//       casado por source_type='event_registration' + source_id (não txid).
//   (6) colunas da 213 ausentes (42703) → payment_status null, lookup 200.
//
// Mocks despachados por âncora de SQL (regex), nunca por posição na fila.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');

const FED_ID = 'fed-uuid-p0pay';
const INTENT_ID = 'intent-uuid-p0pay';
const INSC_ID = 'insc-uuid-p0pay';

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ── helper: client transacional fake despachado por SQL ─────────────
function makeConfirmClient({ intentRow, tableBehavior }) {
  const query = jest.fn((sql, params) => {
    const s = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK$)/i.test(s)) return Promise.resolve({});
    if (/SAVEPOINT|RELEASE|ROLLBACK TO/i.test(s)) return Promise.resolve({});
    if (/FROM karate_payment_intents kpi/i.test(s)) return Promise.resolve({ rows: [intentRow] });
    if (/UPDATE karate_payment_intents/i.test(s)) return Promise.resolve({ rowCount: 1 });
    if (/UPDATE karate_annuity_installments/i.test(s)) return Promise.resolve({ rowCount: 1 });
    if (/UPDATE karate_dojo_annuity_history/i.test(s)) return Promise.resolve({ rowCount: 1 });
    if (/UPDATE transactions/i.test(s)) return Promise.resolve({ rowCount: 1 });
    for (const [anchor, behavior] of Object.entries(tableBehavior || {})) {
      if (s.includes(anchor)) {
        if (behavior === '42P01') {
          const e = new Error(`relation "${anchor}" does not exist`);
          e.code = '42P01';
          return Promise.reject(e);
        }
        return Promise.resolve({ rowCount: behavior });
      }
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { query, release: jest.fn() };
}

const eventIntent = {
  id: INTENT_ID,
  federation_id: FED_ID,
  status: 'pending',
  transaction_id: null,
  annuity_history_id: null,
  source_type: 'event_registration',
  source_id: INSC_ID,
  dojo_id: null,
  practitioner_id: null,
};

describe('confirmIntent — source_type=event_registration (bug A)', () => {
  it('(1) baixa fee_paid na primeira tabela que tem a inscrição e PARA', async () => {
    const client = makeConfirmClient({
      intentRow: eventIntent,
      tableBehavior: {
        'UPDATE karate_competition_entries': 1, // acha aqui
        'UPDATE karate_belt_exam_candidates': 1,
        'UPDATE karate_event_enrollments': 1,
      },
    });
    db.connect.mockResolvedValue(client);

    const svc = require('../src/services/karatePaymentService');
    const out = await svc.confirmIntent(INTENT_ID, { source: 'webhook', emitNfse: false });

    expect(out.code).toBe('OK');
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    const compCall = client.query.mock.calls.find((c) => /UPDATE karate_competition_entries/i.test(String(c[0])));
    expect(compCall).toBeTruthy();
    expect(compCall[0]).toMatch(/fee_paid = true/);
    expect(compCall[1]).toEqual([INSC_ID]);
    // Parou na primeira: exame/curso NÃO foram tentados.
    expect(sqls.some((s) => /UPDATE karate_belt_exam_candidates/i.test(s))).toBe(false);
    expect(sqls.some((s) => /UPDATE karate_event_enrollments/i.test(s))).toBe(false);
    // E não encostou em anuidade (o SELECT do intent tem LEFT JOIN no
    // header de anuidade — só os UPDATEs contam como "encostar").
    expect(sqls.some((s) => /UPDATE karate_annuity_installments|UPDATE karate_dojo_annuity_history/i.test(s))).toBe(false);
  });

  it('(2) 42P01 na primeira tabela → ROLLBACK TO SAVEPOINT e cai para a segunda', async () => {
    const client = makeConfirmClient({
      intentRow: eventIntent,
      tableBehavior: {
        'UPDATE karate_competition_entries': '42P01',
        'UPDATE karate_belt_exam_candidates': 1,
      },
    });
    db.connect.mockResolvedValue(client);

    const svc = require('../src/services/karatePaymentService');
    const out = await svc.confirmIntent(INTENT_ID, { source: 'webhook', emitNfse: false });

    expect(out.code).toBe('OK');
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /ROLLBACK TO SAVEPOINT sp_event_fee/i.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE karate_belt_exam_candidates/i.test(s))).toBe(true);
    // A transação seguiu viva até o COMMIT.
    expect(sqls.some((s) => /^\s*COMMIT/i.test(s))).toBe(true);
  });

  it('(3) inscrição em nenhuma tabela → confirm ainda OK (não vira 500)', async () => {
    const client = makeConfirmClient({
      intentRow: eventIntent,
      tableBehavior: {
        'UPDATE karate_competition_entries': 0,
        'UPDATE karate_belt_exam_candidates': 0,
        'UPDATE karate_event_enrollments': 0,
      },
    });
    db.connect.mockResolvedValue(client);

    const svc = require('../src/services/karatePaymentService');
    const out = await svc.confirmIntent(INTENT_ID, { source: 'webhook', emitNfse: false });
    expect(out.code).toBe('OK');
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    // Tentou as três, na ordem.
    expect(sqls.filter((s) => /fee_paid = true/i.test(s)).length).toBe(3);
  });

  it('(4) regressão: intent de PARCELA de anuidade não encosta nas inscrições', async () => {
    const client = makeConfirmClient({
      intentRow: {
        ...eventIntent,
        source_type: 'dojo_annuity',
        source_id: 'inst-uuid-1',
        annuity_history_id: 'hist-uuid-1',
        annuity_status: 'pending',
        amount: 500,
      },
      tableBehavior: {},
    });
    db.connect.mockResolvedValue(client);

    const svc = require('../src/services/karatePaymentService');
    const out = await svc.confirmIntent(INTENT_ID, { source: 'webhook', emitNfse: false });
    expect(out.code).toBe('OK');
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /UPDATE karate_annuity_installments/i.test(s))).toBe(true);
    expect(sqls.some((s) => /fee_paid = true/i.test(s))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════
// (5)(6) POST /public/karate/:slug/lookup — payment_status por source_id
// ════════════════════════════════════════════════════════════════════
const express = require('express');
const request = require('supertest');

function buildPublicApp() {
  const app = express();
  app.use(express.json());
  app.use('/public/karate', require('../src/routes/karatePublic'));
  return app;
}

// Dispatcher de pool para o fluxo do lookup (âncoras de SQL).
function mockLookupPool({ intentsBehavior }) {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/FROM digital_channel_config/i.test(s)) return Promise.resolve({ rows: [{ company_id: FED_ID }] });
    if (/FROM companies WHERE id/i.test(s)) return Promise.resolve({ rows: [{ id: FED_ID, name: 'Federação Teste', slug: 'fed-teste', logo: null }] });
    if (/FROM customers/i.test(s)) return Promise.resolve({ rows: [{ id: 'stu-uuid-1', name: 'Atleta Teste', karate_registration_number: '010-Y', dojo_id: null, email: null, phone: null }] });
    if (/FROM karate_current_belt/i.test(s)) return Promise.resolve({ rows: [] });
    // Legado active_enrollments (têm be.event_date / ke.event_date no SELECT)
    if (/karate_belt_exam_candidates ec[\s\S]*be\.event_date/i.test(s)) return Promise.resolve({ rows: [] });
    if (/karate_event_enrollments ee[\s\S]*ke\.event_date/i.test(s)) return Promise.resolve({ rows: [] });
    // A2 resolveActiveRegistrations (têm created_at no SELECT)
    if (/FROM karate_belt_exam_candidates ec/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM karate_competition_entries en/i.test(s)) {
      return Promise.resolve({
        rows: [{ id: INSC_ID, status: 'registered', created_at: '2026-08-01T00:00:00Z', event_id: 'comp-uuid-1', event_name: 'Paulista 2026', category_name: 'Kata Mirim' }],
      });
    }
    if (/FROM karate_event_enrollments ee/i.test(s)) return Promise.resolve({ rows: [] });
    if (/FROM karate_payment_intents/i.test(s)) {
      if (intentsBehavior === '42703') {
        const e = new Error('column "source_type" does not exist');
        e.code = '42703';
        return Promise.reject(e);
      }
      // (5) valida a FORMA da query: vínculo canônico por source, não txid.
      expect(s).toMatch(/source_type = 'event_registration'/);
      expect(s).toMatch(/source_id = ANY\(\$2::uuid\[\]\)/);
      expect(params[0]).toBe(FED_ID);
      expect(params[1]).toEqual([INSC_ID]);
      return Promise.resolve({
        rows: [
          { source_id: INSC_ID, status: 'pending', created_at: '2026-08-01T10:00:00Z' },
          { source_id: INSC_ID, status: 'paid', created_at: '2026-08-01T09:00:00Z' },
        ],
      });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('POST /public/karate/:slug/lookup — payment_status (bug B)', () => {
  let app;
  beforeAll(() => { app = buildPublicApp(); });

  it("(5) casa por source_id e 'paid' vence sobre intent pendente mais novo", async () => {
    mockLookupPool({});
    const res = await request(app)
      .post('/public/karate/fed-teste/lookup')
      .send({ identifier: 'atleta@teste.com' });

    expect(res.status).toBe(200);
    expect(res.body.registrations).toHaveLength(1);
    expect(res.body.registrations[0].kind).toBe('competition');
    expect(res.body.registrations[0].payment_status).toBe('paid');
  });

  it('(6) colunas da 213 ausentes (42703) → payment_status null, lookup segue 200', async () => {
    mockLookupPool({ intentsBehavior: '42703' });
    const res = await request(app)
      .post('/public/karate/fed-teste/lookup')
      .send({ identifier: 'atleta@teste.com' });

    expect(res.status).toBe(200);
    expect(res.body.registrations).toHaveLength(1);
    expect(res.body.registrations[0].payment_status).toBeNull();
  });
});
