// ============================================================
// AURA DOJÔ — F11: Tags configuráveis do aluno (migration 274)
//
// MOCK POR SQL, NUNCA POR POSIÇÃO — toda SQL do service começa com uma
// âncora `-- dtag:<nome>`. O despacho abaixo lê a âncora por regex (mesmo
// padrão de __tests__/karate.dojoBeltExam.test.js). Fila posicional já
// derrubou o CI deste repo 4 vezes (CLAUDE.md).
//
// ESCOPO: em TODO caso que simula "linha existe neste dojô", a comparação
// é sempre contra o PARÂMETRO da query (o dojo_id que veio do token) e
// NUNCA contra a constante DOJO_ID do teste — comparar com a constante
// seria uma tautologia e mascararia exatamente o bug que o teste
// "tag/aluno de outro dojô é 404" existe para provar.
//
// db.query/db.connect vêm do mock GLOBAL (tests/jest.setup.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const tagsRouter = require('../src/routes/karateDojoTags');

const SECRET = 'aura-test-secret-2026'; // igual ao forçado em tests/jest.setup.js

const DOJO_ID = 'dojo-areikan-1';
const OTHER_DOJO_ID = 'dojo-outro-2';
const FED_ID = 'fed-fpkt-1';
const STUDENT_ID = 'student-1';
const OTHER_DOJO_STUDENT_ID = 'student-outro-dojo';
const TAG_ID = 'tag-escola-i';
const OTHER_DOJO_TAG_ID = 'tag-outro-dojo';

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
  app.use('/federation/:id', tagsRouter);
  return app;
}

function tagOf(sql) {
  const m = String(sql).match(/--\s*dtag:([a-z-]+)/i);
  return m ? m[1] : null;
}

function baseState() {
  return {
    tags: {
      [TAG_ID]: {
        id: TAG_ID,
        dojo_id: DOJO_ID,
        name: 'Escola I Karate Areikan',
        color: null,
        active: true,
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
      [OTHER_DOJO_TAG_ID]: {
        id: OTHER_DOJO_TAG_ID,
        dojo_id: OTHER_DOJO_ID,
        name: 'Tag de outro dojô',
        color: null,
        active: true,
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
    },
    students: {
      [STUDENT_ID]: { id: STUDENT_ID, dojo_id: DOJO_ID },
      [OTHER_DOJO_STUDENT_ID]: { id: OTHER_DOJO_STUDENT_ID, dojo_id: OTHER_DOJO_ID },
    },
    studentTags: [], // { student_id, tag_id }
    seq: 0,
    calls: { creates: [], assigns: [], removes: [] },
  };
}

let state;

function studentCountOf(tagId) {
  return state.studentTags.filter((st) => st.tag_id === tagId).length;
}

function poolQuery(sql, params) {
  const s = String(sql);
  const p = params || [];
  switch (tagOf(s)) {
    case 'list': {
      // params: [dojoId, active]
      const rows = Object.values(state.tags)
        .filter((t) => t.dojo_id === p[0] && (p[1] === null || p[1] === undefined || t.active === p[1]))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({ ...t, student_count: studentCountOf(t.id) }));
      return Promise.resolve({ rows });
    }
    case 'get': {
      // params: [tagId, dojoId] — escopo contra p[1], nunca contra DOJO_ID.
      const t = state.tags[p[0]];
      if (!t || t.dojo_id !== p[1]) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ ...t, student_count: studentCountOf(t.id) }] });
    }
    case 'create': {
      // params: [dojoId, name, color, active]
      const [dojoIdV, name, color, active] = p;
      const dup = Object.values(state.tags).some(
        (t) => t.dojo_id === dojoIdV && t.name.toLowerCase() === String(name).toLowerCase()
      );
      if (dup) {
        const err = new Error('duplicate key value violates unique constraint "uq_karate_dojo_tags_dojo_name_ci"');
        err.code = '23505';
        return Promise.reject(err);
      }
      const id = 'tag-new-' + ++state.seq;
      const row = {
        id,
        dojo_id: dojoIdV,
        name,
        color: color != null ? color : null,
        active: active === true || active === false ? active : true,
        created_at: '2026-08-09T00:00:00.000Z',
        updated_at: '2026-08-09T00:00:00.000Z',
      };
      state.tags[id] = row;
      state.calls.creates.push({ sql: s, params: p });
      return Promise.resolve({ rows: [row] });
    }
    case 'update': {
      // últimos dois params são sempre [tagId, dojoId] (ver service).
      const tagIdV = p[p.length - 2];
      const dojoIdV = p[p.length - 1];
      const t = state.tags[tagIdV];
      if (!t || t.dojo_id !== dojoIdV) return Promise.resolve({ rows: [] });

      const setMatches = [...s.matchAll(/(name|color|active) = \$(\d+)/g)];
      let newName = t.name;
      for (const m of setMatches) {
        const col = m[1];
        const idx = Number(m[2]) - 1;
        if (col === 'name') newName = p[idx];
        else t[col] = p[idx];
      }
      if (newName !== t.name) {
        const dup = Object.values(state.tags).some(
          (other) => other.id !== t.id && other.dojo_id === t.dojo_id && other.name.toLowerCase() === String(newName).toLowerCase()
        );
        if (dup) {
          const err = new Error('duplicate key value violates unique constraint "uq_karate_dojo_tags_dojo_name_ci"');
          err.code = '23505';
          return Promise.reject(err);
        }
        t.name = newName;
      }
      t.updated_at = '2026-08-09T01:00:00.000Z';
      return Promise.resolve({ rows: [{ id: t.id }] });
    }
    case 'delete-lookup': {
      // params: [tagId, dojoId]
      const t = state.tags[p[0]];
      if (!t || t.dojo_id !== p[1]) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ id: t.id }] });
    }
    case 'delete-usage': {
      // params: [tagId]
      return Promise.resolve({ rows: [{ n: studentCountOf(p[0]) }] });
    }
    case 'delete': {
      // params: [tagId, dojoId]
      const t = state.tags[p[0]];
      if (t && t.dojo_id === p[1]) delete state.tags[p[0]];
      return Promise.resolve({ rows: [] });
    }
    case 'assert-student': {
      // params: [studentId, dojoId]
      const st = state.students[p[0]];
      if (!st || st.dojo_id !== p[1]) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ id: st.id }] });
    }
    case 'assert-tag': {
      // params: [tagId, dojoId]
      const t = state.tags[p[0]];
      if (!t || t.dojo_id !== p[1]) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ id: t.id, active: t.active }] });
    }
    case 'list-student-tags': {
      // params: [studentId, dojoId]
      const tagIds = state.studentTags.filter((st) => st.student_id === p[0]).map((st) => st.tag_id);
      const rows = tagIds
        .map((tid) => state.tags[tid])
        .filter((t) => t && t.dojo_id === p[1])
        .sort((a, b) => a.name.localeCompare(b.name));
      return Promise.resolve({ rows });
    }
    case 'assign': {
      // params: [studentId, tagId]
      const already = state.studentTags.some((st) => st.student_id === p[0] && st.tag_id === p[1]);
      if (!already) state.studentTags.push({ student_id: p[0], tag_id: p[1] });
      state.calls.assigns.push({ sql: s, params: p });
      return Promise.resolve({ rows: [] });
    }
    case 'remove': {
      // params: [studentId, tagId, dojoId]
      const t = state.tags[p[1]];
      if (t && t.dojo_id === p[2]) {
        state.studentTags = state.studentTags.filter((st) => !(st.student_id === p[0] && st.tag_id === p[1]));
      }
      state.calls.removes.push({ sql: s, params: p });
      return Promise.resolve({ rows: [] });
    }
    default:
      return Promise.resolve({ rows: [] });
  }
}

