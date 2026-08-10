// ============================================================
// AURA KARATÊ — testes do CERTIFICADO OFICIAL DA FEDERAÇÃO
// (src/routes/karateEventCertificates.js)
//
// Por que este arquivo existe: karateEventCertificates.js emite o
// certificado OFICIAL exigido pela federação (FPKT) e não tinha NENHUM
// teste até aqui (achado numa varredura depois do fix do prefixo
// "Sensei" duplicado, back#477). O documento é IMUTÁVEL por desenho —
// data_snapshot é gravado uma vez e nunca recalculado — então um bug
// aqui não se conserta com deploy: os certificados já emitidos continuam
// errados e só saem revogando e reemitindo, um a um.
//
// Escopo desta suíte — só três coisas, não o arquivo inteiro (o CRUD de
// templates e o upload de selo ficam de fora por ora):
//   1. Emissão em massa (POST /belt-exams/:examId/certificates) — só os
//      elegíveis entram, reemitir não duplica, data_snapshot sai com os
//      campos que buildCertificateHtml consome (instructors_text SEM
//      prefixo "Sensei" — congela o bug do #477).
//   2. Escopo por federação — uma federação não emite nem lista sobre
//      evento de outra.
//   3. Verificação pública por token (GET /public/karate/verify/cert/:id,
//      em src/routes/karatePublic.js) — o token resolve o certificado
//      certo e a resposta traz o snapshot.
//
// Espelha a estrutura/mecânica de mock de __tests__/karate.dojoCertificates.test.js
// (o gêmeo não-oficial do dojô), adaptada porque este router NÃO usa
// âncoras `-- f91:tag` nas queries — o despacho aqui é por REGEX sobre
// um trecho estável de cada SQL (nome de tabela / cláusula WHERE), nunca
// por posição (mockResolvedValueOnce em fila já derrubou este CI 4 vezes).
//
// ⚠️ ARMADILHA DO ESCOPO: todo filtro de federação no mock é comparado
// contra o CAMPO DO DADO SIMULADO (ex.: state.exams[id].federation_id,
// state.issued[id].federation_id) — NUNCA contra a constante FED_A/FED_B
// do teste. Comparar com a constante é tautologia: o mock nunca devolve
// vazio e o teste de isolamento não prova nada.
//
// Guard usado pelas rotas: guards.staffWrite()/guards.read() →
// requireAuth + requireCompanyAccess. Igual a __tests__/karate.trackA.test.js,
// os tokens usam role:'admin' (bypass de plataforma, já suportado pelo
// próprio middleware) para manter o foco da suíte na lógica de negócio
// da rota (elegibilidade, antidup, escopo por federation_id no SQL) em
// vez de remontar o SELECT de company_members/role_label.
//
// db.query vem do mock GLOBAL (tests/jest.setup.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');

// karateMailer.sendRaw é best-effort (fire-and-forget) na emissão — troca
// pelo dev-fallback real seria seguro mesmo sem mock (sem RESEND_API_KEY
// ele só loga e resolve), mas mockamos explicitamente para manter o teste
// determinístico e não depender de env, seguindo o mesmo padrão de
// __tests__/karate.trackJ.test.js.
jest.mock('../src/services/karateMailer', () => ({
  sendRaw: jest.fn().mockResolvedValue({ id: 'mock-email' }),
}));

const SECRET = 'aura-test-secret-2026';

const FED_A = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const FED_B = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
const EXAM_ID = 'cccccccc-3333-4ccc-8ccc-cccccccccccc';
const CURSO_EXAM_ID = 'dddddddd-4444-4ddd-8ddd-dddddddddddd';
const STUDENT_APPROVED = 'e1111111-5555-4eee-8eee-111111111111';
const STUDENT_ELIGIBLE_FLAG = 'e2222222-5555-4eee-8eee-222222222222';
const STUDENT_FAILED = 'e3333333-5555-4eee-8eee-333333333333';
const STUDENT_CURSO_PRESENT = 'e4444444-5555-4eee-8eee-444444444444';
const STUDENT_CURSO_ABSENT = 'e5555555-5555-4eee-8eee-555555555555';
const TEMPLATE_ID = 'f7777777-6666-4fff-8fff-777777777777';

