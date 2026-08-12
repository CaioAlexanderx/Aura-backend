// ============================================================
// AURA DOJÔ — F11.3: revisão do plantel herdado (migration 276)
//
// MOCK POR SQL, NUNCA POR POSIÇÃO — toda SQL dos dois services começa com
// uma âncora `-- drr:<nome>`; o despacho abaixo lê a âncora por regex
// (mesmo padrão de __tests__/karate.dojoTags.test.js). Fila posicional já
// derrubou o CI deste repo 4 vezes (CLAUDE.md). O MESMO despachante serve
// o pool (db.query) e o client de transação (db.connect), então BEGIN /
// COMMIT / SAVEPOINT caem no default e não desalinham nada.
//
// ESCOPO: em TODO caso que simula "esta linha é deste dojô / desta
// federação", a comparação é contra o PARÂMETRO da query (o valor que o
// handler tirou do token ou do path) e NUNCA contra as constantes DOJO_ID
// / FED_ID do teste. Comparar com a constante é tautologia: o mock nunca
// devolveria vazio e os testes de "de outro dojô é 404" passariam mesmo
// com o escopo quebrado.
//
// IDs de fixture são UUID HEXADECIMAL VÁLIDO — o service castea `::uuid[]`
// e `::uuid`, e um id com letra fora de [0-9a-f] estouraria 22P02 num
// banco real (aqui só o mock veria, mas o teste mentiria).
//
// db.query/db.connect vêm do mock GLOBAL (tests/jest.setup.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const dojoRouter = require('../src/routes/karateDojoRosterReview');
const fedRouter = require('../src/routes/karateRosterReviewNoticesAdmin');

const SECRET = 'aura-test-secret-2026'; // igual ao forçado em tests/jest.setup.js

// ── Fixtures: uuid hexadecimal válido, sempre ───────────────
const FED_ID        = '11111111-1111-4111-8111-111111111111';
const OTHER_FED_ID  = '99999999-9999-4999-8999-999999999999';
const DOJO_ID       = '22222222-2222-4222-8222-222222222222'; // o registro assumido
const OTHER_DOJO_ID = '33333333-3333-4333-8333-333333333333';
const DEST_DOJO_ID  = '44444444-4444-4444-8444-444444444444';
const USER_ID       = '55555555-5555-4555-8555-555555555555';

const PRAC_A     = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'; // treina no dojô
const PRAC_B     = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'; // parou há anos
const PRAC_C     = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'; // mudou de dojô (não sabemos)
const PRAC_D     = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'; // entra DEPOIS da revisão
const PRAC_ALIEN = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'; // de OUTRO dojô
const NOTICE_ID  = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';

// O nome que está NA LINHA DE users — de propósito DIFERENTE do `name` do
// JWT abaixo. É assim que os testes de label provam que o rótulo vem do
// banco e não do token (o token real nem sequer TEM esse campo:
// signAccessToken não assina name/email).
const DB_FULL_NAME = 'Kondei Yamamoto (banco)';
const DB_EMAIL     = 'sensei@kondeibrasil.com.br';

const tokenA = jwt.sign(
  { type: 'access', id: USER_ID, name: 'Sensei Kondei', dojo_id: DOJO_ID, federation_id: FED_ID },
  SECRET,
  { expiresIn: '1h' }
);
const tokenB = jwt.sign(
  { type: 'portal', scope: 'dojo_portal', dojo_id: DOJO_ID, federation_id: FED_ID },
  SECRET,
  { expiresIn: '1h' }
);
const adminToken = jwt.sign(
  { id: USER_ID, name: 'FPKT Staff', role: 'admin', plan: 'expansao' },
  SECRET,
  { expiresIn: '1h' }
);

function buildDojoApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', dojoRouter);
  return app;
}

function buildFedApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', fedRouter);
  return app;
}

function tagOf(sql) {
  const m = String(sql).match(/--\s*drr:([a-z-]+)/i);
  return m ? m[1] : null;
}

// ── Estado simulado ──────────────────────────────────────────
// `prac` mora no escopo do módulo porque um dos testes precisa acrescentar
// praticante DEPOIS da revisão concluída (plantel que cresceu).
function prac(id, name, num, active, dojoId) {
  return {
    id,
    name,
    karate_registration_number: num,
    birth_date: '2000-01-01',
    is_active: active,
    karate_photo_url: null,
    dojo_id: dojoId,
    federation_id: FED_ID,
  };
}

function baseState() {
  return {
    practitioners: {
      [PRAC_A]: prac(PRAC_A, 'Ana Treina Aqui', '1001-D', true, DOJO_ID),
      [PRAC_B]: prac(PRAC_B, 'Bruno Parou em 2019', '1002-D', true, DOJO_ID),
      [PRAC_C]: prac(PRAC_C, 'Carla Mudou de Dojô', '1003-D', false, DOJO_ID),
      [PRAC_ALIEN]: prac(PRAC_ALIEN, 'Praticante Alheio', '9999-D', true, OTHER_DOJO_ID),
    },
    // A linha de users é a ÚNICA fonte dos *_label (o JWT não tem nome).
    users: {
      [USER_ID]: { id: USER_ID, full_name: DB_FULL_NAME, email: DB_EMAIL },
    },
    reviews: {},   // id -> row
    items: [],     // { review_id, dojo_id, practitioner_id, status, reviewed_by, reviewed_by_label }
    notices: [],   // linha de karate_dojo_roster_review_notices
    transfers: [],
    events: [],
    seq: 0,
    clientSql: [], // toda SQL rodada dentro de transação, para asserções
  };
}

let state;

const nextId = (prefix) => `${prefix}${String(++state.seq).padStart(4, '0')}-0000-4000-8000-000000000000`.slice(0, 36);

