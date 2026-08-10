// ============================================================
// AURA DOJÔ — F9.1: testes do CERTIFICADO PRÓPRIO DO DOJÔ
//
// Cobertura:
//   1. CRUD do template (criar com defaults, listar, editar, apagar)
//   2. Emissão em massa a partir de um exame (só aprovados, antidup por
//      exame+aluno, filtro por student_ids, fallback de assinatura pro
//      examinador quando o template não tem nenhuma, aluno não federado
//      também é emitido)
//   3. Isolamento por dojô (exame de OUTRO dojô é 404 — escopo sempre
//      pelo campo do DADO simulado, nunca pela constante do teste)
//   4. Listagem por exame + status geral
//   5. Canal B (portal) é read-only em toda escrita
//
// ── ESTILO: MOCK POR SQL, NUNCA POR POSIÇÃO ────────────
// Toda SQL da rota começa com uma âncora `-- f91:<nome>`. O despacho
// abaixo lê a âncora por regex — nunca mockResolvedValueOnce em fila
// (arapuca já derrubou este CI 4 vezes, ver karate.dojoBeltExam.test.js).
// Todo filtro de escopo (dojo_id/exam_id) é comparado contra o campo do
// DADO SIMULADO (state.exams[...].dojo_id, state.students[...].dojo_id),
// nunca contra a constante DOJO_ID do teste — comparar com a constante
// faria o mock nunca devolver vazio e o teste de isolamento não provaria
// nada.
//
// db.query vem do mock GLOBAL (tests/jest.setup.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const certRouter = require('../src/routes/karateDojoCertificates');

const FED_ID = '11111111-1111-4111-8111-111111111111';
const DOJO_ID = '22222222-2222-4222-8222-222222222222';
const EXAM_ID = '33333333-3333-4333-8333-333333333333';
const STUDENT_APPROVED = '44444444-4444-4444-8444-444444444444';
const STUDENT_LOCAL_APPROVED = '55555555-5555-4555-8555-555555555555';
const STUDENT_FAILED = '66666666-6666-4666-8666-666666666666';
const TEMPLATE_ID = '77777777-7777-4777-8777-777777777777';

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
  app.use('/federation/:id', certRouter);
  return app;
}

// ── Estado do "banco" ───────────────────────────────────────
let state;

function baseState() {
  return {
    companies: {
      [DOJO_ID]: { trade_name: 'Dojô Kondei', legal_name: 'Kondei Karate LTDA' },
    },
    exams: {
      [EXAM_ID]: {
        id: EXAM_ID,
        dojo_id: DOJO_ID,
        title: 'Exame de agosto',
        exam_date: '2026-08-20',
        examiner_name: 'Kondei',
      },
    },
    students: {
      [STUDENT_APPROVED]: { id: STUDENT_APPROVED, dojo_id: DOJO_ID, full_name: 'Aluna Federada' },
      [STUDENT_LOCAL_APPROVED]: { id: STUDENT_LOCAL_APPROVED, dojo_id: DOJO_ID, full_name: 'Aluno Não Federado' },
      [STUDENT_FAILED]: { id: STUDENT_FAILED, dojo_id: DOJO_ID, full_name: 'Aluno Reprovado' },
    },
    // resultados do exame: só approved vira elegível
    results: {
      'result-1': { id: 'result-1', exam_id: EXAM_ID, dojo_id: DOJO_ID, student_id: STUDENT_APPROVED, to_belt_name: 'Amarela', result: 'approved' },
      'result-2': { id: 'result-2', exam_id: EXAM_ID, dojo_id: DOJO_ID, student_id: STUDENT_LOCAL_APPROVED, to_belt_name: 'Laranja', result: 'approved' },
      'result-3': { id: 'result-3', exam_id: EXAM_ID, dojo_id: DOJO_ID, student_id: STUDENT_FAILED, to_belt_name: 'Amarela', result: 'failed' },
    },
    templates: {},
    issued: {},
    templateSeq: 0,
    issuedSeq: 0,
  };
}