// Token de plataforma (role:'admin') — bypassa requireCompanyAccess, igual
// __tests__/karate.trackA.test.js. O :id da URL é quem determina a
// federação em cada chamada; o escopo real é reforçado pelo SQL da rota.
const makeToken = () => jwt.sign(
  { id: 'user-test-uuid', role: 'admin', plan: 'expansao' },
  SECRET,
  { expiresIn: '1h' }
);
const ADMIN_TOKEN = makeToken();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/federation/:id', require('../src/routes/karateEventCertificates'));
  app.use('/public/karate', require('../src/routes/karatePublic'));
  return app;
}

// ── Estado do "banco" ───────────────────────────────────────
let state;

function baseState() {
  return {
    companies: {
      [FED_A]: { trade_name: 'FPKT Central', legal_name: 'Federação Paulista de Karatê', slug: 'fpkt-central' },
      [FED_B]: { trade_name: 'FPKT Sul', legal_name: 'Federação Sulista de Karatê', slug: 'fpkt-sul' },
    },
    exams: {
      [EXAM_ID]: {
        id: EXAM_ID, federation_id: FED_A, name: 'Exame de Faixa Preta', exam_type: 'exame',
        event_date: '2026-08-20', location: 'Ginásio Central', hours: 8,
      },
      [CURSO_EXAM_ID]: {
        id: CURSO_EXAM_ID, federation_id: FED_A, name: 'Curso de Arbitragem', exam_type: 'curso',
        event_date: '2026-08-22', location: 'Sede FPKT', hours: 16,
      },
    },
    templates: {
      [TEMPLATE_ID]: {
        id: TEMPLATE_ID, federation_id: FED_A, layout: 'B', title: 'CERTIFICADO OFICIAL',
        body_mode: 'default', body_text: null, seals: [], font: 'elegante', text_scale: null, auto_fit: false,
      },
    },
    instructors: {
      [EXAM_ID]: [
        { name: 'Sensei Kondei', role: 'Examinador', signature_url: null },
        { name: 'Sensei Ana', role: null, signature_url: 'https://r2/ana.png' },
      ],
      [CURSO_EXAM_ID]: [
        { name: 'Sensei Marcos', role: 'Instrutor', signature_url: null },
      ],
    },
    candidates: {
      [EXAM_ID]: [
        { student_id: STUDENT_APPROVED, student_name: 'Aluno Aprovado', student_email: 'aluno@test.com', status: 'approved', certificate_eligible: false },
        { student_id: STUDENT_ELIGIBLE_FLAG, student_name: 'Aluno Elegível por Flag', student_email: 'flag@test.com', status: 'rejected', certificate_eligible: true },
        { student_id: STUDENT_FAILED, student_name: 'Aluno Reprovado', student_email: 'reprovado@test.com', status: 'failed', certificate_eligible: false },
      ],
      [CURSO_EXAM_ID]: [
        { student_id: STUDENT_CURSO_PRESENT, student_name: 'Aluno Presente no Curso', student_email: 'presente@test.com', status: 'present', certificate_eligible: false },
        { student_id: STUDENT_CURSO_ABSENT, student_name: 'Aluno Ausente do Curso', student_email: 'ausente@test.com', status: 'absent', certificate_eligible: false },
      ],
    },
    issued: {},
    issuedSeq: 0,
  };
}

