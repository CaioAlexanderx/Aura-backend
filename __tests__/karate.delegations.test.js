// ============================================================
// AURA KARATÊ — P0 Hub de Campeonatos: DELEGAÇÃO do dojô (rotas)
//
// Cobertura:
//   (1) quote (dry-run): carrinho JKA completo — taxa única por atleta,
//       equipe bundle, isenções — com skips (não federado) e aviso de
//       category_fit; NADA é gravado.
//   (2) submit: transação grava pedido + entries individuais + equipe
//       (linha + membros + UMA entry por categoria), tudo amarrado ao
//       delegation_order_id; 201 com quote-snapshot.
//   (3) cota por clube estourada → 422 QUOTA_EXCEEDED e nada gravado.
//   (4) Canal B (portal) → 403 PORTAL_READ_ONLY nas escritas.
//   (5) dojô não conectado → 409 DOJO_NAO_CONECTADO no submit; vitrine
//       devolve 200 { not_linked: true }.
//   (6) migração 294 pendente (42P01 no insert) → 503 SCHEMA_PENDING.
//
// Mocks despachados por âncora `-- p0d:` (regex), nunca por posição.
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
const DIV_ID = '44444444-4444-4444-8444-444444444444';
const CAT_KATA = '55555555-5555-4555-8555-555555555551';
const CAT_KUMITE = '55555555-5555-4555-8555-555555555552';
const CAT_TEAM = '55555555-5555-4555-8555-555555555553';
const STU_A = '66666666-6666-4666-8666-666666666661'; // 13 anos, federado
const STU_B = '66666666-6666-4666-8666-666666666662'; // 18 anos, federado
const STU_LOCAL = '66666666-6666-4666-8666-666666666663'; // NÃO federado
const STU_C = '66666666-6666-4666-8666-666666666664'; // federado (equipe)
const PRAC_A = '77777777-7777-4777-8777-777777777771';
const PRAC_B = '77777777-7777-4777-8777-777777777772';
const PRAC_C = '77777777-7777-4777-8777-777777777774';
const ORDER_ID = '88888888-8888-4888-8888-888888888888';

