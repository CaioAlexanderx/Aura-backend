// ============================================================
// AURA KARATÊ — P0 Hub de Campeonatos: FILA DE CONFERÊNCIA + PÚBLICO
//
// Cobertura:
//   (1) confirmIntent source_type='delegation_order' → pedido 'paid' +
//       cascata fee_paid nas entries do pedido (webhook do PIX direto).
//   (2) comprovante (dojô): upload → awaiting_confirmation; Canal B 403;
//       pedido já pago → 409.
//   (3) confirmar (federação, staffWrite): pedido 'paid' + cascata;
//       idempotência (já pago → 409 ALREADY_PAID).
//   (4) recusar: pedido 'cancelled' + entries/equipes 'withdrawn';
//       pedido pago não é recusável (409 PEDIDO_PAGO).
//   (5) publicar conferência/chaves liga e desliga o timestamp.
//   (6) público: conferência 404 PUBLICATION_PENDING antes de publicar;
//       publicada → inscritos agrupados por categoria (equipe com membros).
//   (7) público: chave kumite serializada com nomes (atleta e equipe).
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

const FED_ID = '11111111-1111-4111-8111-111111111111';
const DOJO_ID = '22222222-2222-4222-8222-222222222222';
const COMP_ID = '33333333-3333-4333-8333-333333333333';
const CAT_ID = '55555555-5555-4555-8555-555555555551';
const ORDER_ID = '88888888-8888-4888-8888-888888888888';
const INTENT_ID = '99999999-9999-4999-8999-999999999999';
const ENTRY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ENTRY_T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const TEAM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';

const SECRET = 'aura-test-secret-2026';
const tokenDojoA = jwt.sign(
  { type: 'access', id: 'user-sensei-1', name: 'Sensei', dojo_id: DOJO_ID, federation_id: FED_ID },
  SECRET, { expiresIn: '1h' }
);
const tokenDojoB = jwt.sign(
  { type: 'portal', scope: 'dojo_portal', dojo_id: DOJO_ID, federation_id: FED_ID },
  SECRET, { expiresIn: '1h' }
);
const tokenAdmin = jwt.sign(
  { id: 'user-fed-admin', role: 'admin', plan: 'expansao', name: 'Admin Fed' },
  SECRET, { expiresIn: '1h' }
);

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