// ── Despacho por REGEX sobre a query (sem âncora `--` neste router) ──
function poolQuery(sql, params) {
  const s = String(sql);
  const p = params || [];

  // INSERT do certificado emitido
  if (/INSERT INTO karate_issued_certificates/i.test(s)) {
    state.issuedSeq += 1;
    const id = 'cert-' + state.issuedSeq;
    const row = {
      id,
      federation_id: p[0],
      event_id: p[1],
      student_id: p[2],
      verify_token: p[3],
      template_snapshot: JSON.parse(p[4]),
      data_snapshot: JSON.parse(p[5]),
      revoked: false,
      issued_at: '2026-08-10T10:00:00Z',
    };
    state.issued[id] = row;
    return Promise.resolve({ rows: [row] });
  }

  // Checagem de duplicata (antidup por event_id+student_id)
  if (/SELECT 1 FROM karate_issued_certificates/i.test(s)) {
    const exists = Object.values(state.issued).some(
      (c) => c.event_id === p[0] && c.student_id === p[1] && c.revoked === false
    );
    return Promise.resolve({ rows: exists ? [{ x: 1 }] : [] });
  }

  // Verificação pública por token (karatePublic.js) — ic.verify_token = $1
  if (/ic\.verify_token\s*=\s*\$1/i.test(s)) {
    const row = Object.values(state.issued).find((c) => c.verify_token === p[0]);
    if (!row) return Promise.resolve({ rows: [] });
    const fed = state.companies[row.federation_id] || {};
    return Promise.resolve({
      rows: [{
        data_snapshot: row.data_snapshot,
        template_snapshot: row.template_snapshot,
        revoked: row.revoked,
        issued_at: row.issued_at,
        federation_name: fed.trade_name || fed.legal_name || '',
      }],
    });
  }

  // Listagem de emitidos DE UM evento — WHERE event_id=$1 AND federation_id=$2
  if (/FROM karate_issued_certificates WHERE event_id=\$1 AND federation_id=\$2/i.test(s)) {
    const rows = Object.values(state.issued).filter((c) => c.event_id === p[0] && c.federation_id === p[1]);
    return Promise.resolve({ rows });
  }

  // Carrega o evento (belt_exam) + nome/slug da federação via JOIN companies
  if (/FROM karate_belt_exams be/i.test(s)) {
    const ex = state.exams[p[0]];
    if (!ex || ex.federation_id !== p[1]) return Promise.resolve({ rows: [] });
    const fed = state.companies[ex.federation_id] || {};
    return Promise.resolve({
      rows: [{
        id: ex.id, name: ex.name, exam_type: ex.exam_type, event_date: ex.event_date,
        location: ex.location, hours: ex.hours,
        federation_name: fed.trade_name || fed.legal_name || '',
        federation_slug: fed.slug || null,
      }],
    });
  }

  // Carrega template por id (usado quando template_id vem no body)
  if (/FROM karate_certificate_templates/i.test(s)) {
    const t = state.templates[p[0]];
    return Promise.resolve({ rows: t && t.federation_id === p[1] ? [t] : [] });
  }

  // Instrutores do evento → assinaturas + instructors_text
  if (/FROM karate_event_instructors/i.test(s)) {
    return Promise.resolve({ rows: state.instructors[p[0]] || [] });
  }

  // Candidatos elegíveis do exame
  if (/FROM karate_belt_exam_candidates/i.test(s)) {
    const examId = p[0];
    const isCurso = p[1];
    const studentIdsFilter = p[2];
    let rows = (state.candidates[examId] || []).filter((c) => {
      if (c.certificate_eligible === true) return true;
      if (isCurso) return c.status !== 'absent' && c.status !== 'rejected';
      return c.status === 'approved';
    });
    if (Array.isArray(studentIdsFilter) && studentIdsFilter.length) {
      const allowed = new Set(studentIdsFilter);
      rows = rows.filter((c) => allowed.has(c.student_id));
    }
    return Promise.resolve({
      rows: rows.map((c) => ({ student_id: c.student_id, student_name: c.student_name, student_email: c.student_email })),
    });
  }

  return Promise.resolve({ rows: [] });
}

function issueCerts(fedId, examId, body) {
  return request(buildApp())
    .post(`/federation/${fedId}/belt-exams/${examId}/certificates`)
    .set('Authorization', 'Bearer ' + ADMIN_TOKEN)
    .send(body || {});
}

function listCerts(fedId, examId) {
  return request(buildApp())
    .get(`/federation/${fedId}/belt-exams/${examId}/certificates`)
    .set('Authorization', 'Bearer ' + ADMIN_TOKEN);
}

function verifyToken(token) {
  return request(buildApp()).get(`/public/karate/verify/cert/${token}`);
}

beforeEach(() => {
  state = baseState();
  db.query.mockReset();
  db.query.mockImplementation(poolQuery);
});