const SECRET = 'aura-test-secret-2026';
const tokenA = jwt.sign(
  { type: 'access', id: 'user-sensei-1', name: 'Sensei Kondei', dojo_id: DOJO_ID, federation_id: FED_ID },
  SECRET, { expiresIn: '1h' }
);
const tokenB = jwt.sign(
  { type: 'portal', scope: 'dojo_portal', dojo_id: DOJO_ID, federation_id: FED_ID },
  SECRET, { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateDelegations'));
  return app;
}

const JKA_PRICING = {
  individual: { mode: 'per_athlete', bands: [{ max_age: 14, amount: 150 }, { amount: 180 }] },
  team: { per_prova: 125, bundle_both: 250 },
  exemptions: { officials_per_exemption: 2, max_exemptions: 3 },
};

const STUDENTS = {
  [STU_A]: { id: STU_A, full_name: 'Atleta A', practitioner_id: PRAC_A, birth_date: '2012-09-01', gender: 'F', customer_dojo_id: DOJO_ID },
  [STU_B]: { id: STU_B, full_name: 'Atleta B', practitioner_id: PRAC_B, birth_date: '2008-01-15', gender: 'M', customer_dojo_id: DOJO_ID },
  [STU_LOCAL]: { id: STU_LOCAL, full_name: 'Aluno Local', practitioner_id: null, birth_date: null, gender: null, customer_dojo_id: null },
  [STU_C]: { id: STU_C, full_name: 'Atleta C', practitioner_id: PRAC_C, birth_date: '2007-03-10', gender: 'M', customer_dojo_id: DOJO_ID },
};

// opts: { linked, existingEntries, individualCounts, divisionRules,
//         extraCategories (triagem: categorias adicionais), beltRows
//         (triagem: linhas de karate_current_belt), vitrineRows (linhas
//         da vitrine), vitrineOrdersMissing (42P01 quando o SQL da
//         vitrine referencia karate_delegation_orders — 294 pendente) }
function mockPool(opts = {}) {
  const {
    linked = true,
    existingEntries = [],
    individualCounts = [],
    divisionRules = { max_individual_per_dojo_per_category: 7, max_teams_per_dojo_per_category: 1 },
    extraCategories = [],
    beltRows = [],
    vitrineRows = [{ id: COMP_ID, name: 'Paulista 2026', season: 2026, event_date: '2026-08-22', location: 'Barueri', status: 'open', fee_amount: null, pricing_config: JKA_PRICING, rectification_deadline: '2026-07-31' }],
    vitrineOrdersMissing = false,
  } = opts;

  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/karate_dojo_linked_at/i.test(s)) {
      return Promise.resolve({ rows: [{ karate_dojo_linked_at: linked ? '2026-01-01T00:00:00Z' : null }] });
    }
    if (s.includes('-- p0d:list-open-competitions')) {
      if (vitrineOrdersMissing && s.includes('karate_delegation_orders')) {
        const e = new Error('relation "karate_delegation_orders" does not exist');
        e.code = '42P01';
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: vitrineRows });
    }
    if (s.includes('-- p0d:list-divisions')) {
      return Promise.resolve({ rows: [{ id: DIV_ID, competition_id: COMP_ID, name: 'Principal', sort_order: 0, rules: divisionRules }] });
    }
    if (s.includes('-- p0d:load-competition')) {
      return Promise.resolve({ rows: [{ id: COMP_ID, federation_id: FED_ID, name: 'Paulista 2026', status: 'open', event_date: '2026-08-22', fee_amount: null, pricing_config: JKA_PRICING }] });
    }
    if (s.includes('-- p0d:list-categories')) {
      return Promise.resolve({
        rows: [
          { id: CAT_KATA, name: 'Kata Mirim Fem', modality: 'kata', min_age: 12, max_age: 14, belt_min: null, belt_max: null, sex: 'F', weight_class: null, max_entries: null, fee_amount: null, division_id: DIV_ID, group_label: 'Grupo 1', entry_count: 0 },
          { id: CAT_KUMITE, name: 'Kumite Adulto Masc', modality: 'kumite', min_age: 18, max_age: null, belt_min: null, belt_max: null, sex: 'M', weight_class: null, max_entries: null, fee_amount: null, division_id: DIV_ID, group_label: null, entry_count: 0 },
          { id: CAT_TEAM, name: 'Kata Equipe Adulto Masc', modality: 'team_kata', min_age: null, max_age: null, belt_min: null, belt_max: null, sex: 'M', weight_class: null, max_entries: null, fee_amount: null, division_id: DIV_ID, group_label: null, entry_count: 0 },
          ...extraCategories,
        ],
      });
    }
    if (s.includes('-- p0d:load-students')) {
      const ids = params[1] || [];
      return Promise.resolve({ rows: ids.map((id) => STUDENTS[id]).filter(Boolean) });
    }
    if (s.includes('-- p0d:current-belts')) return Promise.resolve({ rows: beltRows });
    if (s.includes('-- p0d:existing-entries')) return Promise.resolve({ rows: existingEntries });
    if (s.includes('-- p0d:dojo-individual-counts')) return Promise.resolve({ rows: individualCounts });
    if (s.includes('-- p0d:dojo-team-counts')) return Promise.resolve({ rows: [] });
    if (s.includes('-- p0d:division-rules')) {
      return Promise.resolve({ rows: [{ id: DIV_ID, rules: divisionRules }] });
    }
    if (s.includes('-- p0d:list-orders')) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
}

function makeSubmitClient({ failInsertOrder } = {}) {
  const query = jest.fn((sql, params) => {
    const s = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({});
    if (/pg_advisory_xact_lock/i.test(s)) return Promise.resolve({});
    if (s.includes('-- p0d:insert-order')) {
      if (failInsertOrder === '42P01') {
        const e = new Error('relation "karate_delegation_orders" does not exist');
        e.code = '42P01';
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: [{ id: ORDER_ID, status: params[3], payment_mode: params[4], total_amount: params[6], created_at: '2026-08-20T12:00:00Z' }] });
    }
    if (s.includes('-- p0d:insert-entry')) return Promise.resolve({ rows: [{ id: `entry-${Math.random().toString(36).slice(2, 8)}` }] });
    if (s.includes('-- p0d:insert-team-entry')) return Promise.resolve({ rows: [{ id: `tentry-${Math.random().toString(36).slice(2, 8)}` }] });
    if (s.includes('-- p0d:insert-team-member')) return Promise.resolve({ rows: [] });
    if (s.includes('-- p0d:insert-team')) return Promise.resolve({ rows: [{ id: 'team-uuid-1' }] });
    return Promise.resolve({ rows: [] });
  });
  return { query, release: jest.fn() };
}

afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

const QUOTE_BODY = {
  athletes: [
    { student_id: STU_A, category_ids: [CAT_KATA] },
    { student_id: STU_B, category_ids: [CAT_KUMITE] },
    { student_id: STU_LOCAL, category_ids: [CAT_KATA] }, // não federado → skip
  ],
  teams: [
    { name: 'Kondei A', sex: 'M', category_ids: [CAT_TEAM, CAT_KUMITE], titular_ids: [STU_B, STU_C], reserve_ids: [] },
  ],
  officials_count: 4,
};

describe('POST /dojo/competitions/:cid/delegation/quote — dry-run', () => {
  it('(1) carrinho JKA: taxa única + bundle de equipe + isenções; skip do não federado; aviso de fit; nada gravado', async () => {
    mockPool({});
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/delegation/quote`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send(QUOTE_BODY);

    expect(res.status).toBe(200);
    // Atleta A (13 → 150) + Atleta B (18 → 180) + equipe 2 provas (250)
    expect(res.body.quote.subtotal).toBe(580);
    // 4 oficiais → 2 isenções → abate 150 + 180
    expect(res.body.quote.discount).toBe(330);
    expect(res.body.quote.total).toBe(250);
    // Não federado virou skip com motivo acionável
    const skip = res.body.skipped.find((x) => x.student_id === STU_LOCAL);
    expect(skip.reason).toBe('ALUNO_NAO_FEDERADO');
    // Atleta A (F, 13) em categoria F 12-14 → sem aviso; B (M, 18) em
    // Kumite Adulto Masc 18+ → sem aviso. Nenhum fit warning esperado.
    expect(res.body.warnings).toHaveLength(0);
    expect(res.body.quota_violations).toHaveLength(0);
    // Dry-run: NUNCA abre transação.
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('(3) cota da divisão estourada aparece no quote e BLOQUEIA o submit', async () => {
    // Divisão limita 1 individual por clube por categoria; já existe 1 em CAT_KATA.
    mockPool({
      divisionRules: { max_individual_per_dojo_per_category: 1 },
      individualCounts: [{ category_id: CAT_KATA, n: 1 }],
    });
    const body = { athletes: [{ student_id: STU_A, category_ids: [CAT_KATA] }], teams: [], officials_count: 0 };

    const quote = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/delegation/quote`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send(body);
    expect(quote.status).toBe(200);
    expect(quote.body.quota_violations).toHaveLength(1);
    expect(quote.body.quota_violations[0]).toMatchObject({ category_id: CAT_KATA, limit: 1, existing: 1, over: 1 });

    const submit = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/delegation`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ ...body, payment_mode: 'manual' });
    expect(submit.status).toBe(422);
    expect(submit.body.code).toBe('QUOTA_EXCEEDED');
    expect(db.connect).not.toHaveBeenCalled(); // nada gravado
  });
});

describe('POST /dojo/competitions/:cid/delegation — submit', () => {
  it('(2) grava pedido + entries + equipe amarrados ao delegation_order_id', async () => {
    mockPool({});
    const client = makeSubmitClient({});
    db.connect.mockResolvedValue(client);

    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/delegation`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ ...QUOTE_BODY, payment_mode: 'manual' });

    expect(res.status).toBe(201);
    expect(res.body.order.id).toBe(ORDER_ID);
    expect(res.body.order.status).toBe('awaiting_payment');
    expect(res.body.order.total_amount).toBe(250);
    expect(res.body.quote.total).toBe(250);

    const calls = client.query.mock.calls;
    const orderCall = calls.find((c) => String(c[0]).includes('-- p0d:insert-order'));
    expect(orderCall[1][0]).toBe(FED_ID);
    expect(orderCall[1][2]).toBe(DOJO_ID);
    expect(orderCall[1][4]).toBe('manual');
    // 2 entries individuais (A no kata, B no kumite), com order_id
    const entryCalls = calls.filter((c) => String(c[0]).includes('-- p0d:insert-entry'));
    expect(entryCalls).toHaveLength(2);
    for (const c of entryCalls) expect(c[1]).toContain(ORDER_ID);
    // 1 equipe + 2 membros + 2 entries de equipe (uma por categoria)
    expect(calls.filter((c) => String(c[0]).includes('-- p0d:insert-team\n') || /p0d:insert-team\s/.test(String(c[0]))).length).toBe(1);
    expect(calls.filter((c) => String(c[0]).includes('-- p0d:insert-team-member'))).toHaveLength(2);
    const teamEntryCalls = calls.filter((c) => String(c[0]).includes('-- p0d:insert-team-entry'));
    expect(teamEntryCalls).toHaveLength(2);
    for (const c of teamEntryCalls) expect(c[1]).toContain(ORDER_ID);

    expect(res.body.enrolled.athletes).toHaveLength(2);
    expect(res.body.enrolled.teams).toHaveLength(1);
    expect(res.body.enrolled.teams[0].members).toBe(2);
  });

  it('(4) Canal B → 403 PORTAL_READ_ONLY sem tocar o banco', async () => {
    mockPool({});
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/delegation`)
      .set('Authorization', 'Bearer ' + tokenB)
      .send({ ...QUOTE_BODY, payment_mode: 'manual' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('(5) dojô não conectado → 409 DOJO_NAO_CONECTADO', async () => {
    mockPool({ linked: false });
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/delegation`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ ...QUOTE_BODY, payment_mode: 'manual' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOJO_NAO_CONECTADO');
  });

  it('(6) migração 294 pendente (42P01 no INSERT do pedido) → 503 SCHEMA_PENDING', async () => {
    mockPool({});
    const client = makeSubmitClient({ failInsertOrder: '42P01' });
    db.connect.mockResolvedValue(client);
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/delegation`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ ...QUOTE_BODY, payment_mode: 'manual' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCHEMA_PENDING');
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /^\s*ROLLBACK/i.test(s))).toBe(true);
  });
});

describe('GET /dojo/competitions — vitrine', () => {
  it('(5) não conectado → 200 { not_linked: true } (nunca 403 mudo)', async () => {
    mockPool({ linked: false });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/competitions`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.not_linked).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  it('conectado → lista com divisões e has_pricing', async () => {
    mockPool({});
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/competitions`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].has_pricing).toBe(true);
    expect(res.body.data[0].divisions).toHaveLength(1);
    expect(res.body.data[0].divisions[0].name).toBe('Principal');
  });

  it('dia do evento: closed/done com delegação do dojô entram na lista com enrollment_open=false', async () => {
    const COMP_CLOSED = '33333333-3333-4333-8333-333333333334';
    mockPool({
      vitrineRows: [
        { id: COMP_ID, name: 'Paulista 2026', season: 2026, event_date: '2026-08-22', location: 'Barueri', status: 'open', fee_amount: null, pricing_config: JKA_PRICING, rectification_deadline: '2026-07-31' },
        { id: COMP_CLOSED, name: 'Regional Encerrado', season: 2026, event_date: '2026-08-24', location: 'Osasco', status: 'closed', fee_amount: null, pricing_config: null, rectification_deadline: null },
      ],
    });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/competitions`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const open = res.body.data.find((c) => c.id === COMP_ID);
    const closed = res.body.data.find((c) => c.id === COMP_CLOSED);
    expect(open.enrollment_open).toBe(true);
    expect(open.status).toBe('open');
    expect(closed.enrollment_open).toBe(false);
    expect(closed.status).toBe('closed');

    // O SQL restringe closed/done à participação do dojô (entries OU
    // pedido de delegação), com o dojo_id do TOKEN como parâmetro.
    const call = db.query.mock.calls.find((c) => String(c[0]).includes('-- p0d:list-open-competitions'));
    const sql = String(call[0]);
    expect(sql).toMatch(/status IN \('closed','done'\)/);
    expect(sql).toMatch(/karate_competition_entries/);
    expect(sql).toMatch(/karate_delegation_orders/);
    expect(call[1]).toEqual([FED_ID, DOJO_ID]);
  });

  it('migração 294 pendente (42P01 em delegation_orders) → refaz só com entries, lista segue', async () => {
    mockPool({ vitrineOrdersMissing: true });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/competitions`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const sqls = db.query.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('-- p0d:list-open-competitions'));
    expect(sqls.length).toBe(2);
    expect(sqls[1]).toMatch(/karate_competition_entries/);
    expect(sqls[1]).not.toMatch(/karate_delegation_orders/);
  });
});

// ════════════════════════════════════════════════════════════════
// P2.2 — Triagem automática de categoria
// ════════════════════════════════════════════════════════════════
describe('POST /dojo/competitions/:cid/delegation/triage', () => {
  const triage = (body) => request(buildApp())
    .post(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/delegation/triage`)
    .set('Authorization', `Bearer ${tokenA}`)
    .send(body);

  it('resolved (1 match), no_fit (idade/sexo) e não-federado — numa chamada, sem gravar nada', async () => {
    mockPool({});
    const res = await triage({
      athletes: [
        { student_id: STU_A, modalities: ['kata', 'kumite'] }, // F 13: kata 12-14 F ✓; kumite 18+ M ✗
        { student_id: STU_LOCAL, modalities: ['kata'] },
      ],
    });
    expect(res.status).toBe(200);
    const a = res.body.results[0];
    expect(a.status).toBe('ok');
    const kata = a.triage.find((t) => t.modality === 'kata');
    expect(kata.status).toBe('resolved');
    expect(kata.category.category_id).toBe(CAT_KATA);
    expect(kata.category.group_label).toBe('Grupo 1'); // divisão/G1 viaja junto
    const kumite = a.triage.find((t) => t.modality === 'kumite');
    expect(kumite.status).toBe('no_fit');
    const failed = kumite.considered.flatMap((c) => c.failed);
    expect(failed).toEqual(expect.arrayContaining(['age', 'sex']));
    expect(res.body.results[1].status).toBe('ALUNO_NAO_FEDERADO');
    // dry-run: nenhum INSERT/UPDATE tocou o banco
    const wrote = db.query.mock.calls.some((c) => /INSERT|UPDATE|DELETE/i.test(String(c[0])));
    expect(wrote).toBe(false);
  });

  it('ambiguous quando 2 divisões aceitam a mesma atleta — o sensei só desempata', async () => {
    const CAT_KATA_ASP = '55555555-5555-4555-8555-555555555559';
    mockPool({
      extraCategories: [
        { id: CAT_KATA_ASP, name: 'Kata Mirim Fem (Aspirantes)', modality: 'kata', min_age: 12, max_age: 14, belt_min: null, belt_max: null, sex: 'F', weight_class: null, max_entries: null, fee_amount: null, division_id: null, group_label: 'Grupo 1', entry_count: 0 },
      ],
    });
    const res = await triage({ athletes: [{ student_id: STU_A, modalities: ['kata'] }] });
    expect(res.status).toBe(200);
    const kata = res.body.results[0].triage[0];
    expect(kata.status).toBe('ambiguous');
    expect(kata.options.map((o) => o.category_id).sort()).toEqual([CAT_KATA, CAT_KATA_ASP].sort());
  });

  it('gating de FAIXA com cor↔grau: laranja não entra em categoria verde→marrom; marrom entra (ambiguous)', async () => {
    const CAT_KUM_GRAD = '55555555-5555-4555-8555-555555555558';
    const extra = [
      { id: CAT_KUM_GRAD, name: 'Kumite Adulto Masc Graduados', modality: 'kumite', min_age: 18, max_age: null, belt_min: 'verde', belt_max: 'marrom', sex: 'M', weight_class: null, max_entries: null, fee_amount: null, division_id: DIV_ID, group_label: 'Grupo 2', entry_count: 0 },
    ];
    // Laranja (8º kyu, ABAIXO de verde) → só a categoria sem limite de faixa serve.
    mockPool({ extraCategories: extra, beltRows: [{ student_id: PRAC_B, belt_level: 'laranja', belt_kyu: 8, belt_dan: null }] });
    let res = await triage({ athletes: [{ student_id: STU_B, modalities: ['kumite'] }] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].triage[0].status).toBe('resolved');
    expect(res.body.results[0].triage[0].category.category_id).toBe(CAT_KUMITE);

    // Marrom 2º kyu (dentro de verde→marrom) → as DUAS servem → ambiguous.
    mockPool({ extraCategories: extra, beltRows: [{ student_id: PRAC_B, belt_level: 'marrom', belt_kyu: 2, belt_dan: null }] });
    res = await triage({ athletes: [{ student_id: STU_B, modalities: ['kumite'] }] });
    expect(res.body.results[0].triage[0].status).toBe('ambiguous');
    expect(res.body.results[0].triage[0].options).toHaveLength(2);
  });
});