// ── (1) confirmIntent delegation_order ──────────────────────
describe('confirmIntent — source_type=delegation_order', () => {
  it('pedido → paid + cascata fee_paid nas entries do pedido', async () => {
    const client = {
      query: jest.fn((sql, params) => {
        const s = String(sql);
        if (/^\s*(BEGIN|COMMIT|ROLLBACK$)/i.test(s)) return Promise.resolve({});
        if (/SAVEPOINT|RELEASE|ROLLBACK TO/i.test(s)) return Promise.resolve({});
        if (/FROM karate_payment_intents kpi/i.test(s)) {
          return Promise.resolve({
            rows: [{
              id: INTENT_ID, federation_id: FED_ID, status: 'pending',
              transaction_id: null, annuity_history_id: null,
              source_type: 'delegation_order', source_id: ORDER_ID,
              dojo_id: null, practitioner_id: null,
            }],
          });
        }
        if (/UPDATE karate_payment_intents/i.test(s)) return Promise.resolve({ rowCount: 1 });
        if (/UPDATE karate_delegation_orders/i.test(s)) {
          expect(params[0]).toBe(ORDER_ID);
          return Promise.resolve({ rowCount: 1 });
        }
        if (/UPDATE karate_competition_entries/i.test(s)) {
          expect(s).toMatch(/delegation_order_id = \$1/);
          expect(params[0]).toBe(ORDER_ID);
          return Promise.resolve({ rowCount: 3 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      release: jest.fn(),
    };
    db.connect.mockResolvedValue(client);

    const svc = require('../src/services/karatePaymentService');
    const out = await svc.confirmIntent(INTENT_ID, { source: 'webhook', emitNfse: false });
    expect(out.code).toBe('OK');
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /UPDATE karate_delegation_orders/i.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE karate_competition_entries/i.test(s))).toBe(true);
    // Não encosta em anuidade nem nas tabelas de inscrição individual.
    expect(sqls.some((s) => /UPDATE karate_annuity_installments|UPDATE karate_belt_exam_candidates/i.test(s))).toBe(false);
  });
});

// ── (2) comprovante (dojô) ──────────────────────────────────
function buildDojoApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/federation/:id', require('../src/routes/karateDelegations'));
  return app;
}

function mockReceiptPool({ orderStatus = 'awaiting_payment' } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/karate_dojo_linked_at/i.test(s)) {
      return Promise.resolve({ rows: [{ karate_dojo_linked_at: '2026-01-01T00:00:00Z' }] });
    }
    if (s.includes('-- p0d:receipt-load-order')) {
      return Promise.resolve({ rows: [{ id: ORDER_ID, status: orderStatus }] });
    }
    if (s.includes('-- p0d:receipt-update-order')) {
      return Promise.resolve({ rows: [{ id: ORDER_ID, status: 'awaiting_confirmation', receipt_url: 'https://r2/x.pdf', receipt_uploaded_at: '2026-08-20T12:00:00Z' }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('POST /dojo/delegations/:orderId/receipt', () => {
  it('upload válido → awaiting_confirmation (R2 em modo mock no test env)', async () => {
    mockReceiptPool({});
    const res = await request(buildDojoApp())
      .post(`/federation/${FED_ID}/dojo/delegations/${ORDER_ID}/receipt`)
      .set('Authorization', 'Bearer ' + tokenDojoA)
      .send({ file_base64: Buffer.from('comprovante').toString('base64'), content_type: 'application/pdf' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('awaiting_confirmation');
    expect(res.body.order.receipt_url).toBeTruthy();
  });

  it('pedido já pago → 409; Canal B → 403; tipo inválido → 422', async () => {
    mockReceiptPool({ orderStatus: 'paid' });
    const paid = await request(buildDojoApp())
      .post(`/federation/${FED_ID}/dojo/delegations/${ORDER_ID}/receipt`)
      .set('Authorization', 'Bearer ' + tokenDojoA)
      .send({ file_base64: 'YWJj', content_type: 'application/pdf' });
    expect(paid.status).toBe(409);

    const portal = await request(buildDojoApp())
      .post(`/federation/${FED_ID}/dojo/delegations/${ORDER_ID}/receipt`)
      .set('Authorization', 'Bearer ' + tokenDojoB)
      .send({ file_base64: 'YWJj', content_type: 'application/pdf' });
    expect(portal.status).toBe(403);
    expect(portal.body.code).toBe('PORTAL_READ_ONLY');

    mockReceiptPool({});
    const badType = await request(buildDojoApp())
      .post(`/federation/${FED_ID}/dojo/delegations/${ORDER_ID}/receipt`)
      .set('Authorization', 'Bearer ' + tokenDojoA)
      .send({ file_base64: 'YWJj', content_type: 'application/zip' });
    expect(badType.status).toBe(422);
    expect(badType.body.code).toBe('TIPO_INVALIDO');
  });
});

// ── (3)(4)(5) federação: confirmar / recusar / publicar ─────
function buildFedApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateCompetitionSetup'));
  return app;
}

function makeFedClient({ orderStatus = 'awaiting_confirmation' } = {}) {
  const query = jest.fn((sql, params) => {
    const s = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({});
    if (s.includes('-- p0d:confirm-load-order') || s.includes('-- p0d:reject-load-order')) {
      return Promise.resolve({ rows: [{ id: ORDER_ID, status: orderStatus, dojo_id: DOJO_ID, total_amount: 250 }] });
    }
    if (s.includes('-- p0d:confirm-order')) return Promise.resolve({ rowCount: 1 });
    if (s.includes('-- p0d:confirm-cascade')) return Promise.resolve({ rowCount: 4 });
    if (s.includes('-- p0d:reject-order')) return Promise.resolve({ rowCount: 1 });
    if (s.includes('-- p0d:reject-withdraw-entries')) return Promise.resolve({ rowCount: 4 });
    if (s.includes('-- p0d:reject-withdraw-teams')) return Promise.resolve({ rowCount: 1 });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { query, release: jest.fn() };
}

function mockFedPool() {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/FROM karate_competitions WHERE id/i.test(s)) {
      return Promise.resolve({ rows: [{ id: COMP_ID, status: 'open' }] });
    }
    if (/UPDATE karate_competitions/i.test(s) && /conference_published_at|brackets_published_at/.test(s)) {
      const col = /conference_published_at/.test(s) ? 'conference_published_at' : 'brackets_published_at';
      const publishing = /NOW\(\)/.test(s.split('updated_at')[0]);
      return Promise.resolve({ rows: [{ id: COMP_ID, [col]: publishing ? '2026-08-20T12:00:00Z' : null }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('federação — confirmar/recusar/publicar', () => {
  it('(3) confirmar → paid + cascata (entries_marked_paid)', async () => {
    mockFedPool();
    const client = makeFedClient({});
    db.connect.mockResolvedValue(client);
    const res = await request(buildFedApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/delegations/${ORDER_ID}/confirm`)
      .set('Authorization', 'Bearer ' + tokenAdmin)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    expect(res.body.entries_marked_paid).toBe(4);
  });

  it('(3) já pago → 409 ALREADY_PAID (idempotência)', async () => {
    mockFedPool();
    db.connect.mockResolvedValue(makeFedClient({ orderStatus: 'paid' }));
    const res = await request(buildFedApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/delegations/${ORDER_ID}/confirm`)
      .set('Authorization', 'Bearer ' + tokenAdmin)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_PAID');
  });

  it('(4) recusar → cancelled + entries/equipes withdrawn; pago não recusa', async () => {
    mockFedPool();
    const client = makeFedClient({});
    db.connect.mockResolvedValue(client);
    const res = await request(buildFedApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/delegations/${ORDER_ID}/reject`)
      .set('Authorization', 'Bearer ' + tokenAdmin)
      .send({ reason: 'Comprovante ilegível' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(res.body.entries_withdrawn).toBe(4);
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('-- p0d:reject-withdraw-teams'))).toBe(true);

    db.connect.mockResolvedValue(makeFedClient({ orderStatus: 'paid' }));
    const paid = await request(buildFedApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/delegations/${ORDER_ID}/reject`)
      .set('Authorization', 'Bearer ' + tokenAdmin)
      .send({});
    expect(paid.status).toBe(409);
    expect(paid.body.code).toBe('PEDIDO_PAGO');
  });

  it('(5) publicar conferência liga o timestamp; published:false desliga', async () => {
    mockFedPool();
    const on = await request(buildFedApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/publish-conference`)
      .set('Authorization', 'Bearer ' + tokenAdmin)
      .send({});
    expect(on.status).toBe(200);
    expect(on.body.conference_published_at).toBeTruthy();

    const off = await request(buildFedApp())
      .post(`/federation/${FED_ID}/competitions/${COMP_ID}/publish-brackets`)
      .set('Authorization', 'Bearer ' + tokenAdmin)
      .send({ published: false });
    expect(off.status).toBe(200);
    expect(off.body.brackets_published_at).toBeNull();
  });
});

// ── (6)(7) público ──────────────────────────────────────────
function buildPublicApp() {
  const app = express();
  app.use(express.json());
  app.use('/public/karate', require('../src/routes/karateCompetitionsPublic'));
  return app;
}

function mockPublicPool({ conferencePublished = true, bracketsPublished = true } = {}) {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/FROM digital_channel_config/i.test(s)) return Promise.resolve({ rows: [{ company_id: FED_ID }] });
    if (/FROM companies WHERE id/i.test(s)) return Promise.resolve({ rows: [{ id: FED_ID, name: 'Federação Teste', logo: null }] });
    if (/FROM karate_competitions/i.test(s)) {
      return Promise.resolve({
        rows: [{
          id: COMP_ID, name: 'Paulista 2026', season: 2026, event_date: '2026-08-22',
          location: 'Barueri', status: 'open',
          conference_published_at: conferencePublished ? '2026-08-10T12:00:00Z' : null,
          brackets_published_at: bracketsPublished ? '2026-08-15T12:00:00Z' : null,
          rectification_deadline: '2026-07-31',
        }],
      });
    }
    // Conferência: entries com atleta e equipe
    if (/FROM karate_competition_entries e[\s\S]*JOIN karate_competition_categories cat/i.test(s) && /display_name/.test(s)) {
      return Promise.resolve({
        rows: [
          { id: ENTRY_A, category_id: CAT_ID, student_id: 'stu-1', team_id: null, category_name: 'Kata Mirim', modality: 'kata', category_sex: 'F', group_label: 'Grupo 1', division_id: 'div-1', division_name: 'Principal', display_name: 'Atleta A', dojo_name: 'Kondei', belt_name: 'Verde' },
          { id: ENTRY_T, category_id: CAT_ID, student_id: null, team_id: TEAM_ID, category_name: 'Kata Mirim', modality: 'kata', category_sex: 'F', group_label: 'Grupo 1', division_id: 'div-1', division_name: 'Principal', display_name: 'Kondei A', dojo_name: 'Kondei', belt_name: null },
        ],
      });
    }
    if (/FROM karate_competition_team_members tm/i.test(s)) {
      return Promise.resolve({ rows: [
        { team_id: TEAM_ID, role: 'titular', name: 'Membro 1' },
        { team_id: TEAM_ID, role: 'reserva', name: 'Membro 2' },
      ] });
    }
    if (/FROM karate_competition_categories\s+cat[\s\S]*LEFT JOIN karate_brackets/i.test(s)) {
      return Promise.resolve({ rows: [{ category_id: CAT_ID, category_name: 'Kumite Adulto', modality: 'kumite', group_label: null, division_name: 'Principal', bracket_id: 'br-1', bracket_status: 'locked', entry_count: 2 }] });
    }
    if (/SELECT id, name, modality FROM karate_competition_categories/i.test(s)) {
      return Promise.resolve({ rows: [{ id: CAT_ID, name: 'Kumite Adulto', modality: 'kumite' }] });
    }
    if (/FROM karate_brackets WHERE category_id/i.test(s)) {
      return Promise.resolve({ rows: [{ id: 'br-1', category_id: CAT_ID, modality: 'kumite', status: 'locked', draw_seed: 's', options: {} }] });
    }
    if (/FROM karate_bracket_matches/i.test(s)) {
      return Promise.resolve({
        rows: [
          { bracket_id: 'br-1', round: 0, slot: 0, bracket_kind: 'main', aka_entry_id: ENTRY_A, shiro_entry_id: ENTRY_T, winner_entry_id: ENTRY_A, is_bye: false, aka_score: 3, shiro_score: 1 },
        ],
      });
    }
    if (/FROM karate_competition_entries e[\s\S]*WHERE e\.category_id/i.test(s)) {
      return Promise.resolve({ rows: [
        { id: ENTRY_A, name: 'Atleta A', dojo_name: 'Kondei' },
        { id: ENTRY_T, name: 'Kondei A', dojo_name: 'Kondei' },
      ] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('público — conferência e chaves', () => {
  it('(6) não publicada → 404 PUBLICATION_PENDING', async () => {
    mockPublicPool({ conferencePublished: false });
    const res = await request(buildPublicApp())
      .get(`/public/karate/fed-teste/competitions/${COMP_ID}/conference`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PUBLICATION_PENDING');
  });

  it('(6) publicada → agrupada por categoria, equipe com membros, dados mínimos', async () => {
    mockPublicPool({});
    const res = await request(buildPublicApp())
      .get(`/public/karate/fed-teste/competitions/${COMP_ID}/conference`);
    expect(res.status).toBe(200);
    expect(res.body.total_entries).toBe(2);
    expect(res.body.categories).toHaveLength(1);
    const cat = res.body.categories[0];
    expect(cat.division_name).toBe('Principal');
    expect(cat.group_label).toBe('Grupo 1');
    const team = cat.entries.find((e) => e.is_team);
    expect(team.name).toBe('Kondei A');
    expect(team.team_members).toHaveLength(2);
    // LGPD: só nome/dojô/faixa — nunca CPF/nascimento.
    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/cpf|birth_date/i);
  });

  it('(7) chave kumite pública serializada com nomes e placar', async () => {
    mockPublicPool({});
    const res = await request(buildPublicApp())
      .get(`/public/karate/fed-teste/competitions/${COMP_ID}/categories/${CAT_ID}/bracket`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('locked');
    const match = res.body.rounds[0][0];
    expect(match.aka.name).toBe('Atleta A');
    expect(match.shiro.name).toBe('Kondei A'); // equipe pelo nome
    expect(match.winner_entry_id).toBe(ENTRY_A);
    expect(match.aka_score).toBe(3);
    expect(res.body.champion.name).toBe('Atleta A');
  });

  it('(7) chaves não publicadas → 404 no índice e na chave', async () => {
    mockPublicPool({ bracketsPublished: false });
    const idx = await request(buildPublicApp())
      .get(`/public/karate/fed-teste/competitions/${COMP_ID}/brackets`);
    expect(idx.status).toBe(404);
    expect(idx.body.code).toBe('PUBLICATION_PENDING');
    const bracket = await request(buildPublicApp())
      .get(`/public/karate/fed-teste/competitions/${COMP_ID}/categories/${CAT_ID}/bracket`);
    expect(bracket.status).toBe(404);
  });
});