beforeEach(() => {
  state = baseState();
  db.query.mockReset();
  db.query.mockImplementation(poolQuery);
});

// ── GET /dojo/tags ──
describe('GET /federation/:id/dojo/tags', () => {
  test('lista as tags do dojô com a contagem de alunos', async () => {
    state.studentTags.push({ student_id: STUDENT_ID, tag_id: TAG_ID });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/tags`)
      .set('Authorization', 'Bearer ' + tokenA);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0]).toMatchObject({ id: TAG_ID, name: 'Escola I Karate Areikan', student_count: 1 });
  });

  test('?active=false devolve só as desativadas', async () => {
    state.tags['tag-inativa'] = {
      id: 'tag-inativa',
      dojo_id: DOJO_ID,
      name: 'Turma extinta',
      color: null,
      active: false,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    };
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/tags?active=false`)
      .set('Authorization', 'Bearer ' + tokenA);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('tag-inativa');
  });

  test('Canal B (portal) também pode listar', async () => {
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/tags`)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(res.status).toBe(200);
  });
});

// ── POST /dojo/tags ──
describe('POST /federation/:id/dojo/tags', () => {
  test('cria uma tag nova', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/tags`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ name: 'SESC Areikan', color: '#7c3aed' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'SESC Areikan', color: '#7c3aed', active: true, student_count: 0 });
  });

  test('name vazio é 422', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/tags`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ name: '   ' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('nome duplicado (case-insensitive) no MESMO dojô é 409', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/tags`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ name: 'escola i karate areikan' }); // mesma tag, caixa diferente
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_TAG_NAME');
  });

  test('o mesmo nome em OUTRO dojô não conflita', async () => {
    state.tags['tag-outra-cor'] = {
      id: 'tag-outra-cor',
      dojo_id: OTHER_DOJO_ID,
      name: 'Bolsista',
      color: null,
      active: true,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    };
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/tags`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ name: 'Bolsista' });
    expect(res.status).toBe(201);
  });

  test('Canal B (portal) não pode criar — 403 PORTAL_READ_ONLY', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/tags`)
      .set('Authorization', 'Bearer ' + tokenB)
      .send({ name: 'Nova tag' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
  });
});