// ── Onda B: "minhas chaves" no portal do dojô ───────────────
describe('GET /dojo/competitions/:cid/my-brackets', () => {
  const CAT_X = 'cat-x-uuid';
  function withMyBrackets({ published }) {
    mockPool();
    const prev = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (s.includes('-- p0d:comp-published')) {
        return Promise.resolve({ rows: [{ id: params[0], name: 'Paulista QA', brackets_published_at: published ? '2026-10-01T00:00:00Z' : null }] });
      }
      if (s.includes('-- p0d:my-brackets')) {
        return Promise.resolve({ rows: [
          { id: CAT_X, name: 'Kata Mirim', modality: 'kata', group_label: 'Grupo 1', division_name: 'Paulista', area_name: 'Koto 2', area_order: 3, bracket_status: 'locked', kata_mode: 'score_rounds', student_name: 'Atleta A' },
          { id: CAT_X, name: 'Kata Mirim', modality: 'kata', group_label: 'Grupo 1', division_name: 'Paulista', area_name: 'Koto 2', area_order: 3, bracket_status: 'locked', kata_mode: 'score_rounds', student_name: 'Atleta C' },
        ] });
      }
      if (s.includes('-- p0d:my-cat-gate')) {
        return Promise.resolve({ rows: params[0] === CAT_X ? [{ '?column?': 1 }] : [] });
      }
      return prev(sql, params);
    });
  }

  it('chaves publicadas: agrupa por categoria com MEUS atletas e o koto', async () => {
    withMyBrackets({ published: true });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/my-brackets`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.published).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: CAT_X, area_name: 'Koto 2', bracket_status: 'locked',
      my_athletes: ['Atleta A', 'Atleta C'],
    });
  });

  it('antes de publicar: 200 { published: false } (nunca 403 mudo); súmula 404 NOT_PUBLISHED', async () => {
    withMyBrackets({ published: false });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/my-brackets`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ published: false, data: [] });

    const sheet = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/categories/${CAT_X}/scoresheet`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(sheet.status).toBe(404);
    expect(sheet.body.code).toBe('NOT_PUBLISHED');
  });

  it('súmula de categoria SEM atleta meu → 404 (não vaza chave alheia)', async () => {
    withMyBrackets({ published: true });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/categories/cat-alheia/scoresheet`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(404);
  });
});

