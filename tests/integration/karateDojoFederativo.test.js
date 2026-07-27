// ============================================================
// AURA DOJÔ — Testes Integração: F5b, as TRÊS trocas federativas
//   1. certificados (aptos + pedido em lote + acompanhamento)
//   2. inscrição em lote em evento da federação
//   3. submissão de candidatos a exame de faixa
//
// REGRA TRANSVERSAL sob teste: só participa aluno com practitioner_id NOT
// NULL (migration 253). is_federated é declaração do sensei e NÃO autoriza
// — por isso nenhum caso aqui depende dele.
//
// ⚠️ MOCK POR SQL (mockImplementation), NUNCA fila posicional de
// mockResolvedValueOnce: uma query nova entrando na frente (foi o que o
// helper karateDojoLinkStatus fez no PR #422) desalinha a fila inteira e
// derruba o CI. Mock genérico {rows: []} também não serve: vários handlers
// leem rows[0] direto.
//
// db.query.mockReset() + db.connect.mockReset() em afterEach.
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const s1 = 'a1000000-0000-0000-0000-00000000000a'; // federado
const s2 = 'a2000000-0000-0000-0000-00000000000b'; // NÃO federado
const s3 = 'a3000000-0000-0000-0000-00000000000c'; // de outro dojô
const p1 = 'c1000000-0000-0000-0000-0000000000aa'; // practitioner de s1
const examId = 'e1000000-0000-0000-0000-0000000000e1';
const base = `/api/v1/federation/${fedId}/dojo`;
const LINKED_AT = new Date('2026-07-01T12:00:00Z');

// Canal A: JWT de acesso da conta do dojô (dojo_id no token)
const canalA = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'sensei@dojo.com.br', type: 'access', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