// ── PATCH /dojo/tags/:tid ──
describe('PATCH /federation/:id/dojo/tags/:tid', () => {
  test('renomeia a tag', async () => {
    const res = await request(buildApp())
      .patch(`/federation/${FED_ID}/dojo/tags/${TAG_ID}`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ name: 'Escola I Karate Areikan (matriz)' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Escola I Karate Areikan (matriz)');
  });

  test('desativa a tag (active:false) — vínculos existentes continuam', async () => {
    state.studentTags.push({ student_id: STUDENT_ID, tag_id: TAG_ID });
    const res = await request(buildApp())
      .patch(`/federation/${FED_ID}/dojo/tags/${TAG_ID}`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(res.body.student_count).toBe(1); // desativar não apaga o vínculo
  });

  test('tag de OUTRO dojô é 404 (escopo sempre pelo token)', async () => {
    const res = await request(buildApp())
      .patch(`/federation/${FED_ID}/dojo/tags/${OTHER_DOJO_TAG_ID}`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ name: 'Tentando renomear tag alheia' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

// ── DELETE /dojo/tags/:tid ──
describe('DELETE /federation/:id/dojo/tags/:tid', () => {
  test('apaga de verdade uma tag sem nenhum vínculo', async () => {
    const res = await request(buildApp())
      .delete(`/federation/${FED_ID}/dojo/tags/${TAG_ID}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: TAG_ID });
  });

  test('tag EM USO não apaga — 409 TAG_EM_USO (desativar preserva histórico)', async () => {
    state.studentTags.push({ student_id: STUDENT_ID, tag_id: TAG_ID });
    const res = await request(buildApp())
      .delete(`/federation/${FED_ID}/dojo/tags/${TAG_ID}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TAG_EM_USO');
    expect(state.tags[TAG_ID]).toBeDefined(); // não foi apagada
  });

  test('tag de outro dojô é 404, não 409 (nem chega a olhar uso)', async () => {
    const res = await request(buildApp())
      .delete(`/federation/${FED_ID}/dojo/tags/${OTHER_DOJO_TAG_ID}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(404);
  });
});

// ── GET/POST/DELETE /dojo/students/:sid/tags ──
describe('tags de um aluno', () => {
  test('GET lista as tags do aluno', async () => {
    state.studentTags.push({ student_id: STUDENT_ID, tag_id: TAG_ID });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/students/${STUDENT_ID}/tags`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(TAG_ID);
    expect(res.body.data[0].student_count).toBeUndefined(); // não faz sentido aqui
  });

  test('POST atribui uma tag ativa ao aluno', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/students/${STUDENT_ID}/tags`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ tag_id: TAG_ID });
    expect(res.status).toBe(201);
    expect(res.body.data.map((t) => t.id)).toContain(TAG_ID);
    expect(state.calls.assigns).toHaveLength(1);
  });

  test('POST sem tag_id é 422', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/students/${STUDENT_ID}/tags`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({});
    expect(res.status).toBe(422);
  });

  test('POST com tag DESATIVADA é 422 TAG_INATIVA', async () => {
    state.tags[TAG_ID].active = false;
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/students/${STUDENT_ID}/tags`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ tag_id: TAG_ID });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TAG_INATIVA');
  });

  test('POST com aluno de OUTRO dojô é 404 (escopo sempre pelo token)', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/students/${OTHER_DOJO_STUDENT_ID}/tags`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ tag_id: TAG_ID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('STUDENT_NOT_FOUND');
  });

  test('POST com tag de outro dojô é 404', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/students/${STUDENT_ID}/tags`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ tag_id: OTHER_DOJO_TAG_ID });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TAG_NOT_FOUND');
  });

  test('DELETE remove a tag do aluno', async () => {
    state.studentTags.push({ student_id: STUDENT_ID, tag_id: TAG_ID });
    const res = await request(buildApp())
      .delete(`/federation/${FED_ID}/dojo/students/${STUDENT_ID}/tags/${TAG_ID}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  test('DELETE de uma tag não atribuída é idempotente (200, não erro)', async () => {
    const res = await request(buildApp())
      .delete(`/federation/${FED_ID}/dojo/students/${STUDENT_ID}/tags/${TAG_ID}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
  });

  test('Canal B não pode atribuir tag — 403 PORTAL_READ_ONLY', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/students/${STUDENT_ID}/tags`)
      .set('Authorization', 'Bearer ' + tokenB)
      .send({ tag_id: TAG_ID });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
  });
});

// ── defensivo: migration 274 pendente (tabela ainda não existe) ──
describe('schema pendente (migration 274 não aplicada)', () => {
  test('GET /dojo/tags devolve lista vazia + schema_pending', async () => {
    db.query.mockReset();
    db.query.mockImplementation(() => {
      const err = new Error('relation "karate_dojo_tags" does not exist');
      err.code = '42P01';
      return Promise.reject(err);
    });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/tags`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], count: 0, schema_pending: true });
  });

  test('POST /dojo/tags devolve 503 SCHEMA_PENDING', async () => {
    db.query.mockReset();
    db.query.mockImplementation(() => {
      const err = new Error('relation "karate_dojo_tags" does not exist');
      err.code = '42P01';
      return Promise.reject(err);
    });
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/tags`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ name: 'Qualquer coisa' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCHEMA_PENDING');
  });
});
