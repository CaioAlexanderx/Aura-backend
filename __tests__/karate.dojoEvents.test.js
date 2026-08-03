// ============================================================
// AURA DOJÔ — F9: testes dos EVENTOS DO DOJÔ (curso + seminário)
//
// Cobertura:
//   1. CRUD do evento (validação, get, update, cancel, isolamento por dojô)
//   2. Inscrição em lote (sucesso, duplicado, aluno inexistente, id
//      inválido, evento cancelado, reativação de inscrição cancelada)
//   3. Listar/cancelar inscrição individual
//   4. Canal B (portal) é read-only em toda escrita
//   5. Listagem unificada (events-hub): merge com o exame de kyu, filtro
//      por kind, normalização de status, degradação se a tabela do exame
//      de kyu ainda não existir (migration 264 pendente)
//
// ── ESTILO: MOCK POR SQL, NUNCA POR POSIÇÃO ────────────
// Toda SQL do service/rota começa com uma âncora `-- f9:<nome>`. O
// despacho abaixo lê a âncora por regex — nunca mockResolvedValueOnce em
// fila. Todo filtro de escopo (dojo_id) é comparado contra o campo do
// DADO SIMULADO (state.events[...].dojo_id, state.students[...].dojo_id),
// nunca contra a constante DOJO_ID do teste — comparar com a constante
// faria o mock nunca devolver vazio e o teste de isolamento não provaria
// nada (armadilha já vivida neste repo em karate.dojoBeltExam.test.js).
//
// db.query vem do mock GLOBAL (tests/jest.setup.js). Este service NÃO usa
// transação (nenhum BEGIN), então db.connect não é exercitado aqui.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const eventsRouter = require('../src/routes/karateDojoEvents');

const FED_ID = '11111111-1111-4111-8111-111111111111';
const DOJO_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const STUDENT_FED = '44444444-4444-4444-8444-444444444444';
const STUDENT_LOCAL = '55555555-5555-4555-8555-555555555555';
const PRACTITIONER = '66666666-6666-4666-8666-666666666666';
const EXAM_ID = '77777777-7777-4777-8777-777777777777';

const SECRET = 'aura-test-secret-2026';