// ============================================================
// 1) EMISSÃO EM MASSA
// ============================================================
describe('POST /federation/:id/belt-exams/:examId/certificates — emissão em massa', () => {
  test('emite só os elegíveis: aprovado no exame OU certificate_eligible=true; reprovado sem flag fica de fora', async () => {
    const res = await issueCerts(FED_A, EXAM_ID);
    expect(res.status).toBe(201);
    expect(res.body.eligible).toBe(2);
    expect(res.body.issued).toBe(2);
    expect(res.body.skipped).toBe(0);

    const issuedStudentIds = Object.values(state.issued).map((c) => c.student_id).sort();
    expect(issuedStudentIds).toEqual([STUDENT_APPROVED, STUDENT_ELIGIBLE_FLAG].sort());
    expect(issuedStudentIds).not.toContain(STUDENT_FAILED);
  });

  test('exame do tipo curso: elegível é status NOT IN (absent, rejected) — não exige "approved"', async () => {
    const res = await issueCerts(FED_A, CURSO_EXAM_ID);
    expect(res.status).toBe(201);
    expect(res.body.eligible).toBe(1);
    expect(res.body.issued).toBe(1);
    expect(Object.values(state.issued)[0].student_id).toBe(STUDENT_CURSO_PRESENT);
  });

  test('student_ids filtra o lote', async () => {
    const res = await issueCerts(FED_A, EXAM_ID, { student_ids: [STUDENT_APPROVED] });
    expect(res.status).toBe(201);
    expect(res.body.eligible).toBe(1);
    expect(res.body.issued).toBe(1);
    expect(Object.values(state.issued)[0].student_id).toBe(STUDENT_APPROVED);
  });

  test('reemitir para o MESMO evento+aluno é SKIPPED, nunca duplica', async () => {
    await issueCerts(FED_A, EXAM_ID, { student_ids: [STUDENT_APPROVED] });
    const res2 = await issueCerts(FED_A, EXAM_ID, { student_ids: [STUDENT_APPROVED] });
    expect(res2.status).toBe(201);
    expect(res2.body.issued).toBe(0);
    expect(res2.body.skipped).toBe(1);
    expect(Object.keys(state.issued)).toHaveLength(1); // não duplicou
  });

  test('data_snapshot traz os campos que buildCertificateHtml consome, com instructors_text SEM prefixo "Sensei" duplicado (congela o #477)', async () => {
    await issueCerts(FED_A, EXAM_ID, {
      student_ids: [STUDENT_APPROVED],
      dates_text: '20/08/2026',
      issued_date_text: '25/08/2026',
      location: 'Ginásio Central',
    });
    const cert = Object.values(state.issued)[0];
    expect(cert.data_snapshot).toEqual({
      participant_name: 'Aluno Aprovado',
      course_name: 'Exame de Faixa Preta',
      hours: 8,
      // Os dois instrutores já digitam "Sensei" no próprio nome; a rota NÃO
      // pode prefixar de novo (bug #477 gerava "Sensei Sensei Fulano").
      instructors_text: 'Sensei Kondei e Sensei Ana',
      dates_text: '20/08/2026',
      location: 'Ginásio Central',
      issued_date_text: '25/08/2026',
      federation_name: 'FPKT Central',
      signatories: [
        { name: 'Sensei Kondei', role: 'Examinador', signature_url: null },
        { name: 'Sensei Ana', role: null, signature_url: 'https://r2/ana.png' },
      ],
    });
  });

  test('congela o #477 isoladamente: UM único instrutor "Sensei Marcos" vira instructors_text "Sensei Marcos", nunca "Sensei Sensei Marcos"', async () => {
    await issueCerts(FED_A, CURSO_EXAM_ID, { student_ids: [STUDENT_CURSO_PRESENT] });
    const cert = Object.values(state.issued)[0];
    expect(cert.data_snapshot.instructors_text).toBe('Sensei Marcos');
  });

  test('template_id do banco: template_snapshot herda layout/title/font do modelo carregado (mesma federação)', async () => {
    await issueCerts(FED_A, EXAM_ID, { student_ids: [STUDENT_APPROVED], template_id: TEMPLATE_ID });
    const cert = Object.values(state.issued)[0];
    expect(cert.template_snapshot).toMatchObject({ layout: 'B', title: 'CERTIFICADO OFICIAL', font: 'elegante' });
  });

  test('evento inexistente é 404', async () => {
    const res = await issueCerts(FED_A, 'evento-que-nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

// ============================================================
// 2) ESCOPO POR FEDERAÇÃO
// ============================================================
describe('Escopo por federação — uma federação não emite nem lista sobre evento de outra', () => {
  test('POST: emitir sobre evento de OUTRA federação é 404 (escopo pelo federation_id do DADO simulado, nunca a constante do teste)', async () => {
    // EXAM_ID pertence a FED_A (state.exams[EXAM_ID].federation_id === FED_A).
    // FED_B tenta emitir usando o PRÓPRIO id na URL — o mock só devolve o
    // evento se ex.federation_id (campo do dado) bater com o parâmetro; aqui
    // não bate, então tem que dar 404, nunca "vazar" o evento de FED_A.
    const res = await issueCerts(FED_B, EXAM_ID);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(Object.keys(state.issued)).toHaveLength(0); // nada foi emitido
  });

  test('GET: listar certificados de um evento de OUTRA federação nunca vaza os certificados emitidos pela federação dona', async () => {
    // FED_A emite normalmente para o próprio evento.
    const issueRes = await issueCerts(FED_A, EXAM_ID);
    expect(issueRes.body.issued).toBe(2);

    // Contraprova: a própria FED_A lista e vê os 2 certificados.
    const ownList = await listCerts(FED_A, EXAM_ID);
    expect(ownList.status).toBe(200);
    expect(ownList.body).toHaveLength(2);

    // FED_B lista o MESMO examId, mas com o PRÓPRIO federation_id na URL.
    // Os certificados emitidos têm federation_id=FED_A (campo do dado
    // simulado) — o filtro tem que bater contra ESSE campo, não contra a
    // constante FED_B do teste, senão o teste passaria mesmo com um SQL
    // que ignorasse o escopo.
    const otherList = await listCerts(FED_B, EXAM_ID);
    expect(otherList.status).toBe(200);
    expect(otherList.body).toEqual([]);
  });
});

// ============================================================
// 3) VERIFICAÇÃO PÚBLICA POR TOKEN
// ============================================================
describe('GET /public/karate/verify/cert/:token — verificação pública', () => {
  test('token válido resolve o certificado certo e a resposta traz o data_snapshot + template_snapshot', async () => {
    await issueCerts(FED_A, EXAM_ID, { student_ids: [STUDENT_APPROVED] });
    const cert = Object.values(state.issued)[0];

    const res = await verifyToken(cert.verify_token);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.federation_name).toBe('FPKT Central');
    expect(res.body.data).toEqual(cert.data_snapshot);
    expect(res.body.template).toEqual(cert.template_snapshot);
    expect(res.body.issued_at).toBe(cert.issued_at);
  });

  test('o token resolve o certificado CERTO mesmo havendo mais de um emitido (não pega o primeiro por engano)', async () => {
    await issueCerts(FED_A, EXAM_ID); // emite STUDENT_APPROVED + STUDENT_ELIGIBLE_FLAG
    const certs = Object.values(state.issued);
    expect(certs).toHaveLength(2);
    const [certOne, certTwo] = certs;

    const resOne = await verifyToken(certOne.verify_token);
    expect(resOne.body.data.participant_name).toBe(certOne.data_snapshot.participant_name);

    const resTwo = await verifyToken(certTwo.verify_token);
    expect(resTwo.body.data.participant_name).toBe(certTwo.data_snapshot.participant_name);
    expect(resTwo.body.data.participant_name).not.toBe(resOne.body.data.participant_name);
  });

  test('certificado revogado devolve valid:false + revoked:true, sem vazar o data_snapshot', async () => {
    await issueCerts(FED_A, EXAM_ID, { student_ids: [STUDENT_APPROVED] });
    const cert = Object.values(state.issued)[0];
    state.issued[cert.id].revoked = true;

    const res = await verifyToken(cert.verify_token);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.revoked).toBe(true);
    expect(res.body.data).toBeUndefined();
  });

  test('token inexistente é 404 com valid:false', async () => {
    const res = await verifyToken('token-que-nao-existe');
    expect(res.status).toBe(404);
    expect(res.body.valid).toBe(false);
  });
});
