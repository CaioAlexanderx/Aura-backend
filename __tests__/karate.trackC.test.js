// ============================================================
// AURA KARATÊ — Testes unitários Track C (exames, elegibilidade, certificados)
//
// Cobertura exigida:
//   1. Criar exame → 201
//   2. Inscrever candidato inelegível → 201 + eligibility (FPKT #1)
//   3. Aprovar candidato → trigger insere histórico (status='approved')
//   4. Fechar exame → sem certificado (FPKT #3)
//   5. Emitir certificado sob demanda → 201
//
// IMPORTANTE sobre mocks Jest:
//   - Ordem dos mocks = ordem real das queries (BEGIN→checagens→lock→INSERT→COMMIT)
//   - afterEach: db.query.mockReset() + db.connect.mockReset() para drenar
//     mockResolvedValueOnce. NÃO confiar em jest.clearAllMocks() para isso.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/karateExamService');
jest.mock('../src/services/karateCertificateService');

const db = require('../src/config/database');
const { checkEligibility } = require('../src/services/karateExamService');
const { issueCertificate } = require('../src/services/karateCertificateService');

// Module-scope afterEach: drena mockResolvedValueOnce queues após cada teste.
// mockReset() limpa implementações enfileiradas (clearAllMocks NÃO faz isso).
afterEach(() => {
  if (typeof db.query.mockReset === 'function') db.query.mockReset();
  if (typeof db.connect.mockReset === 'function') db.connect.mockReset();
});

const express = require('express');
const request = require('supertest');
const jwt     = require('jsonwebtoken');

const makeToken = (overrides) => jwt.sign(
  Object.assign({ id: 'user-test-uuid', role: 'admin', plan: 'expansao' }, overrides || {}),
  'aura-test-secret-2026',
  { expiresIn: '1h' }
);
const adminToken = makeToken();

const FED_ID       = 'fed-uuid-001';
const EXAM_ID      = 'exam-uuid-001';
const STUDENT_ID   = 'student-uuid-001';
const CANDIDATE_ID = 'cand-uuid-001';
const CERT_ID      = 'cert-uuid-001';

function buildApp() {
  const app = express();
  app.use(express.json());
  // Track C routes montados como em index.js (sem prefixo duplicado)
  app.use('/federation/:id', require('../src/routes/karateRequirements'));
  app.use('/federation/:id', require('../src/routes/karateExams'));
  app.use('/federation/:id', require('../src/routes/karateCourses'));
  app.use('/federation/:id', require('../src/routes/karateCertificates'));
  return app;
}

// ── Suite 1: Criar Exame ─────────────────────────────────────
describe('POST /federation/:id/belt-exams (criar exame)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    // INSERT retorna exame criado
    db.query.mockResolvedValueOnce({
      rows: [{
        id: EXAM_ID,
        federation_id: FED_ID,
        dojo_id: null,
        exam_date: '2026-09-15',
        location: 'Ginásio Central',
        status: 'scheduled',
        notes: null,
        created_at: new Date().toISOString(),
      }],
    });
  });

  it('cria exame e retorna 201 com status=scheduled', (done) => {
    request(app)
      .post('/federation/' + FED_ID + '/belt-exams')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ exam_date: '2026-09-15', location: 'Ginásio Central' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(201);
        expect(res.body.id).toBe(EXAM_ID);
        expect(res.body.status).toBe('scheduled');
        expect(res.body.candidate_count).toBe(0);
        expect(res.body.examiner_count).toBe(0);
        done();
      });
  });

  it('retorna 422 sem exam_date', (done) => {
    jest.clearAllMocks();
    request(app)
      .post('/federation/' + FED_ID + '/belt-exams')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ location: 'Ginásio Central' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/exam_date/);
        done();
      });
  });
});