const tokenA = jwt.sign(
  { type: 'access', id: 'user-sensei-1', name: 'Sensei Kondei', dojo_id: DOJO_ID, federation_id: FED_ID },
  SECRET,
  { expiresIn: '1h' }
);
const tokenB = jwt.sign(
  { type: 'portal', scope: 'dojo_portal', dojo_id: DOJO_ID, federation_id: FED_ID },
  SECRET,
  { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', eventsRouter);
  return app;
}

// ── Estado do "banco" ───────────────────────────────────────
let state;

function baseState() {
  return {
    events: {
      [EVENT_ID]: {
        id: EVENT_ID,
        dojo_id: DOJO_ID,
        federation_id: FED_ID,
        kind: 'curso',
        name: 'Curso de Kata Avançado',
        event_date: '2026-09-01',
        location: 'Dojô sede',
        fee_amount: 50,
        max_participants: 30,
        hours: 4,
        description: null,
        status: 'scheduled',
        created_by: 'user-sensei-1',
        created_by_name: 'Sensei Kondei',
        created_at: '2026-08-01T12:00:00Z',
        updated_at: '2026-08-01T12:00:00Z',
      },
    },
    enrollments: {},
    students: {
      [STUDENT_FED]: {
        id: STUDENT_FED,
        dojo_id: DOJO_ID,
        full_name: 'Aluna Federada',
        practitioner_id: PRACTITIONER,
        belt_label: 'Verde',
        status: 'active',
      },
      [STUDENT_LOCAL]: {
        id: STUDENT_LOCAL,
        dojo_id: DOJO_ID,
        full_name: 'Aluno do Dojô',
        practitioner_id: null,
        belt_label: 'Amarela',
        status: 'active',
      },
    },
    beltExams: [
      {
        id: EXAM_ID,
        dojo_id: DOJO_ID,
        title: 'Exame de agosto',
        exam_date: '2026-08-20',
        status: 'draft',
        results_count: 3,
      },
    ],
    beltExamsMissing: false,
    eventSeq: 0,
    enrollmentSeq: 0,
  };
}

function tagOf(sql) {
  const m = String(sql).match(/--\s*f9:([a-z-]+)/i);
  return m ? m[1] : null;
}

// Extrai pares {col, idx} de qualquer trecho "[alias.]coluna = $N" — usado
// tanto para filtros de WHERE quanto para atribuições de SET. Genérico de
// propósito: assim o mock não precisa de um case por combinação de
// filtros, e nenhuma comparação de escopo vira uma constante fixa no teste.
function extractEqFilters(sqlFragment) {
  const out = [];
  const re = /(?:\b\w+\.)?(\w+)\s*=\s*\$(\d+)/g;
  let m;
  while ((m = re.exec(sqlFragment))) {
    out.push({ col: m[1], idx: Number(m[2]) });
  }
  return out;
}

function poolQuery(sql, params) {
  const s = String(sql);
  const tag = tagOf(s);
  const p = params || [];

  switch (tag) {
    case 'load-event': {
      const ev = state.events[p[0]];
      return Promise.resolve({ rows: ev && ev.dojo_id === p[1] ? [ev] : [] });
    }

    case 'insert-event': {
      state.eventSeq += 1;
      const id = 'event-' + state.eventSeq;
      const row = {
        id,
        dojo_id: p[0],
        federation_id: p[1],
        kind: p[2],
        name: p[3],
        event_date: p[4],
        location: p[5],
        fee_amount: p[6],
        max_participants: p[7],
        hours: p[8],
        description: p[9],
        status: 'scheduled',
        created_by: p[10],
        created_by_name: p[11],
        created_at: '2026-08-03T10:00:00Z',
        updated_at: '2026-08-03T10:00:00Z',
      };
      state.events[id] = row;
      return Promise.resolve({ rows: [row] });
    }

    case 'update-event': {
      const [beforeWhere, whereClause] = s.split(/\bWHERE\b/i);
      const setMatch = beforeWhere.match(/SET\s+([\s\S]+)/i);
      const assignments = extractEqFilters(setMatch ? setMatch[1] : '');
      const whereFilters = extractEqFilters(whereClause || '');
      const row = Object.values(state.events).find((ev) =>
        whereFilters.every((f) => String(ev[f.col]) === String(p[f.idx - 1]))
      );
      if (row) assignments.forEach((a) => { row[a.col] = p[a.idx - 1]; });
      return Promise.resolve({ rows: [] });
    }

    case 'cancel-event': {
      const ev = state.events[p[0]];
      if (ev && ev.dojo_id === p[1]) ev.status = 'cancelled';
      return Promise.resolve({ rows: [] });
    }

    case 'list-events': {
      const whereFilters = extractEqFilters(s.split(/\bWHERE\b/i)[1] || '');
      const rows = Object.values(state.events).filter((ev) =>
        whereFilters.every((f) => !(f.col in ev) || String(ev[f.col]) === String(p[f.idx - 1]))
      );
      rows.sort((a, b) => (a.event_date < b.event_date ? 1 : -1));
      return Promise.resolve({
        rows: rows.map((ev) => Object.assign({}, ev, {
          participants_count: Object.values(state.enrollments).filter(
            (en) => en.event_id === ev.id && en.status === 'enrolled'
          ).length,
        })),
      });
    }

    case 'list-enrollments': {
      const rows = Object.values(state.enrollments).filter(
        (en) => en.event_id === p[0] && en.dojo_id === p[1]
      );
      return Promise.resolve({
        rows: rows.map((en) => {
          const student = state.students[en.student_id];
          return {
            id: en.id,
            student_id: en.student_id,
            practitioner_id: en.practitioner_id,
            status: en.status,
            fee_paid: en.fee_paid,
            notes: en.notes,
            created_at: en.created_at,
            student_name: student ? student.full_name : null,
            belt_label: student ? student.belt_label : null,
          };
        }),
      });
    }

    case 'find-enrollment': {
      const row = Object.values(state.enrollments).find(
        (en) => en.event_id === p[0] && en.student_id === p[1]
      );
      return Promise.resolve({ rows: row ? [{ id: row.id, status: row.status }] : [] });
    }

    case 'reactivate-enrollment': {
      const row = state.enrollments[p[1]];
      if (row) {
        row.status = 'enrolled';
        row.practitioner_id = p[0];
      }
      return Promise.resolve({ rows: [] });
    }

    case 'insert-enrollment': {
      state.enrollmentSeq += 1;
      const id = 'enr-' + state.enrollmentSeq;
      state.enrollments[id] = {
        id,
        event_id: p[0],
        dojo_id: p[1],
        student_id: p[2],
        practitioner_id: p[3],
        status: 'enrolled',
        fee_paid: false,
        notes: null,
        created_at: '2026-08-03T10:00:00Z',
      };
      return Promise.resolve({ rows: [{ id }] });
    }

    case 'cancel-enrollment': {
      const row = Object.values(state.enrollments).find(
        (en) => en.event_id === p[0] && en.dojo_id === p[1] && en.student_id === p[2]
      );
      if (row) row.status = 'cancelled';
      return Promise.resolve({ rows: row ? [{ id: row.id }] : [] });
    }

    case 'load-students': {
      const ids = p[1] || [];
      return Promise.resolve({
        rows: ids.map((id) => state.students[id]).filter((r) => r && r.dojo_id === p[0]),
      });
    }

    case 'hub-own-events': {
      const rows = Object.values(state.events).filter((ev) => ev.dojo_id === p[0]);
      rows.sort((a, b) => (a.event_date < b.event_date ? 1 : -1));
      return Promise.resolve({
        rows: rows.map((ev) => ({
          id: ev.id,
          kind: ev.kind,
          name: ev.name,
          event_date: ev.event_date,
          location: ev.location,
          status: ev.status,
          participants_count: Object.values(state.enrollments).filter(
            (en) => en.event_id === ev.id && en.status === 'enrolled'
          ).length,
        })),
      });
    }

    case 'hub-belt-exams': {
      if (state.beltExamsMissing) {
        const err = new Error('relation "karate_dojo_belt_exams" does not exist');
        err.code = '42P01';
        return Promise.reject(err);
      }
      const rows = state.beltExams.filter((e) => e.dojo_id === p[0]);
      rows.sort((a, b) => (a.exam_date < b.exam_date ? 1 : -1));
      return Promise.resolve({
        rows: rows.map((e) => ({
          id: e.id,
          title: e.title,
          exam_date: e.exam_date,
          status: e.status,
          participants_count: e.results_count,
        })),
      });
    }

    default:
      return Promise.resolve({ rows: [] });
  }
}

function postEvent(body) {
  return request(buildApp())
    .post(`/federation/${FED_ID}/dojo/own-events`)
    .set('Authorization', 'Bearer ' + tokenA)
    .send(body);
}

function patchEvent(eventId, body) {
  return request(buildApp())
    .patch(`/federation/${FED_ID}/dojo/own-events/${eventId}`)
    .set('Authorization', 'Bearer ' + tokenA)
    .send(body);
}

function enroll(eventId, studentIds) {
  return request(buildApp())
    .post(`/federation/${FED_ID}/dojo/own-events/${eventId}/enroll`)
    .set('Authorization', 'Bearer ' + tokenA)
    .send({ student_ids: studentIds });
}

beforeEach(() => {
  state = baseState();
  db.query.mockReset();
  db.query.mockImplementation(poolQuery);
});

// ============================================================
// 1) CRUD DO EVENTO
// ============================================================
describe('F9 — CRUD do evento do dojô', () => {
  test('criar exige kind, name e event_date', async () => {
    const res = await postEvent({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('kind fora de curso|seminario é recusado', async () => {
    const res = await postEvent({ kind: 'campeonato', name: 'x', event_date: '2026-09-01' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/kind inválido/i);
  });

  test('criar seminário com sucesso — status nasce scheduled, 0 participantes', async () => {
    const res = await postEvent({
      kind: 'seminario',
      name: 'Seminário de Kumite',
      event_date: '2026-10-05',
      location: 'Ginásio Municipal',
      fee_amount: 80,
      max_participants: 40,
      hours: 6,
    });
    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({
      kind: 'seminario',
      name: 'Seminário de Kumite',
      status: 'scheduled',
      participants_count: 0,
    });
  });

  test('fee_amount negativo é recusado', async () => {
    const res = await postEvent({ kind: 'curso', name: 'x', event_date: '2026-09-01', fee_amount: -10 });
    expect(res.status).toBe(422);
  });

  test('GET lista os eventos do dojô', async () => {
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/own-events`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: EVENT_ID, kind: 'curso' });
  });

  test('GET ficha do evento traz inscrições vazias inicialmente', async () => {
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/own-events/${EVENT_ID}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.event.id).toBe(EVENT_ID);
    expect(res.body.enrollments).toEqual([]);
  });

  test('evento inexistente é 404', async () => {
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/own-events/99999999-9999-4999-8999-999999999999`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('EVENTO_NAO_ENCONTRADO');
  });

  test('evento de OUTRO dojô é 404 (escopo sempre pelo token, nunca a constante do teste)', async () => {
    state.events[EVENT_ID].dojo_id = 'outro-dojo';
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/own-events/${EVENT_ID}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('EVENTO_NAO_ENCONTRADO');
  });

  test('PATCH edita campos e reflete na leitura seguinte', async () => {
    const res = await patchEvent(EVENT_ID, { name: 'Curso Renomeado', location: 'Novo local' });
    expect(res.status).toBe(200);
    expect(res.body.event.name).toBe('Curso Renomeado');
    expect(res.body.event.location).toBe('Novo local');
  });

  test('PATCH em evento CANCELADO é 409', async () => {
    state.events[EVENT_ID].status = 'cancelled';
    const res = await patchEvent(EVENT_ID, { name: 'tentando editar' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVENTO_CANCELADO');
  });

  test('PATCH aceita status=completed mas recusa status=cancelled (rota própria existe pra isso)', async () => {
    const res = await patchEvent(EVENT_ID, { status: 'cancelled' });
    expect(res.status).toBe(422);
  });

  test('cancelar evento marca status e é IDEMPOTENTE', async () => {
    const res1 = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/own-events/${EVENT_ID}/cancel`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({});
    expect(res1.status).toBe(200);
    expect(res1.body.event.status).toBe('cancelled');

    const res2 = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/own-events/${EVENT_ID}/cancel`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({});
    expect(res2.status).toBe(200);
    expect(res2.body.event.status).toBe('cancelled');
  });

  test('cancelar evento CONCLUÍDO é 409 — cancelar não desfaz o que já aconteceu', async () => {
    state.events[EVENT_ID].status = 'completed';
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/own-events/${EVENT_ID}/cancel`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVENTO_CONCLUIDO');
  });
});

// ============================================================
// 2) INSCRIÇÃO EM LOTE
// ============================================================
describe('F9 — inscrição em lote', () => {
  test('inscreve federado e não federado num lote só', async () => {
    const res = await enroll(EVENT_ID, [STUDENT_FED, STUDENT_LOCAL]);
    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(2);
    expect(res.body.skipped).toEqual([]);

    const fed = res.body.enrollments.find((e) => e.student_id === STUDENT_FED);
    const local = res.body.enrollments.find((e) => e.student_id === STUDENT_LOCAL);
    expect(fed.practitioner_id).toBe(PRACTITIONER);
    expect(local.practitioner_id).toBeNull();
  });

  test('reinscrever o mesmo aluno é JA_INSCRITO e não duplica', async () => {
    await enroll(EVENT_ID, [STUDENT_FED]);
    const res = await enroll(EVENT_ID, [STUDENT_FED]);
    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(0);
    expect(res.body.skipped[0]).toMatchObject({ student_id: STUDENT_FED, reason: 'JA_INSCRITO' });
    expect(Object.keys(state.enrollments)).toHaveLength(1);
  });

  test('student_id inválido é ID_INVALIDO', async () => {
    const res = await enroll(EVENT_ID, ['nao-e-uuid']);
    expect(res.status).toBe(200);
    expect(res.body.skipped[0]).toMatchObject({ reason: 'ID_INVALIDO' });
  });

  test('aluno de OUTRO dojô é ALUNO_NAO_ENCONTRADO (escopo pelo token)', async () => {
    state.students[STUDENT_FED].dojo_id = 'outro-dojo';
    const res = await enroll(EVENT_ID, [STUDENT_FED]);
    expect(res.status).toBe(200);
    expect(res.body.skipped[0]).toMatchObject({ student_id: STUDENT_FED, reason: 'ALUNO_NAO_ENCONTRADO' });
  });

  test('lote vazio é 422', async () => {
    const res = await enroll(EVENT_ID, []);
    expect(res.status).toBe(422);
  });

  test('evento CANCELADO recusa inscrição em lote (409, nada é gravado)', async () => {
    state.events[EVENT_ID].status = 'cancelled';
    const res = await enroll(EVENT_ID, [STUDENT_FED]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EVENTO_CANCELADO');
    expect(Object.keys(state.enrollments)).toHaveLength(0);
  });

  test('cancelar e reinscrever REATIVA a mesma linha — não duplica (UNIQUE event_id+student_id)', async () => {
    await enroll(EVENT_ID, [STUDENT_FED]);
    await request(buildApp())
      .delete(`/federation/${FED_ID}/dojo/own-events/${EVENT_ID}/enrollments/${STUDENT_FED}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(Object.values(state.enrollments)[0].status).toBe('cancelled');

    const res = await enroll(EVENT_ID, [STUDENT_FED]);
    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(1);
    expect(Object.keys(state.enrollments)).toHaveLength(1); // mesma linha, não uma segunda
    expect(Object.values(state.enrollments)[0].status).toBe('enrolled');
  });
});

// ============================================================
// 3) LISTAR / CANCELAR INSCRIÇÃO INDIVIDUAL
// ============================================================
describe('F9 — listar e cancelar inscrição', () => {
  test('GET enrollments traz nome e faixa do aluno', async () => {
    await enroll(EVENT_ID, [STUDENT_FED]);
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/own-events/${EVENT_ID}/enrollments`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ student_id: STUDENT_FED, name: 'Aluna Federada', belt_label: 'Verde' });
  });

  test('DELETE cancela a inscrição', async () => {
    await enroll(EVENT_ID, [STUDENT_FED]);
    const res = await request(buildApp())
      .delete(`/federation/${FED_ID}/dojo/own-events/${EVENT_ID}/enrollments/${STUDENT_FED}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.cancelled).toBe(true);
  });

  test('DELETE de inscrição inexistente é 404', async () => {
    const res = await request(buildApp())
      .delete(`/federation/${FED_ID}/dojo/own-events/${EVENT_ID}/enrollments/${STUDENT_LOCAL}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('INSCRICAO_NAO_ENCONTRADA');
  });
});

// ============================================================
// 4) CANAL B — O PORTAL É SOMENTE LEITURA
// ============================================================
describe('F9 — Canal B (portal do dojô) é read-only', () => {
  const writes = [
    ['post', `/federation/${FED_ID}/dojo/own-events`, { kind: 'curso', name: 'x', event_date: '2026-09-01' }],
    ['patch', `/federation/${FED_ID}/dojo/own-events/${EVENT_ID}`, { name: 'y' }],
    ['post', `/federation/${FED_ID}/dojo/own-events/${EVENT_ID}/cancel`, {}],
    ['post', `/federation/${FED_ID}/dojo/own-events/${EVENT_ID}/enroll`, { student_ids: [STUDENT_FED] }],
    ['delete', `/federation/${FED_ID}/dojo/own-events/${EVENT_ID}/enrollments/${STUDENT_FED}`, {}],
  ];

  test.each(writes)('%s %s → 403 PORTAL_READ_ONLY', async (method, path, body) => {
    const res = await request(buildApp())[method](path).set('Authorization', 'Bearer ' + tokenB).send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('Canal B LÊ normalmente (lista, ficha, hub)', async () => {
    const list = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/own-events`)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(list.status).toBe(200);

    const detail = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/own-events/${EVENT_ID}`)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(detail.status).toBe(200);

    const hub = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/events-hub`)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(hub.status).toBe(200);
  });

  test('sem token → 401 (não 403): não é permissão que falta, é sessão', async () => {
    const res = await request(buildApp()).get(`/federation/${FED_ID}/dojo/own-events`);
    expect(res.status).toBe(401);
  });
});

// ============================================================
// 5) LISTAGEM UNIFICADA (events-hub)
// ============================================================
describe('F9 — events-hub: eventos próprios + exame de kyu', () => {
  function getHub(query) {
    return request(buildApp())
      .get(`/federation/${FED_ID}/dojo/events-hub${query || ''}`)
      .set('Authorization', 'Bearer ' + tokenA);
  }

  test('junta as duas fontes com o MESMO formato de superfície', async () => {
    const res = await getHub();
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);

    const ownEvent = res.body.data.find((d) => d.source === 'dojo_event');
    const belt = res.body.data.find((d) => d.source === 'belt_exam');

    expect(ownEvent).toMatchObject({
      id: EVENT_ID,
      kind: 'curso',
      name: 'Curso de Kata Avançado',
      location: 'Dojô sede',
      status: 'scheduled',
    });
    expect(belt).toMatchObject({
      id: EXAM_ID,
      kind: 'exame_kyu',
      name: 'Exame de agosto',
      location: null, // karate_dojo_belt_exams não tem coluna de local
      status: 'scheduled', // normalizado de 'draft'
      native_status: 'draft',
      participants_count: 3,
    });
  });

  test('ordena por data DESC entre as duas fontes', async () => {
    // Exame (2026-08-20) vem ANTES do curso (2026-09-01) na ordem
    // cronológica; DESC inverte: curso primeiro.
    const res = await getHub();
    expect(res.body.data[0].id).toBe(EVENT_ID);
    expect(res.body.data[1].id).toBe(EXAM_ID);
  });

  test('filtro ?kind= restringe a uma fonte', async () => {
    const res = await getHub('?kind=exame_kyu');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].source).toBe('belt_exam');
  });

  test('exame concluído aparece com status=completed (sem normalização, já bate)', async () => {
    state.beltExams[0].status = 'completed';
    const res = await getHub('?kind=exame_kyu');
    expect(res.body.data[0].status).toBe('completed');
  });

  test('degrada com elegância se karate_dojo_belt_exams ainda não existir (migration 264 pendente)', async () => {
    state.beltExamsMissing = true;
    const res = await getHub();
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].source).toBe('dojo_event');
  });

  test('evento de outro dojô não aparece no hub (escopo pelo token)', async () => {
    state.events[EVENT_ID].dojo_id = 'outro-dojo';
    state.beltExams[0].dojo_id = 'outro-dojo';
    const res = await getHub();
    expect(res.body.count).toBe(0);
    expect(res.body.data).toEqual([]);
  });
});