function tagOf(sql) {
  const m = String(sql).match(/--\s*f91:([a-z-]+)/i);
  return m ? m[1] : null;
}

// Extrai pares {col, idx} de "[alias.]coluna = $N" — usado no UPDATE
// dinâmico do template (mesma técnica de karate.dojoEvents.test.js).
function extractEqFilters(sqlFragment) {
  const out = [];
  const re = /(?:\b\w+\.)?(\w+)\s*=\s*\$(\d+)/g;
  let m;
  while ((m = re.exec(sqlFragment))) out.push({ col: m[1], idx: Number(m[2]) });
  return out;
}

function poolQuery(sql, params) {
  const s = String(sql);
  const tag = tagOf(s);
  const p = params || [];

  switch (tag) {
    case 'list-templates': {
      const rows = Object.values(state.templates).filter((t) => t.dojo_id === p[0]);
      rows.sort((a, b) => (b.is_default === a.is_default ? 0 : b.is_default ? 1 : -1));
      return Promise.resolve({ rows });
    }

    case 'insert-template': {
      state.templateSeq += 1;
      const id = 'tpl-' + state.templateSeq;
      const row = {
        id, dojo_id: p[0], name: p[1], layout: p[2], title: p[3], body_mode: p[4],
        body_text: p[5], seals: JSON.parse(p[6]), signatories: JSON.parse(p[7]),
        font: p[8], text_scale: p[9], auto_fit: p[10], is_default: p[11], active: p[12],
        created_at: '2026-08-04T10:00:00Z',
      };
      state.templates[id] = row;
      return Promise.resolve({ rows: [row] });
    }

    case 'update-template': {
      const [beforeWhere, whereClause] = s.split(/\bWHERE\b/i);
      const setMatch = beforeWhere.match(/SET\s+([\s\S]+)/i);
      const assignments = extractEqFilters(setMatch ? setMatch[1] : '');
      const whereFilters = extractEqFilters(whereClause || '');
      const row = Object.values(state.templates).find((t) =>
        whereFilters.every((f) => String(t[f.col]) === String(p[f.idx - 1]))
      );
      if (!row) return Promise.resolve({ rows: [] });
      assignments.forEach((a) => {
        let v = p[a.idx - 1];
        if (a.col === 'seals' || a.col === 'signatories') v = JSON.parse(v);
        row[a.col] = v;
      });
      return Promise.resolve({ rows: [row] });
    }

    case 'delete-template': {
      const row = state.templates[p[0]];
      if (row && row.dojo_id === p[1]) {
        delete state.templates[p[0]];
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rowCount: 0 });
    }

    case 'load-exam': {
      const ex = state.exams[p[0]];
      return Promise.resolve({ rows: ex && ex.dojo_id === p[1] ? [ex] : [] });
    }

    case 'load-dojo': {
      const c = state.companies[p[0]];
      return Promise.resolve({ rows: c ? [{ dojo_name: c.trade_name || c.legal_name }] : [] });
    }

    case 'load-template': {
      const t = state.templates[p[0]];
      return Promise.resolve({ rows: t && t.dojo_id === p[1] ? [t] : [] });
    }

    case 'load-approved': {
      let rows = Object.values(state.results).filter(
        (r) => r.exam_id === p[0] && r.dojo_id === p[1] && r.result === 'approved'
      );
      if (p.length === 3) {
        const allowed = new Set(p[2]);
        rows = rows.filter((r) => allowed.has(r.student_id));
      }
      return Promise.resolve({
        rows: rows.map((r) => ({
          result_id: r.id,
          student_id: r.student_id,
          to_belt_name: r.to_belt_name,
          student_name: state.students[r.student_id] ? state.students[r.student_id].full_name : null,
        })),
      });
    }

    case 'check-existing': {
      const exists = Object.values(state.issued).some(
        (c) => c.exam_id === p[0] && c.student_id === p[1] && c.revoked === false
      );
      return Promise.resolve({ rows: exists ? [{ x: 1 }] : [] });
    }

    case 'insert-issued': {
      state.issuedSeq += 1;
      const id = 'cert-' + state.issuedSeq;
      state.issued[id] = {
        id, dojo_id: p[0], exam_id: p[1], student_id: p[2], result_id: p[3],
        verify_token: p[4], template_snapshot: JSON.parse(p[5]), data_snapshot: JSON.parse(p[6]),
        issued_by: p[7], issued_by_name: p[8], revoked: false, issued_at: '2026-08-04T10:00:00Z',
      };
      return Promise.resolve({ rows: [{ id }] });
    }

    case 'list-by-exam': {
      const rows = Object.values(state.issued).filter((c) => c.exam_id === p[0] && c.dojo_id === p[1]);
      return Promise.resolve({ rows });
    }

    case 'list-all': {
      const rows = Object.values(state.issued).filter((c) => c.dojo_id === p[0]);
      return Promise.resolve({ rows });
    }

    default:
      return Promise.resolve({ rows: [] });
  }
}