// ── Suite 2: Inscrever Candidato (FPKT #1 — sempre 201, mesmo inelegível) ──
describe('POST /belt-exams/:examId/candidates — elegibilidade é só AVISO', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();

    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    // Ordem: BEGIN → verifica exame → advisory lock → checa dup → INSERT → COMMIT
    mockClient.query
      .mockResolvedValueOnce({})                         // BEGIN
      .mockResolvedValueOnce({                           // SELECT exame (existe, status=scheduled)
        rows: [{ id: EXAM_ID, status: 'scheduled' }],
      })
      .mockResolvedValueOnce({ rows: [] })               // advisory lock
      .mockResolvedValueOnce({ rows: [] })               // check duplicata
      .mockResolvedValueOnce({                           // INSERT candidato
        rows: [{
          id: CANDIDATE_ID,
          exam_id: EXAM_ID,
          student_id: STUDENT_ID,
          target_belt: 5,
          status: 'enrolled',
          enrolled_at: new Date().toISOString(),
        }],
      })
      .mockResolvedValueOnce({});                        // COMMIT

    // Mock checkEligibility retornando INELEGÍVEL (candidato não atende critérios)
    // FPKT #1: isso NÃO deve impedir a inscrição — sempre 201
    checkEligibility.mockResolvedValue({
      eligible: false,
      is_hard_block: false,  // sempre false!
      checks: [
        {
          criterion: 'min_months_in_current_belt',
          ok: false,
          required: 12,
          actual: 3,
          unit: 'meses',
          confirmed: false,  // critério provisório
        },
      ],
      warnings: ['Critério "min_months_in_current_belt" não atendido: esperado 12 meses, atual 3'],
    });
  });

  it('SEMPRE retorna 201 mesmo com candidato inelegível — elegibilidade é só aviso (FPKT #1)', (done) => {
    request(app)
      .post('/federation/' + FED_ID + '/belt-exams/' + EXAM_ID + '/candidates')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ student_id: STUDENT_ID, target_belt: 5 })
      .end((err, res) => {
        if (err) return done(err);
        // FPKT #1: NUNCA 422 por elegibilidade
        expect(res.status).toBe(201);
        expect(res.body.id).toBe(CANDIDATE_ID);
        expect(res.body.status).toBe('enrolled');
        // Elegibilidade anexada como aviso
        expect(res.body.eligibility).toBeDefined();
        expect(res.body.eligibility.eligible).toBe(false);
        expect(res.body.eligibility.is_hard_block).toBe(false); // NUNCA bloqueia
        expect(Array.isArray(res.body.eligibility.checks)).toBe(true);
        expect(res.body.eligibility.checks[0].criterion).toBe('min_months_in_current_belt');
        expect(res.body.eligibility.checks[0].confirmed).toBe(false); // critério provisório (FPKT #2)
        done();
      });
  });

  it('retorna 422 sem student_id', (done) => {
    jest.clearAllMocks();
    request(app)
      .post('/federation/' + FED_ID + '/belt-exams/' + EXAM_ID + '/candidates')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ target_belt: 5 })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/student_id/);
        done();
      });
  });

  it('retorna 422 sem target_belt', (done) => {
    jest.clearAllMocks();
    request(app)
      .post('/federation/' + FED_ID + '/belt-exams/' + EXAM_ID + '/candidates')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ student_id: STUDENT_ID })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ── Suite 3: Aprovar Candidato → trigger insere histórico ───
describe('PATCH /belt-exams/:examId/candidates/:candidateId (lançar resultado)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    // Ordem: SELECT candidato → UPDATE (dispara trigger)
    db.query
      .mockResolvedValueOnce({   // SELECT candidato + exame
        rows: [{
          id: CANDIDATE_ID,
          student_id: STUDENT_ID,
          current_status: 'enrolled',
          target_belt: 5,
        }],
      })
      .mockResolvedValueOnce({   // UPDATE status=approved (trigger karate_on_exam_approved)
        rows: [{
          id: CANDIDATE_ID,
          exam_id: EXAM_ID,
          student_id: STUDENT_ID,
          target_belt: 5,
          status: 'approved',
          result_notes: 'Excelente desempenho',
          result_at: new Date().toISOString(),
        }],
      });
  });

  it('aprova candidato — trigger insere histórico de faixa', (done) => {
    request(app)
      .patch('/federation/' + FED_ID + '/belt-exams/' + EXAM_ID + '/candidates/' + CANDIDATE_ID)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ status: 'approved', result_notes: 'Excelente desempenho' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('approved');
        expect(res.body.result_at).toBeTruthy();
        // Nota sobre o trigger
        expect(res.body._note).toMatch(/trigger karate_on_exam_approved/i);
        done();
      });
  });

  it('retorna 422 com status inválido', (done) => {
    jest.clearAllMocks();
    request(app)
      .patch('/federation/' + FED_ID + '/belt-exams/' + EXAM_ID + '/candidates/' + CANDIDATE_ID)
      .set('Authorization', 'Bearer ' + adminToken)
      .send({ status: 'invalido' })
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(422);
        done();
      });
  });
});