function practitionersOf(dojoId, federationId) {
  return Object.values(state.practitioners)
    .filter((p) => p.dojo_id === dojoId && p.federation_id === federationId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function itemFor(reviewId, practitionerId) {
  return state.items.find((i) => i.review_id === reviewId && i.practitioner_id === practitionerId) || null;
}

function applyRosterFilters(rows, { reviewId, q, active, reviewStatus }) {
  return rows.filter((p) => {
    if (q) {
      const like = String(q).replace(/%/g, '').toLowerCase();
      const hit =
        String(p.name || '').toLowerCase().includes(like) ||
        String(p.karate_registration_number || '').toLowerCase().includes(like);
      if (!hit) return false;
    }
    if (active === 'active' && p.is_active !== true) return false;
    if (active === 'inactive' && p.is_active !== false) return false;
    if (reviewStatus) {
      const it = reviewId ? itemFor(reviewId, p.id) : null;
      const st = it ? it.status : 'pending';
      if (st !== reviewStatus) return false;
    }
    return true;
  });
}

function rosterRow(p, reviewId) {
  const it = reviewId ? itemFor(reviewId, p.id) : null;
  return {
    id: p.id,
    name: p.name,
    karate_registration_number: p.karate_registration_number,
    birth_date: p.birth_date,
    is_active: p.is_active,
    karate_photo_url: p.karate_photo_url,
    review_status: it ? it.status : null,
    reviewed_at: it ? '2026-08-11T10:00:00.000Z' : null,
  };
}

function summaryRow(dojoId, federationId, reviewId) {
  const all = practitionersOf(dojoId, federationId);
  const st = (p) => {
    const it = reviewId ? itemFor(reviewId, p.id) : null;
    return it ? it.status : null;
  };
  return {
    inherited_total: all.length,
    recognized: reviewId ? all.filter((p) => st(p) === 'recognized').length : 0,
    not_recognized: reviewId ? all.filter((p) => st(p) === 'not_recognized').length : 0,
    pending: reviewId ? all.filter((p) => st(p) === null).length : all.length,
    inactive_in_federation: all.filter((p) => p.is_active === false).length,
  };
}

// O despachante. TODA comparação de escopo usa os params (p[...]), nunca
// as constantes do teste.
function dispatch(sql, params) {
  const s = String(sql);
  const p = params || [];
  switch (tagOf(s)) {
    // ── lado DOJÔ ──
    case 'actor-label': {
      // params: [userId] — a linha é procurada pelo id que o SERVICE
      // mandou (o do token), não por USER_ID direto.
      const u = state.users[p[0]];
      return Promise.resolve({
        rows: u ? [{ full_name: u.full_name, email: u.email }] : [],
      });
    }
    case 'open-review': {
      const r = Object.values(state.reviews).find((x) => x.dojo_id === p[0] && x.status === 'in_progress');
      return Promise.resolve({ rows: r ? [r] : [] });
    }
    case 'lock-review': {
      const r = Object.values(state.reviews).find((x) => x.dojo_id === p[0] && x.status === 'in_progress');
      return Promise.resolve({ rows: r ? [r] : [] });
    }
    case 'latest-review': {
      const rs = Object.values(state.reviews)
        .filter((x) => x.dojo_id === p[0])
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
      return Promise.resolve({ rows: rs.slice(0, 1) });
    }
    case 'assumption-lookup':
      return Promise.resolve({ rows: [] }); // best-effort: sem assunção registrada
    case 'create-review': {
      // params: [dojoId, fedId, assumptionId, startedBy, startedByLabel]
      const clash = Object.values(state.reviews).some((x) => x.dojo_id === p[0] && x.status === 'in_progress');
      if (clash) return Promise.resolve({ rows: [] }); // ON CONFLICT DO NOTHING
      const id = nextId('7');
      const row = {
        id,
        dojo_id: p[0],
        federation_id: p[1],
        assumption_id: p[2],
        status: 'in_progress',
        started_by: p[3],
        started_by_label: p[4],
        started_at: '2026-08-11T09:00:00.000Z',
        completed_by: null, completed_by_label: null, completed_at: null,
        inherited_total: null, recognized_count: null, not_recognized_count: null, notices_created: null,
      };
      state.reviews[id] = row;
      return Promise.resolve({ rows: [row] });
    }
    case 'roster': {
      // params: [dojo, fed, reviewId, q, active, reviewStatus, limit, offset]
      const rows = applyRosterFilters(practitionersOf(p[0], p[1]), {
        reviewId: p[2], q: p[3], active: p[4], reviewStatus: p[5],
      });
      const page = rows.slice(p[7], p[7] + p[6]);
      return Promise.resolve({
        rows: page.map((x) => ({ ...rosterRow(x, p[2]), total_count: rows.length })),
      });
    }
    case 'roster-no-review': {
      // params: [dojo, fed, q, active, reviewStatus, limit, offset]
      const rows = applyRosterFilters(practitionersOf(p[0], p[1]), {
        reviewId: null, q: p[2], active: p[3], reviewStatus: p[4],
      });
      const page = rows.slice(p[6], p[6] + p[5]);
      return Promise.resolve({
        rows: page.map((x) => ({ ...rosterRow(x, null), total_count: rows.length })),
      });
    }
    case 'roster-count': {
      const rows = applyRosterFilters(practitionersOf(p[0], p[1]), {
        reviewId: p[2], q: p[3], active: p[4], reviewStatus: p[5],
      });
      return Promise.resolve({ rows: [{ n: rows.length }] });
    }
    case 'roster-count-no-review': {
      const rows = applyRosterFilters(practitionersOf(p[0], p[1]), {
        reviewId: null, q: p[2], active: p[3], reviewStatus: p[4],
      });
      return Promise.resolve({ rows: [{ n: rows.length }] });
    }
    case 'summary':
      return Promise.resolve({ rows: [summaryRow(p[0], p[1], p[2])] });
    case 'summary-no-review':
      return Promise.resolve({ rows: [summaryRow(p[0], p[1], null)] });
    case 'scope-ids': {
      // params: [dojoId, fedId, ids[]] — escopo contra p[0]/p[1], NUNCA
      // contra DOJO_ID/FED_ID.
      const ids = p[2] || [];
      const rows = ids
        .filter((id) => {
          const pr = state.practitioners[id];
          return pr && pr.dojo_id === p[0] && pr.federation_id === p[1];
        })
        .map((id) => ({ id }));
      return Promise.resolve({ rows });
    }
    case 'mark': {
      // params: [reviewId, dojoId, ids[], status, by, label]
      const out = [];
      for (const id of p[2] || []) {
        const existing = itemFor(p[0], id);
        if (existing) {
          existing.status = p[3];
          existing.reviewed_by = p[4];
          existing.reviewed_by_label = p[5];
        } else {
          state.items.push({
            review_id: p[0], dojo_id: p[1], practitioner_id: id,
            status: p[3], reviewed_by: p[4], reviewed_by_label: p[5],
          });
        }
        out.push({ practitioner_id: id });
      }
      return Promise.resolve({ rows: out });
    }
    case 'unmark': {
      // params: [reviewId, dojoId, ids[]]
      const ids = new Set(p[2] || []);
      const removed = state.items.filter(
        (i) => i.review_id === p[0] && i.dojo_id === p[1] && ids.has(i.practitioner_id)
      );
      state.items = state.items.filter((i) => !removed.includes(i));
      return Promise.resolve({ rows: removed.map((i) => ({ practitioner_id: i.practitioner_id })) });
    }
    case 'fill-pending': {
      // params: [reviewId, dojoId, fedId, status, by, label]
      const all = practitionersOf(p[1], p[2]);
      const added = [];
      for (const pr of all) {
        if (itemFor(p[0], pr.id)) continue;
        state.items.push({
          review_id: p[0], dojo_id: p[1], practitioner_id: pr.id,
          status: p[3], reviewed_by: p[4], reviewed_by_label: p[5],
        });
        added.push({ practitioner_id: pr.id });
      }
      return Promise.resolve({ rows: added });
    }
    case 'notices-generate': {
      // params: [reviewId, dojoId, fedId, by, label]
      const created = [];
      for (const it of state.items.filter(
        (i) => i.review_id === p[0] && i.dojo_id === p[1] && i.status === 'not_recognized'
      )) {
        const dup = state.notices.some(
          (n) => n.review_id === p[0] && n.practitioner_id === it.practitioner_id
        );
        if (dup) continue; // ON CONFLICT DO NOTHING
        const pr = state.practitioners[it.practitioner_id];
        const id = nextId('8');
        state.notices.push({
          id,
          review_id: p[0], dojo_id: p[1], federation_id: p[2],
          practitioner_id: it.practitioner_id,
          practitioner_name: pr ? pr.name : null,
          practitioner_fpkt_number: pr ? pr.karate_registration_number : null,
          practitioner_was_active: pr ? pr.is_active : null,
          reason: 'nao_reconhecido_pelo_sensei',
          reported_by: p[3], reported_by_label: p[4],
          reported_at: '2026-08-11T12:00:00.000Z',
          decision: 'pending', decision_note: null, destination_dojo_id: null,
          decided_by: null, decided_by_label: null, decided_at: null,
        });
        created.push({ id });
      }
      return Promise.resolve({ rows: created });
    }
    case 'complete': {
      // params: [reviewId, by, label, total, rec, notrec, notices]
      const r = state.reviews[p[0]];
      if (!r || r.status !== 'in_progress') return Promise.resolve({ rows: [] });
      Object.assign(r, {
        status: 'completed',
        completed_by: p[1], completed_by_label: p[2], completed_at: '2026-08-11T12:00:00.000Z',
        inherited_total: p[3], recognized_count: p[4], not_recognized_count: p[5], notices_created: p[6],
      });
      return Promise.resolve({ rows: [r] });
    }
    case 'roster-event':
      state.events.push({ sql: s, params: p });
      return Promise.resolve({ rows: [] });

    // ── lado FEDERAÇÃO ──
    case 'notices-list': {
      // params: [fedId, decision, dojoId, q, limit, offset]
      let rows = state.notices.filter((n) => n.federation_id === p[0]);
      if (p[1]) rows = rows.filter((n) => n.decision === p[1]);
      if (p[2]) rows = rows.filter((n) => n.dojo_id === p[2]);
      if (p[3]) {
        const like = String(p[3]).replace(/%/g, '').toLowerCase();
        rows = rows.filter(
          (n) =>
            String(n.practitioner_name || '').toLowerCase().includes(like) ||
            String(n.practitioner_fpkt_number || '').toLowerCase().includes(like)
        );
      }
      const total = rows.length;
      const page = rows.slice(p[5], p[5] + p[4]);
      return Promise.resolve({
        rows: page.map((n) => {
          const pr = state.practitioners[n.practitioner_id];
          return {
            ...n,
            dojo_name: 'Dojô do Aviso',
            current_dojo_id: pr ? pr.dojo_id : null,
            current_is_active: pr ? pr.is_active : null,
            total_count: total,
          };
        }),
      });
    }
    case 'notices-summary': {
      const rows = state.notices.filter((n) => n.federation_id === p[0]);
      return Promise.resolve({
        rows: [{
          total: rows.length,
          pending: rows.filter((n) => n.decision === 'pending').length,
          inactivated: rows.filter((n) => n.decision === 'inactivated').length,
          transferred: rows.filter((n) => n.decision === 'transferred').length,
          kept: rows.filter((n) => n.decision === 'kept').length,
        }],
      });
    }
    case 'notice-lock': {
      // params: [noticeId, fedId] — escopo contra p[1], nunca contra FED_ID.
      const n = state.notices.find((x) => x.id === p[0] && x.federation_id === p[1]);
      return Promise.resolve({ rows: n ? [n] : [] });
    }
    case 'inactivate-practitioner': {
      // params: [practitionerId, fedId, dojoId]
      const pr = state.practitioners[p[0]];
      if (!pr || pr.federation_id !== p[1] || pr.dojo_id !== p[2]) return Promise.resolve({ rows: [] });
      pr.is_active = false;
      return Promise.resolve({ rows: [{ id: pr.id, is_active: false }] });
    }
    case 'transfer-dest': {
      // params: [destId, fedId] — só dojô ATIVO desta federação
      if (p[0] === DEST_DOJO_ID && p[1] === FED_ID) {
        return Promise.resolve({ rows: [{ id: DEST_DOJO_ID, name: 'Dojô Destino' }] });
      }
      return Promise.resolve({ rows: [] });
    }
    case 'transfer-origin':
      return Promise.resolve({ rows: [{ id: p[0], name: 'Dojô Origem' }] });
    case 'transfer-move': {
      // params: [destId, practitionerId, fedId, originDojoId]
      const pr = state.practitioners[p[1]];
      if (!pr || pr.federation_id !== p[2] || pr.dojo_id !== p[3]) return Promise.resolve({ rows: [] });
      pr.dojo_id = p[0];
      return Promise.resolve({ rows: [{ id: pr.id }] });
    }
    case 'transfer-log':
      state.transfers.push({ sql: s, params: p });
      return Promise.resolve({ rows: [] });
    case 'notice-decide': {
      // params: [noticeId, fedId, decision, note, destId, by, label]
      const n = state.notices.find((x) => x.id === p[0] && x.federation_id === p[1] && x.decision === 'pending');
      if (!n) return Promise.resolve({ rows: [] });
      Object.assign(n, {
        decision: p[2], decision_note: p[3], destination_dojo_id: p[4],
        decided_by: p[5], decided_by_label: p[6], decided_at: '2026-08-11T13:00:00.000Z',
      });
      return Promise.resolve({ rows: [n] });
    }
    default:
      // BEGIN / COMMIT / ROLLBACK / SAVEPOINT e qualquer SQL sem âncora.
      return Promise.resolve({ rows: [] });
  }
}

function makeClient() {
  return {
    query: jest.fn((sql, params) => {
      state.clientSql.push(String(sql));
      return dispatch(sql, params);
    }),
    release: jest.fn(),
  };
}

const clientSqlJoined = () => state.clientSql.join('\n');

beforeEach(() => {
  state = baseState();
  db.query.mockReset();
  db.query.mockImplementation(dispatch);
  db.connect.mockReset();
  db.connect.mockImplementation(async () => makeClient());
});

// Atalho: marca em lote pela rota real (nada de semear estado à mão —
// o teste do fluxo tem que passar pelo handler).
function mark(ids, status) {
  return request(buildDojoApp())
    .post(`/federation/${FED_ID}/dojo/roster-review/mark`)
    .set('Authorization', 'Bearer ' + tokenA)
    .send({ practitioner_ids: ids, status });
}

function getState() {
  return request(buildDojoApp())
    .get(`/federation/${FED_ID}/dojo/roster-review`)
    .set('Authorization', 'Bearer ' + tokenA);
}

function getRoster(qs) {
  return request(buildDojoApp())
    .get(`/federation/${FED_ID}/dojo/roster-review/roster${qs || ''}`)
    .set('Authorization', 'Bearer ' + tokenA);
}

function completeAs(body) {
  return request(buildDojoApp())
    .post(`/federation/${FED_ID}/dojo/roster-review/complete`)
    .set('Authorization', 'Bearer ' + tokenA)
    .send(body || {});
}

// ═══════════════════════════════════════════════════════════
// GET /dojo/roster-review — estado, sem efeito colateral
// ═══════════════════════════════════════════════════════════
describe('GET /federation/:id/dojo/roster-review', () => {
  test('nenhuma revisão JAMAIS criada: review null e TODO o plantel como pendente', async () => {
    const res = await getState();

    expect(res.status).toBe(200);
    expect(res.body.review).toBeNull();
    expect(res.body.review_status).toBeNull();
    expect(res.body.summary).toMatchObject({
      inherited_total: 3, recognized: 0, not_recognized: 0, pending: 3, inactive_in_federation: 1,
    });
    // É ESTE o caso legítimo da variante sem revisão — o convite inicial à
    // revisão. Ela não pode desaparecer junto com a correção do contador.
    expect(db.query.mock.calls.some((c) => tagOf(c[0]) === 'summary-no-review')).toBe(true);
  });

  test('abrir a tela NÃO cria revisão (listagem nunca escreve)', async () => {
    await getState();
    expect(Object.keys(state.reviews)).toHaveLength(0);
    const sqls = db.query.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sqls).not.toMatch(/INSERT INTO karate_dojo_roster_reviews/);
  });

  test('Canal B (portal) também pode ler', async () => {
    const res = await request(buildDojoApp())
      .get(`/federation/${FED_ID}/dojo/roster-review`)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(res.status).toBe(200);
  });

  test('401 sem token', async () => {
    const res = await request(buildDojoApp()).get(`/federation/${FED_ID}/dojo/roster-review`);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════
// GET /dojo/roster-review/roster — volume: paginação e busca
// ═══════════════════════════════════════════════════════════
describe('GET /federation/:id/dojo/roster-review/roster', () => {
  test('lista o plantel herdado com review_status pending para quem nunca foi tocado', async () => {
    const res = await getRoster();

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.data.every((r) => r.review_status === 'pending')).toBe(true);
    // NUNCA aparece praticante de outro dojô — escopo pelo token.
    expect(res.body.data.map((r) => r.practitioner_id)).not.toContain(PRAC_ALIEN);
  });

  test('paginação de verdade: limit=1 devolve 1 item e o count TOTAL', async () => {
    const res = await getRoster('?limit=1&offset=1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.count).toBe(3);
    expect(res.body.limit).toBe(1);
    expect(res.body.offset).toBe(1);
  });

  test('busca por nome (?q=) filtra', async () => {
    const res = await getRoster('?q=Bruno');
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].practitioner_id).toBe(PRAC_B);
  });

  test('depois de marcar, review_status reflete a marcação e ?review_status= filtra', async () => {
    await mark([PRAC_A], 'recognized');

    const all = await getRoster();
    const a = all.body.data.find((r) => r.practitioner_id === PRAC_A);
    expect(a.review_status).toBe('recognized');

    const pend = await getRoster('?review_status=pending');
    expect(pend.body.count).toBe(2);
    expect(pend.body.data.map((r) => r.practitioner_id)).not.toContain(PRAC_A);
  });
});

// ═══════════════════════════════════════════════════════════
// POST /dojo/roster-review/mark — lote, idempotência, escopo
// ═══════════════════════════════════════════════════════════
describe('POST /federation/:id/dojo/roster-review/mark', () => {
  test('marca VÁRIOS numa chamada só e abre a revisão na primeira marcação', async () => {
    const res = await mark([PRAC_A, PRAC_B], 'recognized');
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(2);
    expect(res.body.summary).toMatchObject({ recognized: 2, pending: 1 });
    expect(Object.keys(state.reviews)).toHaveLength(1);
    expect(res.body.review.status).toBe('in_progress');
  });

  test('reenviar o MESMO lote é idempotente — não duplica item nem abre 2ª revisão', async () => {
    await mark([PRAC_A, PRAC_B], 'recognized');
    const again = await mark([PRAC_A, PRAC_B], 'recognized');

    expect(again.status).toBe(200);
    expect(state.items).toHaveLength(2);
    expect(Object.keys(state.reviews)).toHaveLength(1);
    expect(again.body.summary).toMatchObject({ recognized: 2, pending: 1 });
  });

  test('remarcar troca o status (recognized → not_recognized) sem criar linha nova', async () => {
    await mark([PRAC_A], 'recognized');
    const res = await mark([PRAC_A], 'not_recognized');
    expect(res.body.summary).toMatchObject({ recognized: 0, not_recognized: 1 });
    expect(state.items).toHaveLength(1);
  });

  test("status 'pending' DESMARCA (retomável: errar um clique não é irreversível)", async () => {
    await mark([PRAC_A, PRAC_B], 'not_recognized');
    const res = await mark([PRAC_B], 'pending');
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ not_recognized: 1, pending: 2 });
    expect(state.items).toHaveLength(1);
  });

  test('a revisão é RETOMÁVEL: marcar em duas chamadas separadas acumula', async () => {
    await mark([PRAC_A], 'recognized');
    const res = await mark([PRAC_B], 'not_recognized');
    expect(res.body.summary).toMatchObject({ recognized: 1, not_recognized: 1, pending: 1 });
    expect(Object.keys(state.reviews)).toHaveLength(1); // a MESMA revisão
  });

  test('praticante de OUTRO dojô volta em skipped e NUNCA é marcado (escopo pelo token)', async () => {
    const res = await mark([PRAC_A, PRAC_ALIEN], 'not_recognized');
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(1);
    expect(res.body.skipped).toEqual([PRAC_ALIEN]);
    expect(state.items.map((i) => i.practitioner_id)).not.toContain(PRAC_ALIEN);
  });

  test('dojo_id / federation_id no CORPO são ignorados — escopo é SEMPRE o do token', async () => {
    // O corpo tenta se passar por outro dojô E manda o praticante DELE.
    // Se o handler lesse o corpo, PRAC_ALIEN seria marcado; lendo o token,
    // ele é alheio e vai para skipped.
    const res = await request(buildDojoApp())
      .post(`/federation/${FED_ID}/dojo/roster-review/mark`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({
        practitioner_ids: [PRAC_A, PRAC_ALIEN],
        status: 'not_recognized',
        dojo_id: OTHER_DOJO_ID,
        federation_id: OTHER_FED_ID,
      });

    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(1);
    expect(res.body.skipped).toEqual([PRAC_ALIEN]);
    // A SQL de escopo tem que ter recebido o dojô/federação DO TOKEN.
    const scopeCall = db.query.mock.calls.find((c) => /drr:scope-ids/.test(String(c[0])));
    expect(scopeCall[1][0]).toBe(DOJO_ID);
    expect(scopeCall[1][0]).not.toBe(OTHER_DOJO_ID);
    expect(scopeCall[1][1]).toBe(FED_ID);
    // E a marcação gravada é do dojô do token.
    expect(state.items.every((i) => i.dojo_id === DOJO_ID)).toBe(true);
  });

  test('lote SÓ com ids alheios não marca nada e NÃO abre revisão', async () => {
    const res = await mark([PRAC_ALIEN], 'not_recognized');
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(0);
    expect(res.body.skipped_count).toBe(1);
    expect(Object.keys(state.reviews)).toHaveLength(0);
  });

  test('status inválido é 422 e não toca no banco', async () => {
    const res = await mark([PRAC_A], 'inativo');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('lista vazia é 422', async () => {
    const res = await mark([], 'recognized');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('lote acima de 500 é 422 BATCH_TOO_LARGE', async () => {
    const ids = Array.from({ length: 501 }, (_, i) =>
      `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`
    );
    const res = await mark(ids, 'recognized');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('BATCH_TOO_LARGE');
  });

  test('Canal B (portal) não pode marcar — 403 PORTAL_READ_ONLY', async () => {
    const res = await request(buildDojoApp())
      .post(`/federation/${FED_ID}/dojo/roster-review/mark`)
      .set('Authorization', 'Bearer ' + tokenB)
      .send({ practitioner_ids: [PRAC_A], status: 'recognized' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// POST /dojo/roster-review/complete — a regra central
// ═══════════════════════════════════════════════════════════
describe('POST /federation/:id/dojo/roster-review/complete', () => {
  const complete = (body) => completeAs(body);

  test('409 REVISAO_NAO_INICIADA quando ninguém marcou nada ainda', async () => {
    const res = await complete();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REVISAO_NAO_INICIADA');
  });

  test('409 REVISAO_INCOMPLETA com os números quando ainda há não revisados', async () => {
    await mark([PRAC_A], 'recognized');
    const res = await complete();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('REVISAO_INCOMPLETA');
    expect(res.body.summary).toMatchObject({ pending: 2 });
    expect(state.notices).toHaveLength(0); // nada foi comunicado
  });

  test('conclui e gera UM aviso por não reconhecido', async () => {
    await mark([PRAC_A], 'recognized');
    await mark([PRAC_B, PRAC_C], 'not_recognized');

    const res = await complete();
    expect(res.status).toBe(200);
    expect(res.body.notices_created).toBe(2);
    expect(res.body.review.status).toBe('completed');
    expect(res.body.review.recognized_count).toBe(1);
    expect(res.body.review.not_recognized_count).toBe(2);
    expect(state.notices.map((n) => n.practitioner_id).sort()).toEqual([PRAC_B, PRAC_C].sort());
    expect(state.notices.every((n) => n.decision === 'pending')).toBe(true);
  });

  test('⚠️ concluir NÃO INATIVA NINGUÉM — nenhuma SQL toca customers', async () => {
    await mark([PRAC_A], 'recognized');
    await mark([PRAC_B, PRAC_C], 'not_recognized');
    const res = await complete();

    expect(res.status).toBe(200);
    expect(res.body.practitioners_changed).toBe(false);
    // A prova: NENHUMA escrita em customers nem em transferências dentro
    // da transação. (Reparar que `is_active = false` APARECE na SQL — no
    // FILTER da contagem de inativos. Por isso a asserção olha o VERBO da
    // escrita, não a substring: um grep ingênuo aqui daria falso positivo
    // e, pior, poderia ser "corrigido" afrouxando o teste.)
    expect(clientSqlJoined()).not.toMatch(/UPDATE\s+customers/i);
    expect(clientSqlJoined()).not.toMatch(/DELETE\s+FROM\s+customers/i);
    expect(clientSqlJoined()).not.toMatch(/karate_practitioner_transfers/i);
    // E o estado dos praticantes continua exatamente o que era.
    expect(state.practitioners[PRAC_B].is_active).toBe(true);
    expect(state.practitioners[PRAC_B].dojo_id).toBe(DOJO_ID);
  });

  test("pending_policy='not_recognized' fecha o resto em lote (1 clique, não 300)", async () => {
    await mark([PRAC_A], 'recognized');
    const res = await complete({ pending_policy: 'not_recognized' });

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ recognized: 1, not_recognized: 2, pending: 0 });
    expect(res.body.notices_created).toBe(2);
    // Continua sem inativar ninguém, mesmo com a política em lote.
    expect(state.practitioners[PRAC_B].is_active).toBe(true);
  });

  test("pending_policy='recognized' confirma o resto e não gera aviso nenhum", async () => {
    await mark([PRAC_B], 'not_recognized');
    const res = await complete({ pending_policy: 'recognized' });
    expect(res.status).toBe(200);
    expect(res.body.notices_created).toBe(1);
    expect(res.body.summary).toMatchObject({ recognized: 2, not_recognized: 1, pending: 0 });
  });

  test('pending_policy inválida é 422', async () => {
    await mark([PRAC_A], 'recognized');
    const res = await complete({ pending_policy: 'inativar_todos' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('concluir duas vezes: 409 e NENHUM aviso duplicado', async () => {
    await mark([PRAC_B], 'not_recognized');
    await complete({ pending_policy: 'recognized' });
    expect(state.notices).toHaveLength(1);

    const again = await complete({ pending_policy: 'recognized' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('REVISAO_NAO_INICIADA'); // não há mais revisão aberta
    expect(state.notices).toHaveLength(1);
  });

  test('Canal B não pode concluir — 403 PORTAL_READ_ONLY', async () => {
    const res = await request(buildDojoApp())
      .post(`/federation/${FED_ID}/dojo/roster-review/complete`)
      .set('Authorization', 'Bearer ' + tokenB)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
  });
});

// ═══════════════════════════════════════════════════════════
// DEPOIS DE CONCLUIR — regressão de produção (12/08/2026)
//
// O dojô de 4 praticantes concluiu a revisão com 1 recognized + 3
// not_recognized e o badge da aba passou de 1 para 4: sem revisão
// 'in_progress', o summary ia para a variante sem revisão e contava o
// plantel INTEIRO como pendente. Os itens nunca saíram do banco.
// Antes do import dos 484 alunos da Areikan isso vira "484 pendentes"
// permanentes — convite a remarcar tudo e abrir uma 2ª revisão.
// ═══════════════════════════════════════════════════════════
describe('revisão CONCLUÍDA: o contador não pode ressuscitar o plantel', () => {
  async function concluirRevisao() {
    await mark([PRAC_A], 'recognized');
    await mark([PRAC_B, PRAC_C], 'not_recognized');
    const res = await completeAs({});
    expect(res.status).toBe(200);
    return res.body.review.id;
  }

  test('o summary devolve os contadores REAIS, não o plantel inteiro pendente', async () => {
    await concluirRevisao();
    const res = await getState();

    expect(res.status).toBe(200);
    expect(res.body.review.status).toBe('completed');
    expect(res.body.review_status).toBe('completed'); // o front distingue sem inferir
    expect(res.body.summary).toMatchObject({
      inherited_total: 3, recognized: 1, not_recognized: 2, pending: 0,
    });
  });

  test('o summary é consultado COM o id da revisão concluída (não pela variante sem revisão)', async () => {
    const reviewId = await concluirRevisao();
    db.query.mockClear();
    await getState();

    const calls = db.query.mock.calls.filter((c) => tagOf(c[0]) === 'summary');
    expect(calls).toHaveLength(1);
    // Escopo confrontado com a LINHA simulada — a revisão que existe no
    // estado, e que está concluída —, nunca com uma constante do arquivo.
    expect(state.reviews[reviewId].status).toBe('completed');
    expect(calls[0][1][2]).toBe(state.reviews[reviewId].id);
    expect(db.query.mock.calls.some((c) => tagOf(c[0]) === 'summary-no-review')).toBe(false);
  });

  test('a listagem continua mostrando as marcações (não volta todo mundo para pending)', async () => {
    const reviewId = await concluirRevisao();
    const res = await getRoster();

    expect(res.status).toBe(200);
    expect(res.body.review_id).toBe(state.reviews[reviewId].id);
    expect(res.body.review_status).toBe('completed');
    const byId = {};
    for (const r of res.body.data) byId[r.practitioner_id] = r.review_status;
    expect(byId[PRAC_A]).toBe('recognized');
    expect(byId[PRAC_B]).toBe('not_recognized');
    expect(byId[PRAC_C]).toBe('not_recognized');

    const pend = await getRoster('?review_status=pending');
    expect(pend.body.count).toBe(0);
  });

  test('plantel que CRESCEU depois: só o praticante novo conta como pendente', async () => {
    await concluirRevisao();
    // Entrou na federação DEPOIS da revisão — nunca foi revisado, então
    // pendente é o certo ("marque abaixo se o plantel mudou desde então").
    state.practitioners[PRAC_D] = prac(PRAC_D, 'Diego Entrou Depois', '1004-D', true, DOJO_ID);

    const res = await getState();
    expect(res.body.summary).toMatchObject({
      inherited_total: 4, recognized: 1, not_recognized: 2, pending: 1,
    });

    const pend = await getRoster('?review_status=pending');
    expect(pend.body.count).toBe(1);
    expect(pend.body.data[0].practitioner_id).toBe(PRAC_D);

    // E os outros três mantiveram a marcação.
    const all = await getRoster();
    const marcados = all.body.data.filter((r) => r.review_status !== 'pending');
    expect(marcados.map((r) => r.practitioner_id).sort()).toEqual([PRAC_A, PRAC_B, PRAC_C].sort());
  });
});

// ═══════════════════════════════════════════════════════════
// *_label — congelar o NOME de quem agiu
//
// O JWT não tem name/email (signAccessToken assina só id/role/plan/...),
// então `req.user.name` gravava NULL em todos os *_label em produção. O
// rótulo agora vem de users.full_name, com fallback para email.
// ═══════════════════════════════════════════════════════════
describe('*_label vem de users.full_name, nunca do JWT', () => {
  test('reviewed_by_label e started_by_label saem da linha de users', async () => {
    const res = await mark([PRAC_A, PRAC_B], 'recognized');
    expect(res.status).toBe(200);

    // O nome do banco é DIFERENTE do `name` do token de teste — se o
    // handler voltasse a ler req.user.name, esta asserção quebraria.
    expect(state.users[USER_ID].full_name).not.toBe('Sensei Kondei');
    expect(state.items).toHaveLength(2);
    expect(state.items.every((i) => i.reviewed_by_label === DB_FULL_NAME)).toBe(true);
    expect(state.items.every((i) => i.reviewed_by === USER_ID)).toBe(true);

    const review = Object.values(state.reviews)[0];
    expect(review.started_by_label).toBe(DB_FULL_NAME);
    expect(review.started_by).toBe(USER_ID);
  });

  test('resolve o nome UMA vez por requisição, não por praticante', async () => {
    await mark([PRAC_A, PRAC_B, PRAC_C], 'recognized');
    const calls = db.query.mock.calls.filter((c) => tagOf(c[0]) === 'actor-label');
    expect(calls).toHaveLength(1);
    // E procurando pelo id do ator — confrontado com a linha simulada.
    expect(calls[0][1][0]).toBe(state.users[USER_ID].id);
  });

  test('cai para o email quando full_name é NULL', async () => {
    state.users[USER_ID].full_name = null;
    await mark([PRAC_A], 'recognized');
    expect(state.items[0].reviewed_by_label).toBe(DB_EMAIL);
  });

  test('sem full_name e sem email: label NULL, e a marcação NÃO falha', async () => {
    state.users[USER_ID].full_name = null;
    state.users[USER_ID].email = null;
    const res = await mark([PRAC_A], 'recognized');
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(1);
    expect(state.items[0].reviewed_by_label).toBeNull();
    expect(state.items[0].reviewed_by).toBe(USER_ID); // o uuid continua certo
  });

  test('completed_by_label e reported_by_label também vêm do banco', async () => {
    await mark([PRAC_A], 'recognized');
    await mark([PRAC_B, PRAC_C], 'not_recognized');
    const res = await completeAs({});

    expect(res.status).toBe(200);
    expect(res.body.review.completed_by_label).toBe(DB_FULL_NAME);
    expect(state.notices).toHaveLength(2);
    // É este rótulo que a federação lê na fila de avisos para saber quem
    // reportou — estava NULL em produção.
    expect(state.notices.every((n) => n.reported_by_label === DB_FULL_NAME)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// Migration 276 pendente — o código sobe antes do banco
// ═══════════════════════════════════════════════════════════
describe('schema pendente (migration 276 não aplicada)', () => {
  // Só as tabelas NOVAS faltam; customers e users existem e continuam
  // respondendo (por isso 'actor-label' não entra nesta lista).
  function mock276Pending() {
    db.query.mockReset();
    db.query.mockImplementation((sql, params) => {
      const t = tagOf(sql);
      const REVIEW_TABLES = [
        'open-review', 'latest-review', 'create-review', 'lock-review',
        'roster', 'roster-count', 'summary', 'mark', 'unmark',
        'fill-pending', 'notices-generate', 'complete',
        'notices-list', 'notices-summary', 'notice-lock', 'notice-decide',
      ];
      if (REVIEW_TABLES.includes(t)) {
        const err = new Error('relation "karate_dojo_roster_reviews" does not exist');
        err.code = '42P01';
        return Promise.reject(err);
      }
      return dispatch(sql, params);
    });
  }

  test('GET /dojo/roster-review degrada com schema_pending, sem 500', async () => {
    mock276Pending();
    const res = await getState();
    expect(res.status).toBe(200);
    expect(res.body.schema_pending).toBe(true);
    expect(res.body.review).toBeNull();
    expect(res.body.summary.inherited_total).toBe(3); // customers responde
  });

  test('GET .../roster ainda LISTA o plantel (todo mundo pending)', async () => {
    mock276Pending();
    const res = await getRoster();
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.review_id).toBeNull();
    expect(res.body.data.every((r) => r.review_status === 'pending')).toBe(true);
  });

  test('POST .../mark devolve 503 SCHEMA_PENDING', async () => {
    mock276Pending();
    const res = await request(buildDojoApp())
      .post(`/federation/${FED_ID}/dojo/roster-review/mark`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ practitioner_ids: [PRAC_A], status: 'recognized' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCHEMA_PENDING');
  });

  test('GET dos avisos (federação) degrada para fila vazia', async () => {
    mock276Pending();
    const res = await request(buildFedApp())
      .get(`/federation/${FED_ID}/roster-review-notices`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(res.body.schema_pending).toBe(true);
    expect(res.body.data).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// LADO FEDERAÇÃO — a fila de avisos e a decisão
// ═══════════════════════════════════════════════════════════
describe('GET /federation/:id/roster-review-notices', () => {
  async function seedNotices() {
    await mark([PRAC_A], 'recognized');
    await mark([PRAC_B, PRAC_C], 'not_recognized');
    await completeAs({});
  }

  test('lista os avisos da federação com snapshot + estado ATUAL do praticante', async () => {
    await seedNotices();
    const res = await request(buildFedApp())
      .get(`/federation/${FED_ID}/roster-review-notices`)
      .set('Authorization', 'Bearer ' + adminToken);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.summary).toMatchObject({ total: 2, pending: 2 });
    const b = res.body.data.find((n) => n.practitioner_id === PRAC_B);
    expect(b.reason).toBe('nao_reconhecido_pelo_sensei');
    expect(b.decision).toBe('pending');
    expect(b.practitioner_name).toBe('Bruno Parou em 2019');
    expect(b.practitioner_current_is_active).toBe(true); // NÃO foi inativado
    expect(b.practitioner_left_dojo).toBe(false);
  });

  test('aviso de OUTRA federação não aparece (escopo pelo :id do path)', async () => {
    await seedNotices();
    state.notices.push({
      id: NOTICE_ID, review_id: 'x', dojo_id: OTHER_DOJO_ID, federation_id: OTHER_FED_ID,
      practitioner_id: PRAC_ALIEN, practitioner_name: 'De outra federação',
      practitioner_fpkt_number: '9999-D', practitioner_was_active: true,
      reason: 'nao_reconhecido_pelo_sensei', reported_at: '2026-08-11T12:00:00.000Z',
      decision: 'pending', decision_note: null, destination_dojo_id: null,
      decided_by: null, decided_by_label: null, decided_at: null,
    });

    const res = await request(buildFedApp())
      .get(`/federation/${FED_ID}/roster-review-notices`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.body.data.map((n) => n.id)).not.toContain(NOTICE_ID);
    expect(res.body.count).toBe(2);
  });

  test('?decision=pending filtra', async () => {
    await seedNotices();
    const res = await request(buildFedApp())
      .get(`/federation/${FED_ID}/roster-review-notices?decision=pending`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.body.count).toBe(2);
  });

  test('/metrics é rota ESTÁTICA e não cai em /:noticeId', async () => {
    await seedNotices();
    const res = await request(buildFedApp())
      .get(`/federation/${FED_ID}/roster-review-notices/metrics`)
      .set('Authorization', 'Bearer ' + adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, pending: 2, inactivated: 0, transferred: 0, kept: 0 });
  });
});

describe('POST /federation/:id/roster-review-notices/:noticeId/decision', () => {
  async function seedOneNotice() {
    await mark([PRAC_A, PRAC_C], 'recognized');
    await mark([PRAC_B], 'not_recognized');
    await completeAs({});
    state.clientSql = [];
    db.connect.mockClear(); // a conclusão acima já abriu uma transação
    return state.notices[0].id;
  }

  const decide = (noticeId, body) =>
    request(buildFedApp())
      .post(`/federation/${FED_ID}/roster-review-notices/${noticeId}/decision`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send(body);

  test("'kept' registra a decisão e NÃO toca no praticante", async () => {
    const id = await seedOneNotice();
    const res = await decide(id, { decision: 'kept', note: 'Confirmei por telefone, segue treinando' });

    expect(res.status).toBe(200);
    expect(res.body.notice.decision).toBe('kept');
    expect(res.body.effect.practitioner_changed).toBe(false);
    expect(clientSqlJoined()).not.toMatch(/UPDATE\s+customers/i);
    expect(state.practitioners[PRAC_B].is_active).toBe(true);
  });

  test("'inactivated' é o ÚNICO caminho que inativa — e só a federação o percorre", async () => {
    const id = await seedOneNotice();
    const res = await decide(id, { decision: 'inactivated', note: 'Sem contato desde 2019' });

    expect(res.status).toBe(200);
    expect(res.body.effect).toMatchObject({ practitioner_changed: true, is_active: false });
    expect(state.practitioners[PRAC_B].is_active).toBe(false);
    // Escopado por praticante + federação + DOJÔ QUE AVISOU.
    const upd = state.clientSql.find((s) => /drr:inactivate-practitioner/.test(s));
    expect(upd).toMatch(/federation_id = \$2/);
    expect(upd).toMatch(/dojo_id = \$3/);
  });

  test('409 PRATICANTE_JA_SAIU_DO_DOJO quando ele já foi transferido depois do aviso', async () => {
    const id = await seedOneNotice();
    state.practitioners[PRAC_B].dojo_id = OTHER_DOJO_ID; // mudou entre o aviso e a decisão

    const res = await decide(id, { decision: 'inactivated' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRATICANTE_JA_SAIU_DO_DOJO');
    expect(state.practitioners[PRAC_B].is_active).toBe(true); // nada foi inativado
    expect(state.notices[0].decision).toBe('pending');        // aviso segue na fila
  });

  test("'transferred' move o praticante E grava karate_practitioner_transfers", async () => {
    const id = await seedOneNotice();
    const res = await decide(id, { decision: 'transferred', destination_dojo_id: DEST_DOJO_ID });

    expect(res.status).toBe(200);
    expect(res.body.effect).toMatchObject({ practitioner_changed: true, moved_to_dojo_id: DEST_DOJO_ID });
    expect(state.practitioners[PRAC_B].dojo_id).toBe(DEST_DOJO_ID);
    expect(state.practitioners[PRAC_B].is_active).toBe(true); // transferir não inativa
    expect(state.transfers).toHaveLength(1);
    expect(state.notices[0].destination_dojo_id).toBe(DEST_DOJO_ID);
  });

  test("'transferred' sem destination_dojo_id é 422 e nem abre transação", async () => {
    const id = await seedOneNotice();
    const res = await decide(id, { decision: 'transferred' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DESTINATION_REQUIRED');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('destino que não é dojô desta federação é 422 DESTINATION_INVALID', async () => {
    const id = await seedOneNotice();
    const res = await decide(id, { decision: 'transferred', destination_dojo_id: OTHER_DOJO_ID });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DESTINATION_INVALID');
    expect(state.practitioners[PRAC_B].dojo_id).toBe(DOJO_ID);
  });

  test('decisão inválida é 422', async () => {
    const id = await seedOneNotice();
    const res = await decide(id, { decision: 'apagar' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('decidir duas vezes é 409 AVISO_JA_DECIDIDO (sem segundo efeito)', async () => {
    const id = await seedOneNotice();
    await decide(id, { decision: 'kept' });
    const again = await decide(id, { decision: 'inactivated' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('AVISO_JA_DECIDIDO');
    expect(state.practitioners[PRAC_B].is_active).toBe(true);
  });

  test('aviso de OUTRA federação é 404 (escopo pelo :id do path, não pela constante)', async () => {
    await seedOneNotice();
    state.notices.push({
      id: NOTICE_ID, review_id: 'x', dojo_id: OTHER_DOJO_ID, federation_id: OTHER_FED_ID,
      practitioner_id: PRAC_ALIEN, practitioner_name: 'De outra federação',
      practitioner_fpkt_number: '9999-D', practitioner_was_active: true,
      reason: 'nao_reconhecido_pelo_sensei', reported_at: '2026-08-11T12:00:00.000Z',
      decision: 'pending', decision_note: null, destination_dojo_id: null,
      decided_by: null, decided_by_label: null, decided_at: null,
    });

    const res = await decide(NOTICE_ID, { decision: 'kept' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(state.notices.find((n) => n.id === NOTICE_ID).decision).toBe('pending');
  });
});

// ═══════════════════════════════════════════════════════════
// decided_by_label — o MESMO defeito do #489, do lado da FEDERAÇÃO
//
// Validado em produção em 12/08/2026: as três decisões (manter, transferir,
// inativar) gravaram `decision` e `decision_note` corretos e `decided_by`
// com uuid válido — e `decided_by_label` NULL nas TRÊS. A causa é a mesma
// do lado do dojô: a rota mandava `label: req.user.name || req.user.email`
// e `signAccessToken` não assina nenhum dos dois.
//
// Por que a coluna importa: ela CONGELA quem decidiu no momento da decisão.
// Inativar ou transferir um praticante muda o cadastro de uma pessoa; o
// usuário que decidiu pode sair da federação depois, e um JOIN feito no
// futuro devolveria nada. A trilha não pode depender de um vínculo vivo.
//
// O token admin desta suíte carrega `name: 'FPKT Staff'` DE PROPÓSITO e o
// banco tem outro nome: se alguém reintroduzir a leitura do token, as
// asserções abaixo apontam exatamente isso.
// ═══════════════════════════════════════════════════════════
describe('decided_by_label vem de users.full_name (lado FEDERAÇÃO)', () => {
  const decide = (noticeId, body) =>
    request(buildFedApp())
      .post(`/federation/${FED_ID}/roster-review-notices/${noticeId}/decision`)
      .set('Authorization', 'Bearer ' + adminToken)
      .send(body);

  // Um aviso só (PRAC_B). Limpa os mocks DEPOIS de semear: as chamadas de
  // marcação/conclusão também resolvem o rótulo (lado dojô) e contaminariam
  // a contagem de 'actor-label' da decisão.
  async function seedOneNotice() {
    await mark([PRAC_A, PRAC_C], 'recognized');
    await mark([PRAC_B], 'not_recognized');
    await completeAs({});
    state.clientSql = [];
    db.query.mockClear();
    db.connect.mockClear();
    return state.notices[0].id;
  }

  // Três avisos (A, B e C não reconhecidos) para exercitar as três decisões
  // numa federação só — foi exatamente o cenário validado em produção.
  async function seedThreeNotices() {
    await mark([PRAC_A, PRAC_B, PRAC_C], 'not_recognized');
    await completeAs({});
    expect(state.notices).toHaveLength(3);
    state.clientSql = [];
    db.query.mockClear();
    db.connect.mockClear();
    return state.notices.map((n) => n.id);
  }

  test('a decisão grava decided_by_label da LINHA DE users, não do JWT', async () => {
    const id = await seedOneNotice();
    const res = await decide(id, { decision: 'kept', note: 'Confirmei por telefone' });

    expect(res.status).toBe(200);
    // O `name` que existe no token admin é OUTRO — se o handler voltasse a
    // lê-lo, o rótulo gravado seria 'FPKT Staff' e isto quebraria.
    expect(state.users[USER_ID].full_name).not.toBe('FPKT Staff');
    expect(state.notices[0].decided_by_label).toBe(DB_FULL_NAME);
    expect(state.notices[0].decided_by).toBe(USER_ID);
    // E o contrato de resposta carrega o mesmo rótulo (o front mostra
    // "decidido por" sem uma segunda chamada).
    expect(res.body.notice.decided_by_label).toBe(DB_FULL_NAME);
  });

  test('as TRÊS decisões gravam o rótulo (em produção vieram NULL nas três)', async () => {
    const [idA, idB, idC] = await seedThreeNotices();

    const kept = await decide(idA, { decision: 'kept' });
    const inativado = await decide(idB, { decision: 'inactivated', note: 'Sem contato desde 2019' });
    const transferido = await decide(idC, {
      decision: 'transferred', destination_dojo_id: DEST_DOJO_ID,
    });

    expect([kept.status, inativado.status, transferido.status]).toEqual([200, 200, 200]);
    // A conferência é feita contra as LINHAS simuladas (o que ficou gravado),
    // não contra o corpo da resposta.
    expect(state.notices.map((n) => n.decision)).toEqual(['kept', 'inactivated', 'transferred']);
    expect(state.notices.map((n) => n.decided_by_label))
      .toEqual([DB_FULL_NAME, DB_FULL_NAME, DB_FULL_NAME]);
    expect(state.notices.every((n) => n.decided_by === state.users[USER_ID].id)).toBe(true);
  });

  test('resolve o rótulo UMA vez por requisição e FORA da transação', async () => {
    const id = await seedOneNotice();
    await decide(id, { decision: 'kept' });

    const calls = db.query.mock.calls.filter((c) => tagOf(c[0]) === 'actor-label');
    expect(calls).toHaveLength(1);
    // Procurando pelo id do ator — confrontado com a linha simulada de users,
    // nunca com a constante USER_ID do arquivo.
    expect(calls[0][1][0]).toBe(state.users[USER_ID].id);
    // FORA do BEGIN: um SELECT que falhasse dentro da transação a
    // envenenaria (25P02) e derrubaria a decisão por causa de um enfeite.
    expect(state.clientSql.some((s) => /drr:actor-label/.test(s))).toBe(false);
  });

  test('cai para o email quando full_name é NULL', async () => {
    const id = await seedOneNotice();
    state.users[USER_ID].full_name = null;

    const res = await decide(id, { decision: 'kept' });
    expect(res.status).toBe(200);
    expect(state.notices[0].decided_by_label).toBe(DB_EMAIL);
  });

  test('sem full_name e sem email: rótulo NULL e a decisão acontece do mesmo jeito', async () => {
    const id = await seedOneNotice();
    state.users[USER_ID].full_name = null;
    state.users[USER_ID].email = null;

    const res = await decide(id, { decision: 'kept' });
    expect(res.status).toBe(200);
    expect(state.notices[0].decision).toBe('kept');
    expect(state.notices[0].decided_by_label).toBeNull();
    expect(state.notices[0].decided_by).toBe(USER_ID); // o uuid continua certo
  });

  test('BEST-EFFORT: se o SELECT em users falhar, a decisão AINDA é registrada', async () => {
    const id = await seedOneNotice();
    // Só a resolução do rótulo quebra; todo o resto do banco responde.
    db.query.mockImplementation((sql, params) => {
      if (tagOf(sql) === 'actor-label') {
        const err = new Error('terminating connection due to administrator command');
        err.code = '57P01';
        return Promise.reject(err);
      }
      return dispatch(sql, params);
    });

    const res = await decide(id, { decision: 'inactivated', note: 'Sem contato desde 2019' });

    expect(res.status).toBe(200);
    // O ATO aconteceu — é ele que não pode depender do enfeite.
    expect(res.body.effect).toMatchObject({ practitioner_changed: true, is_active: false });
    expect(state.practitioners[PRAC_B].is_active).toBe(false);
    expect(state.notices[0].decision).toBe('inactivated');
    expect(state.notices[0].decision_note).toBe('Sem contato desde 2019');
    // O uuid (dado forte, vem do token) continua certo; só o rótulo cai.
    expect(state.notices[0].decided_by).toBe(USER_ID);
    expect(state.notices[0].decided_by_label).toBeNull();
  });

  test('a transferência registra o ator resolvido em karate_practitioner_transfers', async () => {
    const id = await seedOneNotice();
    const res = await decide(id, { decision: 'transferred', destination_dojo_id: DEST_DOJO_ID });

    expect(res.status).toBe(200);
    expect(state.transfers).toHaveLength(1);
    // initiated_by é o $8 do INSERT — o uuid do ator, confrontado com a
    // linha simulada de users.
    expect(state.transfers[0].params[7]).toBe(state.users[USER_ID].id);
    expect(state.notices[0].decided_by_label).toBe(DB_FULL_NAME);
  });
});