function postTemplate(body) {
  return request(buildApp())
    .post(`/federation/${FED_ID}/dojo/certificate-templates`)
    .set('Authorization', 'Bearer ' + tokenA)
    .send(body);
}

function issueCerts(examId, body) {
  return request(buildApp())
    .post(`/federation/${FED_ID}/dojo/graduation-exams/${examId}/own-certificates`)
    .set('Authorization', 'Bearer ' + tokenA)
    .send(body || {});
}

beforeEach(() => {
  state = baseState();
  db.query.mockReset();
  db.query.mockImplementation(poolQuery);
});

// ============================================================
// 1) CRUD DO TEMPLATE
// ============================================================
describe('F9.1 — CRUD do template do dojô', () => {
  test('criar sem corpo aplica defaults (layout A, fonte classica, CERTIFICADO)', async () => {
    const res = await postTemplate({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Modelo', layout: 'A', title: 'CERTIFICADO', body_mode: 'default', font: 'classica',
    });
    expect(res.body.seals).toEqual([]);
    expect(res.body.signatories).toEqual([]);
  });

  test('criar com signatories persiste o array — diferencial do template do dojô (assinatura no modelo, não no evento)', async () => {
    const res = await postTemplate({
      name: 'Modelo Oficial do Dojô',
      layout: 'B',
      signatories: [{ name: 'Sensei Kondei', role: 'Faixa Preta 4º dan', signature_url: 'https://r2/sig.png' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.signatories).toEqual([{ name: 'Sensei Kondei', role: 'Faixa Preta 4º dan', signature_url: 'https://r2/sig.png' }]);
  });

  test('layout fora de A-E cai para A (default seguro, nunca erro)', async () => {
    const res = await postTemplate({ layout: 'Z' });
    expect(res.status).toBe(201);
    expect(res.body.layout).toBe('A');
  });

  test('GET lista os templates do dojô', async () => {
    await postTemplate({ name: 'Modelo 1' });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/certificate-templates`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Modelo 1');
  });

  test('PATCH edita só os campos enviados', async () => {
    const created = await postTemplate({ name: 'Original' });
    const id = created.body.id;
    const res = await request(buildApp())
      .patch(`/federation/${FED_ID}/dojo/certificate-templates/${id}`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ title: 'CERTIFICADO DE GRADUAÇÃO' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('CERTIFICADO DE GRADUAÇÃO');
    expect(res.body.name).toBe('Original');
  });

  test('PATCH em template de OUTRO dojô é 404 (escopo pelo token, nunca a constante do teste)', async () => {
    const created = await postTemplate({ name: 'Original' });
    state.templates[created.body.id].dojo_id = 'outro-dojo';
    const res = await request(buildApp())
      .patch(`/federation/${FED_ID}/dojo/certificate-templates/${created.body.id}`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ title: 'x' });
    expect(res.status).toBe(404);
  });

  test('DELETE remove o template', async () => {
    const created = await postTemplate({ name: 'Descartável' });
    const res = await request(buildApp())
      .delete(`/federation/${FED_ID}/dojo/certificate-templates/${created.body.id}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(Object.keys(state.templates)).toHaveLength(0);
  });

  test('DELETE inexistente é 404', async () => {
    const res = await request(buildApp())
      .delete(`/federation/${FED_ID}/dojo/certificate-templates/${TEMPLATE_ID}`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 2) EMISSÃO EM MASSA
// ============================================================
describe('F9.1 — emissão em massa a partir do exame', () => {
  test('emite só os APROVADOS — reprovado nunca entra', async () => {
    const res = await issueCerts(EXAM_ID);
    expect(res.status).toBe(201);
    expect(res.body.eligible).toBe(2);
    expect(res.body.issued).toBe(2);
    expect(res.body.skipped).toBe(0);

    const issuedRows = Object.values(state.issued);
    expect(issuedRows.map((r) => r.student_id).sort()).toEqual(
      [STUDENT_APPROVED, STUDENT_LOCAL_APPROVED].sort()
    );
  });

  test('aluno NÃO FEDERADO também recebe o certificado do dojô (sem practitioner_id, ancorado em karate_dojo_students)', async () => {
    await issueCerts(EXAM_ID);
    const cert = Object.values(state.issued).find((c) => c.student_id === STUDENT_LOCAL_APPROVED);
    expect(cert).toBeDefined();
    expect(cert.data_snapshot.participant_name).toBe('Aluno Não Federado');
  });

  test('data_snapshot usa o nome do DOJÔ (não da federação) no campo agnóstico federation_name', async () => {
    await issueCerts(EXAM_ID);
    const cert = Object.values(state.issued)[0];
    expect(cert.data_snapshot.federation_name).toBe('Dojô Kondei');
  });

  test('sem template no template do exame, cai para o examinador como assinatário', async () => {
    await issueCerts(EXAM_ID);
    const cert = Object.values(state.issued)[0];
    expect(cert.data_snapshot.signatories).toEqual([
      { name: 'Kondei', role: 'Sensei / Examinador', signature_url: null },
    ]);
    // Nome CRU, sem prefixo "Sensei " decorado — mesma convenção da
    // asserção de `signatories` logo acima (nome cru + título no campo
    // `role`, separado). O sensei já costuma digitar "Sensei Fulano" no
    // próprio campo `examiner_name` (é assim que se identifica); se o
    // backend prefixasse "Sensei " de novo aqui, o certificado saía
    // "Sensei Sensei Fulano" — bug real, corrigido no #477. Este teste,
    // antes, travava exatamente essa duplicação.
    expect(cert.data_snapshot.instructors_text).toBe('Kondei');
  });

  test('template com signatories próprias sobrescreve o fallback do examinador', async () => {
    const created = await postTemplate({
      signatories: [{ name: 'Sensei Titular', role: 'Diretor Técnico', signature_url: 'https://r2/a.png' }],
    });
    await issueCerts(EXAM_ID, { template_id: created.body.id });
    const cert = Object.values(state.issued)[0];
    expect(cert.data_snapshot.signatories).toEqual([
      { name: 'Sensei Titular', role: 'Diretor Técnico', signature_url: 'https://r2/a.png' },
    ]);
  });

  test('reemitir para o MESMO exame+aluno é SKIPPED, nunca duplica (antidup por exame+aluno)', async () => {
    await issueCerts(EXAM_ID);
    const res2 = await issueCerts(EXAM_ID);
    expect(res2.status).toBe(201);
    expect(res2.body.issued).toBe(0);
    expect(res2.body.skipped).toBe(2);
    expect(Object.keys(state.issued)).toHaveLength(2); // não duplicou
  });

  test('student_ids filtra o lote', async () => {
    const res = await issueCerts(EXAM_ID, { student_ids: [STUDENT_APPROVED] });
    expect(res.status).toBe(201);
    expect(res.body.eligible).toBe(1);
    expect(res.body.issued).toBe(1);
    expect(Object.values(state.issued)[0].student_id).toBe(STUDENT_APPROVED);
  });

  test('exame de OUTRO dojô é 404 (escopo sempre pelo token, nunca a constante do teste)', async () => {
    state.exams[EXAM_ID].dojo_id = 'outro-dojo';
    const res = await issueCerts(EXAM_ID);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('EXAME_NAO_ENCONTRADO');
  });

  test('exame inexistente é 404', async () => {
    const res = await issueCerts('99999999-9999-4999-8999-999999999999');
    expect(res.status).toBe(404);
  });
});

// ============================================================
// 3) LISTAGEM
// ============================================================
describe('F9.1 — listagem de emitidos', () => {
  test('GET por exame traz só os certificados DAQUELE exame', async () => {
    await issueCerts(EXAM_ID);
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}/own-certificates`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  test('GET geral (own-certificates) traz todos do dojô', async () => {
    await issueCerts(EXAM_ID);
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/own-certificates`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

// ============================================================
// 4) CANAL B — O PORTAL É SOMENTE LEITURA
// ============================================================
describe('F9.1 — Canal B (portal do dojô) é read-only', () => {
  const writes = [
    ['post', `/federation/${FED_ID}/dojo/certificate-templates`, { name: 'x' }],
    ['patch', `/federation/${FED_ID}/dojo/certificate-templates/${TEMPLATE_ID}`, { name: 'y' }],
    ['delete', `/federation/${FED_ID}/dojo/certificate-templates/${TEMPLATE_ID}`, {}],
    ['post', `/federation/${FED_ID}/dojo/certificate-assets`, { image_base64: 'aGVsbG8=' }],
    ['post', `/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}/own-certificates`, {}],
  ];

  test.each(writes)('%s %s → 403 PORTAL_READ_ONLY', async (method, path, body) => {
    const res = await request(buildApp())[method](path).set('Authorization', 'Bearer ' + tokenB).send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('Canal B LÊ normalmente (templates, listagens)', async () => {
    const list = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/certificate-templates`)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(list.status).toBe(200);

    const byExam = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}/own-certificates`)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(byExam.status).toBe(200);

    const all = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/own-certificates`)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(all.status).toBe(200);
  });

  test('sem token → 401 (não 403): não é permissão que falta, é sessão', async () => {
    const res = await request(buildApp()).get(`/federation/${FED_ID}/dojo/certificate-templates`);
    expect(res.status).toBe(401);
  });
});

// ============================================================
// 5) SCHEMA PENDENTE (migration 271 ainda não aplicada)
// ============================================================
describe('F9.1 — degradação quando a tabela ainda não existe', () => {
  test('GET de templates devolve lista vazia + schema_pending em vez de 500', async () => {
    db.query.mockImplementation(() => {
      const err = new Error('relation "karate_dojo_certificate_templates" does not exist');
      err.code = '42P01';
      return Promise.reject(err);
    });
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/certificate-templates`)
      .set('Authorization', 'Bearer ' + tokenA);
    expect(res.status).toBe(200);
    expect(res.body.schema_pending).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  test('POST de emissão devolve 503 SCHEMA_PENDING em vez de 500', async () => {
    db.query.mockImplementation((sql) => {
      if (tagOf(sql) === 'load-exam') return Promise.resolve({ rows: [state.exams[EXAM_ID]] });
      const err = new Error('relation "karate_dojo_issued_certificates" does not exist');
      err.code = '42P01';
      return Promise.reject(err);
    });
    const res = await issueCerts(EXAM_ID);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCHEMA_PENDING');
  });
});