// ── Suite 4: Fechar Exame SEM emitir certificado (FPKT #3) ──
describe('POST /belt-exams/:examId/close (fechar sem certificado)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();

    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    // Ordem: BEGIN → SELECT FOR UPDATE → SELECT pending → UPDATE status=done
    //        → SELECT summary → COMMIT
    mockClient.query
      .mockResolvedValueOnce({})                         // BEGIN
      .mockResolvedValueOnce({                           // SELECT exame FOR UPDATE
        rows: [{ id: EXAM_ID, status: 'in_progress' }],
      })
      .mockResolvedValueOnce({                           // SELECT pending candidates
        rows: [{ pending: '0' }],
      })
      .mockResolvedValueOnce({                           // UPDATE status=done
        rows: [{ id: EXAM_ID, status: 'done', updated_at: new Date().toISOString() }],
      })
      .mockResolvedValueOnce({                           // SELECT summary
        rows: [
          { status: 'approved', cnt: '3' },
          { status: 'failed',   cnt: '1' },
        ],
      })
      .mockResolvedValueOnce({});                        // COMMIT
  });

  it('fecha exame com status=done e NÃO menciona certificados automáticos (FPKT #3)', (done) => {
    request(app)
      .post('/federation/' + FED_ID + '/belt-exams/' + EXAM_ID + '/close')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('done');
        expect(res.body.summary).toBeDefined();
        expect(res.body.summary.approved).toBe(3);
        expect(res.body.summary.failed).toBe(1);
        // FPKT #3: nota explícita de que certificados NÃO são emitidos
        expect(res.body._note).toMatch(/NÃO emitidos automaticamente/i);
        done();
      });
  });

  it('retorna 409 quando exame já está fechado', (done) => {
    jest.clearAllMocks();
    const mockClient = { query: jest.fn(), release: jest.fn() };
    db.connect.mockResolvedValue(mockClient);

    mockClient.query
      .mockResolvedValueOnce({})                         // BEGIN
      .mockResolvedValueOnce({                           // SELECT exame (já done)
        rows: [{ id: EXAM_ID, status: 'done' }],
      })
      .mockResolvedValueOnce({});                        // ROLLBACK

    request(app)
      .post('/federation/' + FED_ID + '/belt-exams/' + EXAM_ID + '/close')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CONFLICT');
        done();
      });
  });
});

// ── Suite 5: Emitir Certificado Sob Demanda (FPKT #3) ────────
describe('POST /certificates/:candidateId/issue (emissão sob demanda)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock issueCertificate retorna sucesso
    issueCertificate.mockResolvedValue({
      certificate_id: CERT_ID,
      status: 'generated',
      url: 'https://cdn.getaura.com.br/certificates/' + FED_ID + '/' + EXAM_ID + '/' + STUDENT_ID + '.pdf',
      idempotent_hit: false,
    });
  });

  it('emite certificado sob demanda e retorna 201 (FPKT #3)', (done) => {
    request(app)
      .post('/federation/' + FED_ID + '/certificates/' + CANDIDATE_ID + '/issue')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        // FPKT #3: sob demanda, não automático
        expect(res.status).toBe(201);
        expect(res.body.certificate_id).toBe(CERT_ID);
        expect(res.body.status).toBe('generated');
        expect(res.body.url).toMatch(/\.pdf$/);
        expect(res.body.idempotent_hit).toBe(false);
        // Nota sobre emissão sob demanda
        expect(res.body._note).toMatch(/sob demanda/i);
        done();
      });
  });

  it('retorna 409 quando candidato não aprovado', (done) => {
    jest.clearAllMocks();
    const notApprovedErr = new Error('Certificado só pode ser emitido para candidatos aprovados');
    notApprovedErr.code = 'NOT_APPROVED';
    issueCertificate.mockRejectedValue(notApprovedErr);

    request(app)
      .post('/federation/' + FED_ID + '/certificates/' + CANDIDATE_ID + '/issue')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NOT_APPROVED');
        done();
      });
  });

  it('retorna 404 quando candidato não encontrado', (done) => {
    jest.clearAllMocks();
    const notFoundErr = new Error('Candidato não encontrado');
    notFoundErr.code = 'NOT_FOUND';
    issueCertificate.mockRejectedValue(notFoundErr);

    request(app)
      .post('/federation/' + FED_ID + '/certificates/' + CANDIDATE_ID + '/issue')
      .set('Authorization', 'Bearer ' + adminToken)
      .send({})
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(404);
        done();
      });
  });
});

// ── Suite 6: GET /belt-requirements (critérios com confirmed) ─
describe('GET /federation/:id/belt-requirements (FPKT #2 — confirmed exposto)', () => {
  let app;
  beforeAll(() => { app = buildApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'req-1',
          federation_id: FED_ID,
          target_belt_level: 5,
          target_belt_name: 'Amarela',
          criterion: 'min_months_in_current_belt',
          required_value: '12',
          unit: 'meses',
          description: 'Mínimo 12 meses na faixa atual',
          confirmed: false,  // FPKT #2: provisório
          sort_order: 1,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          id: 'req-2',
          federation_id: FED_ID,
          target_belt_level: 5,
          target_belt_name: 'Amarela',
          criterion: 'min_trainings',
          required_value: '30',
          unit: 'treinos',
          description: 'Mínimo 30 treinos',
          confirmed: true,   // confirmado
          sort_order: 2,
          is_active: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ],
    });
  });

  it('retorna critérios com campo confirmed (FPKT #2)', (done) => {
    request(app)
      .get('/federation/' + FED_ID + '/belt-requirements')
      .set('Authorization', 'Bearer ' + adminToken)
      .end((err, res) => {
        if (err) return done(err);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body[0].confirmed).toBe(false);  // provisório
        expect(res.body[1].confirmed).toBe(true);   // confirmado
        // FPKT #2: confirmed é exposto
        expect(res.body[0]).toHaveProperty('confirmed');
        done();
      });
  });
});