// ── Onda B: check-in do lado do dojô ────────────────────────
describe('check-in do dojô', () => {
  it('marca só atleta do PRÓPRIO dojô (escopo no UPDATE) e Canal A', async () => {
    let params = null;
    mockPool();
    const prev = db.query.getMockImplementation();
    db.query.mockImplementation((sql, p) => {
      const s = String(sql);
      if (s.includes('-- p0d:comp-published')) {
        return Promise.resolve({ rows: [{ id: p[0], name: 'Paulista QA', brackets_published_at: null }] });
      }
      if (s.includes('-- p2b:checkin-mark')) {
        params = p;
        return Promise.resolve({ rows: [{ id: 'e1' }] });
      }
      return prev(sql, p);
    });

    const res = await request(buildApp())
      .patch(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/check-in/stu-1`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ status: 'presente' });
    expect(res.status).toBe(200);
    // O escopo do dojô vai NO SQL ($4) — nunca do body.
    expect(params).toEqual([COMP_ID, 'stu-1', 'presente', DOJO_ID]);

    // Canal B (portal) é somente leitura.
    const portal = await request(buildApp())
      .patch(`/federation/${FED_ID}/dojo/competitions/${COMP_ID}/check-in/stu-1`)
      .set('Authorization', 'Bearer ' + tokenB)
      .send({ status: 'presente' });
    expect(portal.status).toBe(403);
    expect(portal.body.code).toBe('PORTAL_READ_ONLY');
  });
});