// Canal B: token de portal (somente leitura)
const canalB = () => ({
  Authorization: `Bearer ${jwt.sign(
    { type: 'portal', scope: 'dojo_portal', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

// Matcher pode ser regex OU função (várias queries só se distinguem por
// DOIS pedaços da SQL — um regex só não basta).
const matches = (m, s) => (typeof m === 'function' ? Boolean(m(s)) : m.test(s));
const sqls = () => db.query.mock.calls.map((c) => String(c[0]));
const hitSql = (m) => sqls().some((s) => matches(m, s));
const findCall = (m) => db.query.mock.calls.find((c) => matches(m, String(c[0])));

// ── matchers ───────────────────────────────────────────
// Query do helper karateDojoLinkStatus (a única que menciona a coluna).
const isLinkQuery = (s) => /SELECT\s+karate_dojo_linked_at/i.test(s);
// GET /aptos — graduações sem pedido.
const isAptos = (s) => /FROM karate_dojo_students s/.test(s) && /JOIN karate_belt_history h/.test(s);
// Carga em lote dos alunos DO DOJÔ.
const isStudentsBatch = (s) => /FROM karate_dojo_students/.test(s) && /id = ANY\(\$2::uuid\[\]\)/.test(s);
// Faixa atual canônica (view da migration 229).
const isCurrentBelt = (s) => /FROM karate_current_belt/.test(s);
// createOrder (karateCertificateService) — 3 queries + histórico.
const isCertBeltCheck = (s) => /FROM karate_belt_history kbh/.test(s);
const isCertDup = (s) => /SELECT id FROM karate_certificate_orders/.test(s);
const isCertInsert = (s) => /INSERT INTO karate_certificate_orders/.test(s);
const isCertHistInsert = (s) => /INSERT INTO karate_certificate_order_history/.test(s);
// getOrdersByDojo — lista do dojô.
const isOrdersByDojo = (s) => /FROM karate_certificate_orders o/.test(s) && /ORDER BY o\.created_at DESC/.test(s);
// resolveFederationEvent — o discriminador `kind` distingue das demais.
const isExamResolve = (s) => /FROM karate_belt_exams/.test(s) && /'exam' AS kind/.test(s);
const isCourseResolve = (s) => /FROM karate_events/.test(s) && /'course' AS kind/.test(s);
const isCompResolve = (s) => /FROM karate_competitions/.test(s) && /'competition' AS kind/.test(s);
// Nome do exame para exam_ref (best-effort do pedido de certificado).
const isExamNameLookup = (s) => /SELECT name FROM karate_belt_exams/.test(s);
// Inscrição em exame/curso canônico.
const isCandDup = (s) => /SELECT id, status FROM karate_belt_exam_candidates/.test(s);
const isCandInsert = (s) => /INSERT INTO karate_belt_exam_candidates/.test(s);
const isCandList = (s) =>
  /FROM karate_belt_exam_candidates c/.test(s) && /JOIN karate_dojo_students s/.test(s);

// ── factories ─────────────────────────────────────────
const studentRow = (id, practitionerId, name) => ({
  id,
  full_name: name,
  practitioner_id: practitionerId,
  status: 'active',
});

const examRow = (over = {}) => ({
  id: examId,
  name: 'Exame de Kyu — Ago/2026',
  exam_type: 'kyu_regional',
  event_date: '2026-08-15',
  location: 'Belém',
  fee_amount: '80.00',
  max_candidates: 100,
  status: 'open',
  hours: null,
  registration_fields: [],
  description: null,
  kind: 'exam',
  ...over,
});

const orderRow = (over = {}) => ({
  id: 'o1000000-0000-0000-0000-0000000000f1',
  federation_id: fedId,
  dojo_id: dojoId,
  practitioner_id: p1,
  belt_level: 'marrom',
  belt_name: '1º Kyu — Marrom',
  status: 'requested',
  created_at: '2026-07-26T00:00:00Z',
  ...over,
});

// linkedAt = null → dojô NÃO conectado; Date → conectado.
function mockDojo(linkedAt, extra) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (isLinkQuery(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: linkedAt }] });
    if (extra) {
      const r = extra(s);
      if (r) return Promise.resolve(r);
    }
    return Promise.resolve({ rows: [] });
  });
}

afterEach(() => {
  db.query.mockReset();
  if (db.connect && db.connect.mockReset) db.connect.mockReset();
});

// ============================================================
// 1) CERTIFICADOS — GET /dojo/aptos
// ============================================================
describe('F5b — GET /dojo/aptos', () => {
  it('lista só graduação de aluno FEDERADO e sem pedido, escopada pelo token', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isAptos(s)) {
        return {
          rows: [
            {
              student_id: s1,
              student_name: 'Aluno Um',
              practitioner_id: p1,
              practitioner_name: 'Aluno Um FPKT',
              fpkt_number: 'FPKT-1234',
              belt_history_id: 'h1000000-0000-0000-0000-0000000000b1',
              belt_level: 'marrom',
              belt_name: '1º Kyu — Marrom',
              graduated_at: '2026-06-10',
              exam_id: examId,
              exam_name: 'Exame de Kyu — Jun/2026',
            },
          ],
        };
      }
      return null;
    });

    const res = await request(app).get(`${base}/aptos`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0]).toMatchObject({
      student_id: s1,
      practitioner_id: p1,
      name: 'Aluno Um',
      fpkt_number: 'FPKT-1234',
      belt_label: '1º Kyu — Marrom',
      belt_level: 'marrom',
      exam_name: 'Exame de Kyu — Jun/2026',
    });
    // belt_order derivado do belt_level pelo ranking da migration 229.
    expect(res.body.data[0].belt_order).toBe(8);

    const call = findCall(isAptos);
    // A REGRA na SQL: só federado (practitioner_id) e só sem pedido.
    expect(String(call[0])).toMatch(/s\.practitioner_id IS NOT NULL/);
    expect(String(call[0])).toMatch(/NOT EXISTS/);
    expect(String(call[0])).toMatch(/o\.status <> 'refused'/);
    // Escopo vem do TOKEN, nunca do corpo/query.
    expect(call[1]).toEqual([dojoId, fedId]);
  });

  it('degrada (schema_pending) quando a tabela ainda não existe', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (isLinkQuery(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: LINKED_AT }] });
      const e = new Error('relation "karate_belt_history" does not exist');
      e.code = '42P01';
      return Promise.reject(e);
    });

    const res = await request(app).get(`${base}/aptos`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [], count: 0, schema_pending: true });
  });
});

// ============================================================
// 1) CERTIFICADOS — POST /dojo/cert-orders (lote)
// ============================================================
describe('F5b — POST /dojo/cert-orders', () => {
  it('cria em lote e pula com razão acionável (não federado / outro dojô)', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isStudentsBatch(s)) {
        // s3 NÃO volta: é de outro dojô (a query é escopada por dojo_id).
        return {
          rows: [
            studentRow(s1, p1, 'Aluno Um'),
            studentRow(s2, null, 'Aluno Dois'),
          ],
        };
      }
      if (isCurrentBelt(s)) {
        return {
          rows: [{ belt_level: 'marrom', belt_name: '1º Kyu — Marrom', current_since: '2026-06-10', exam_id: examId }],
        };
      }
      if (isExamNameLookup(s)) return { rows: [{ name: 'Exame de Kyu — Jun/2026' }] };
      if (isCertBeltCheck(s)) return { rows: [{ id: 'h1' }] };
      if (isCertDup(s)) return { rows: [] };
      if (isCertInsert(s)) return { rows: [orderRow()] };
      if (isCertHistInsert(s)) return { rows: [] };
      return null;
    });

    const res = await request(app)
      .post(`${base}/cert-orders`)
      .set(canalA())
      .send({ items: [{ student_id: s1 }, { student_id: s2 }, { student_id: s3 }] });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.orders[0]).toMatchObject({ student_id: s1, status: 'requested' });

    const byStudent = Object.fromEntries(res.body.skipped.map((k) => [k.student_id, k.reason]));
    expect(byStudent[s2]).toBe('ALUNO_NAO_FEDERADO');
    expect(byStudent[s3]).toBe('ALUNO_NAO_ENCONTRADO');

    // dojo_id do pedido vem do TOKEN (posição 2 do INSERT de createOrder).
    const ins = findCall(isCertInsert);
    expect(ins[1][0]).toBe(fedId);
    expect(ins[1][1]).toBe(dojoId);
    expect(ins[1][2]).toBe(p1);

    // Aluno não federado NUNCA vira pedido.
    expect(db.query.mock.calls.filter((c) => isCertInsert(String(c[0]))).length).toBe(1);
  });

  it('pula JA_SOLICITADO quando já existe pedido ativo para a mesma graduação', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isStudentsBatch(s)) return { rows: [studentRow(s1, p1, 'Aluno Um')] };
      if (isCurrentBelt(s)) {
        return { rows: [{ belt_level: 'marrom', belt_name: '1º Kyu — Marrom', current_since: '2026-06-10', exam_id: null }] };
      }
      if (isCertBeltCheck(s)) return { rows: [{ id: 'h1' }] };
      if (isCertDup(s)) return { rows: [{ id: 'ja-existe' }] }; // dup check do createOrder
      return null;
    });

    const res = await request(app)
      .post(`${base}/cert-orders`)
      .set(canalA())
      .send({ items: [{ student_id: s1 }] });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped[0]).toMatchObject({ student_id: s1, reason: 'JA_SOLICITADO' });
    expect(hitSql(isCertInsert)).toBe(false);
  });

  it('422 quando items vem vazio', async () => {
    mockDojo(LINKED_AT);
    const res = await request(app).post(`${base}/cert-orders`).set(canalA()).send({ items: [] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ============================================================
// 1) CERTIFICADOS — GET /dojo/cert-orders
// ============================================================
describe('F5b — GET /dojo/cert-orders', () => {
  it('reusa getOrdersByDojo escopado pelo token', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isOrdersByDojo(s)) return { rows: [orderRow({ status: 'in_production' })] };
      return null;
    });

    const res = await request(app).get(`${base}/cert-orders`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].status).toBe('in_production');

    const call = findCall(isOrdersByDojo);
    expect(call[1][0]).toBe(dojoId);
    expect(call[1][1]).toBe(fedId);
  });
});

// ============================================================
// 2) INSCRIÇÃO EM LOTE
// ============================================================
describe('F5b — POST /dojo/events/:eventId/enroll', () => {
  it('inscreve federado e pula não federado com ALUNO_NAO_FEDERADO', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isExamResolve(s)) return { rows: [examRow()] };
      if (isStudentsBatch(s)) {
        return { rows: [studentRow(s1, p1, 'Aluno Um'), studentRow(s2, null, 'Aluno Dois')] };
      }
      if (isCandDup(s)) return { rows: [] };
      if (isCandInsert(s)) return { rows: [{ id: 'cand-1' }] };
      return null;
    });

    const res = await request(app)
      .post(`${base}/events/${examId}/enroll`)
      .set(canalA())
      .send({ student_ids: [s1, s2] });

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(1);
    expect(res.body.enrollments[0]).toMatchObject({ student_id: s1, practitioner_id: p1, candidate_id: 'cand-1' });
    expect(res.body.skipped[0]).toMatchObject({ student_id: s2, reason: 'ALUNO_NAO_FEDERADO' });

    // O que vai para a federação é o practitioner_id, nunca o id interno do aluno.
    const ins = findCall(isCandInsert);
    expect(ins[1]).toEqual([examId, p1]);
    expect(db.query.mock.calls.filter((c) => isCandInsert(String(c[0]))).length).toBe(1);
  });

  it('é idempotente: reinscrever devolve JA_INSCRITO e não emite INSERT', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isExamResolve(s)) return { rows: [examRow()] };
      if (isStudentsBatch(s)) return { rows: [studentRow(s1, p1, 'Aluno Um')] };
      if (isCandDup(s)) return { rows: [{ id: 'cand-ja', status: 'registered' }] };
      return null;
    });

    const res = await request(app)
      .post(`${base}/events/${examId}/enroll`)
      .set(canalA())
      .send({ student_ids: [s1] });

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(0);
    expect(res.body.skipped[0]).toMatchObject({ student_id: s1, reason: 'JA_INSCRITO', candidate_id: 'cand-ja' });
    expect(hitSql(isCandInsert)).toBe(false);
  });

  it('23505 (corrida no UNIQUE) também vira JA_INSCRITO, nunca 500', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (isLinkQuery(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: LINKED_AT }] });
      if (isExamResolve(s)) return Promise.resolve({ rows: [examRow()] });
      if (isStudentsBatch(s)) return Promise.resolve({ rows: [studentRow(s1, p1, 'Aluno Um')] });
      if (isCandDup(s)) return Promise.resolve({ rows: [] });
      if (isCandInsert(s)) {
        const e = new Error('duplicate key value violates unique constraint');
        e.code = '23505';
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`${base}/events/${examId}/enroll`)
      .set(canalA())
      .send({ student_ids: [s1] });

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(0);
    expect(res.body.skipped[0].reason).toBe('JA_INSCRITO');
  });

  it('evento fechado: todos pulados com EVENTO_FECHADO e nenhuma escrita', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isExamResolve(s)) return { rows: [examRow({ status: 'done' })] };
      return null;
    });

    const res = await request(app)
      .post(`${base}/events/${examId}/enroll`)
      .set(canalA())
      .send({ student_ids: [s1, s2] });

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(0);
    expect(res.body.skipped.map((k) => k.reason)).toEqual(['EVENTO_FECHADO', 'EVENTO_FECHADO']);
    expect(hitSql(isStudentsBatch)).toBe(false);
    expect(hitSql(isCandInsert)).toBe(false);
  });

  it('competição: COMPETICAO_NAO_SUPORTADA (exige categoria por atleta)', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isExamResolve(s)) return { rows: [] };
      if (isCourseResolve(s)) return { rows: [] };
      if (isCompResolve(s)) {
        return { rows: [{ id: examId, name: 'Copa Norte', event_date: '2026-09-01', location: 'Belém', fee_amount: '50.00', status: 'open', kind: 'competition' }] };
      }
      return null;
    });

    const res = await request(app)
      .post(`${base}/events/${examId}/enroll`)
      .set(canalA())
      .send({ student_ids: [s1] });

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(0);
    expect(res.body.skipped[0].reason).toBe('COMPETICAO_NAO_SUPORTADA');
    expect(hitSql(isCandInsert)).toBe(false);
  });

  it('404 quando o evento não é desta federação', async () => {
    mockDojo(LINKED_AT);
    const res = await request(app)
      .post(`${base}/events/${examId}/enroll`)
      .set(canalA())
      .send({ student_ids: [s1] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('EVENT_NOT_FOUND');
  });
});

describe('F5b — GET /dojo/events/:eventId/enrollments', () => {
  it('lista escopada pelo QUADRO do dojô (s.dojo_id do token)', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isExamResolve(s)) return { rows: [examRow()] };
      if (isCandList(s)) {
        return {
          rows: [
            {
              candidate_id: 'cand-1',
              practitioner_id: p1,
              status: 'registered',
              target_belt: null,
              fee_paid: false,
              created_at: '2026-07-26T00:00:00Z',
              student_id: s1,
              student_name: 'Aluno Um',
              belt_label: 'Marrom',
              belt_order: 8,
              fpkt_number: 'FPKT-1234',
            },
          ],
        };
      }
      return null;
    });

    const res = await request(app).get(`${base}/events/${examId}/enrollments`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0]).toMatchObject({ student_id: s1, practitioner_id: p1, name: 'Aluno Um', status: 'registered' });

    const call = findCall(isCandList);
    expect(String(call[0])).toMatch(/s\.dojo_id = \$2/);
    expect(call[1]).toEqual([examId, dojoId]);
  });
});

// ============================================================
// 3) CANDIDATOS A EXAME DE FAIXA
// ============================================================
describe('F5b — POST /dojo/belt-exams/:examId/candidates', () => {
  it('submete candidatos federados e pula não federado', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isExamResolve(s)) return { rows: [examRow()] };
      if (isStudentsBatch(s)) {
        return { rows: [studentRow(s1, p1, 'Aluno Um'), studentRow(s2, null, 'Aluno Dois')] };
      }
      if (isCandDup(s)) return { rows: [] };
      if (isCandInsert(s)) return { rows: [{ id: 'cand-1' }] };
      return null;
    });

    const res = await request(app)
      .post(`${base}/belt-exams/${examId}/candidates`)
      .set(canalA())
      .send({ student_ids: [s1, s2] });

    expect(res.status).toBe(200);
    expect(res.body.submitted).toBe(1);
    expect(res.body.candidates[0]).toMatchObject({ student_id: s1, candidate_id: 'cand-1' });
    expect(res.body.skipped[0].reason).toBe('ALUNO_NAO_FEDERADO');

    // O dojô SUBMETE, nunca gradua: nada é escrito em karate_belt_history.
    expect(hitSql(/INSERT INTO karate_belt_history/)).toBe(false);
    expect(hitSql(/UPDATE karate_belt_exam_candidates/)).toBe(false);
  });

  it('422 NAO_E_EXAME quando o id aponta para um CURSO', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isExamResolve(s)) return { rows: [examRow({ exam_type: 'curso' })] };
      return null;
    });

    const res = await request(app)
      .post(`${base}/belt-exams/${examId}/candidates`)
      .set(canalA())
      .send({ student_ids: [s1] });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NAO_E_EXAME');
    expect(hitSql(isCandInsert)).toBe(false);
  });

  it('GET candidatos devolve o quadro do dojô naquele exame', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isExamResolve(s)) return { rows: [examRow()] };
      if (isCandList(s)) {
        return {
          rows: [
            {
              candidate_id: 'cand-1',
              practitioner_id: p1,
              status: 'registered',
              target_belt: null,
              fee_paid: false,
              created_at: '2026-07-26T00:00:00Z',
              student_id: s1,
              student_name: 'Aluno Um',
              belt_label: 'Marrom',
              belt_order: 8,
              fpkt_number: 'FPKT-1234',
            },
          ],
        };
      }
      return null;
    });

    const res = await request(app).get(`${base}/belt-exams/${examId}/candidates`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].candidate_id).toBe('cand-1');
  });
});

// ============================================================
// GATE DE CONEXÃO — 409 em TODAS as rotas da fase
// ============================================================
describe('F5b — dojô NÃO conectado', () => {
  const rotas = [
    ['get', `${base}/aptos`],
    ['get', `${base}/cert-orders`],
    ['post', `${base}/cert-orders`],
    ['get', `${base}/events/${examId}/enrollments`],
    ['post', `${base}/events/${examId}/enroll`],
    ['get', `${base}/belt-exams/${examId}/candidates`],
    ['post', `${base}/belt-exams/${examId}/candidates`],
  ];

  it.each(rotas)('%s %s → 409 DOJO_NAO_CONECTADO sem tocar em tabela de domínio', async (verb, url) => {
    mockDojo(null); // karate_dojo_linked_at NULL = não conectado

    const req = request(app)[verb](url).set(canalA());
    const res = verb === 'post' ? await req.send({ student_ids: [s1], items: [{ student_id: s1 }] }) : await req;

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOJO_NAO_CONECTADO');

    // A ÚNICA query permitida é a do helper de conexão.
    expect(sqls().every((s) => isLinkQuery(s))).toBe(true);
  });
});

// ============================================================
// CANAL B — portal lê, nunca escreve
// ============================================================
describe('F5b — Canal B (portal do dojô)', () => {
  it('GET /aptos funciona no Canal B', async () => {
    mockDojo(LINKED_AT, (s) => (isAptos(s) ? { rows: [] } : null));
    const res = await request(app).get(`${base}/aptos`).set(canalB());
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
  });

  it.each([
    ['/cert-orders'],
    [`/events/${examId}/enroll`],
    [`/belt-exams/${examId}/candidates`],
  ])('POST %s no Canal B → 403 PORTAL_READ_ONLY sem nenhuma db.query', async (path) => {
    mockDojo(LINKED_AT);
    const res = await request(app)
      .post(`${base}${path}`)
      .set(canalB())
      .send({ student_ids: [s1], items: [{ student_id: s1 }] });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    // O 403 é decidido pelo TOKEN — nem o gate de conexão precisa rodar.
    expect(db.query).not.toHaveBeenCalled();
  });
});
