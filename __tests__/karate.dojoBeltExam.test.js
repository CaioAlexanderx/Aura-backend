// ============================================================
// AURA DOJÔ — F8.1: testes do EXAME DE FAIXA DO DOJÔ
//
// A regra que estes testes protegem (Caio, 31/07/2026):
//   "No exame de faixa (branca até marrom) é o SENSEI que realiza; ele
//    apenas envia o resultado dos aprovados para a federação emitir o
//    certificado. A federação usa banca apenas para exame de faixa preta."
//
// Cobertura:
//   1. TETO DO SENSEI — destino Preta é recusado (e NADA é gravado)
//   2. destino abaixo/igual à faixa atual é recusado
//   3. Marrom sem grau é recusado (3 kyus na mesma cor — não se adivinha)
//   4. federado gera karate_belt_history com source='exam_dojo';
//      NÃO federado é graduado no dojô e NÃO gera histórico (com motivo)
//   5. relançar o mesmo exame NÃO duplica graduação (2 travas)
//   6. certificado sai SÓ para quem o sensei marcou
//   7. anexo: aceito, recusado por tipo, recusado por tamanho, e o teto
//      por exame
//   8. Canal B (portal) é read-only em toda escrita
//   9. a escada devolvida à UI marca a Preta como não concedível
//
// ── ESTILO: MOCK POR SQL, NUNCA POR POSIÇÃO ────────────────
// Toda SQL do service/rota começa com uma âncora `-- f81:<nome>`. O
// despacho abaixo lê a âncora por regex. Fila posicional
// (mockResolvedValueOnce encadeado / mock.calls[N] fixo) já derrubou o CI
// deste repo quatro vezes: uma query nova entrando na frente do handler
// desalinha o arquivo inteiro. Aqui, não.
//
// db.query e db.connect vêm do mock GLOBAL (tests/jest.setup.js).
// ============================================================
'use strict';

jest.mock('../src/services/karateCertificateService');
jest.mock('../src/services/karateDojoLinkStatus');
jest.mock('../src/utils/r2Storage');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const { createOrder } = require('../src/services/karateCertificateService');
const { isDojoLinked } = require('../src/services/karateDojoLinkStatus');
const r2 = require('../src/utils/r2Storage');
const svc = require('../src/services/karateDojoBeltExamService');
const examRouter = require('../src/routes/karateDojoBeltExams');

const FED_ID = '11111111-1111-4111-8111-111111111111';
const DOJO_ID = '22222222-2222-4222-8222-222222222222';
const EXAM_ID = '33333333-3333-4333-8333-333333333333';
const STUDENT_FED = '44444444-4444-4444-8444-444444444444';
const STUDENT_LOCAL = '55555555-5555-4555-8555-555555555555';
const PRACTITIONER = '66666666-6666-4666-8666-666666666666';
const DOC_ID = '77777777-7777-4777-8777-777777777777';

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
  app.use('/federation/:id', examRouter);
  return app;
}

// ── Estado do "banco" ──────────────────────────────────────
let state;

function baseState() {
  return {
    exam: {
      id: EXAM_ID,
      dojo_id: DOJO_ID,
      federation_id: FED_ID,
      exam_date: '2026-07-15',
      title: 'Exame de julho',
      examiner_name: 'Sensei Kondei',
      notes: null,
      status: 'draft',
      created_by: 'user-sensei-1',
      created_by_name: 'Sensei Kondei',
      created_at: '2026-07-10T12:00:00Z',
      updated_at: '2026-07-10T12:00:00Z',
    },
    students: {
      [STUDENT_FED]: {
        id: STUDENT_FED,
        full_name: 'Aluna Federada',
        practitioner_id: PRACTITIONER,
        belt_label: 'Verde',
        belt_order: 4,
        status: 'active',
      },
      [STUDENT_LOCAL]: {
        id: STUDENT_LOCAL,
        full_name: 'Aluno do Dojô',
        practitioner_id: null,
        belt_label: 'Amarela',
        belt_order: 2,
        status: 'active',
      },
    },
    // karate_current_belt por practitioner_id
    currentBelt: {},
    // último resultado aprovado do dojô, por student_id
    lastDojoResult: {},
    // belt_history_id já gravado na linha de resultado (1ª trava)
    existingHistoryByStudent: {},
    // gêmeo pela chave natural (2ª trava)
    twinHistoryId: null,
    // colunas opcionais presentes
    hasBeltHistoryOptionalCols: true,
    hasResultCertCols: true,
    // anexos existentes no exame
    attachmentCount: 0,
    attachmentRows: [],
    // gravações observadas
    calls: { beltHistoryInserts: [], studentBeltUpdates: [], upserts: [], attachmentInserts: [] },
  };
}

function tagOf(sql) {
  const m = String(sql).match(/--\s*f81:([a-z-]+)/i);
  return m ? m[1] : null;
}

function poolQuery(sql, params) {
  const tag = tagOf(sql);
  const p = params || [];
  switch (tag) {
    case 'probe-belt-history-cols':
      return Promise.resolve({
        rows: state.hasBeltHistoryOptionalCols
          ? [{ column_name: 'source' }, { column_name: 'source_dojo_id' }, { column_name: 'belt_kyu' }, { column_name: 'belt_dan' }]
          : [],
      });
    case 'probe-result-cols':
      return Promise.resolve({
        rows: state.hasResultCertCols
          ? [{ column_name: 'certificate_requested' }, { column_name: 'certificate_order_id' }]
          : [],
      });
    case 'load-exam':
      // Escopo por dojô: a linha simulada só "existe" para quem consulta
      // se dojo_id do TOKEN ($2) bater com dojo_id DA LINHA
      // (state.exam.dojo_id) — nunca contra uma constante fixa. Comparar
      // contra a constante DOJO_ID faria esta condição ser sempre
      // verdadeira nos testes (o token aqui usa sempre DOJO_ID), mesmo
      // quando o teste muda state.exam.dojo_id para simular um exame de
      // OUTRO dojô — mascarando exatamente o caso que o teste "exame de
      // outro dojô é 404" existe para provar.
      return Promise.resolve({ rows: state.exam && p[0] === state.exam.id && p[1] === state.exam.dojo_id ? [state.exam] : [] });
    case 'insert-exam':
      return Promise.resolve({
        rows: [Object.assign({}, state.exam, { exam_date: p[2], title: p[3], examiner_name: p[4], notes: p[5] })],
      });
    case 'list-exams':
      return Promise.resolve({ rows: state.exam ? [Object.assign({ results_count: 0, approved_count: 0 }, state.exam)] : [] });
    case 'list-results':
      return Promise.resolve({ rows: [] });
    case 'load-students': {
      const ids = p[1] || [];
      return Promise.resolve({ rows: ids.map((id) => state.students[id]).filter(Boolean) });
    }
    case 'last-dojo-result': {
      const r = state.lastDojoResult[p[0]];
      return Promise.resolve({ rows: r ? [r] : [] });
    }
    case 'current-belt': {
      const r = state.currentBelt[p[0]];
      return Promise.resolve({ rows: r ? [r] : [] });
    }
    case 'count-attachments':
      return Promise.resolve({ rows: [{ n: state.attachmentCount }] });
    case 'list-attachments':
      return Promise.resolve({ rows: state.attachmentRows });
    case 'insert-attachment':
      state.calls.attachmentInserts.push(p);
      return Promise.resolve({
        rows: [
          {
            id: DOC_ID,
            filename: p[4],
            content_type: p[5],
            size_bytes: p[6],
            note: p[7],
            uploaded_by: p[8],
            created_at: '2026-07-16T10:00:00Z',
          },
        ],
      });
    case 'load-attachment':
      return Promise.resolve({ rows: state.attachmentRows.length ? [{ id: DOC_ID, r2_key: 'k/1.pdf' }] : [] });
    default:
      return Promise.resolve({ rows: [] });
  }
}

function makeClient() {
  const client = { query: jest.fn(), release: jest.fn() };
  let seq = 0;
  client.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(s)) return Promise.resolve({ rows: [] });
    const p = params || [];
    switch (tagOf(s)) {
      case 'upsert-result': {
        state.calls.upserts.push({ sql: s, params: p });
        const studentId = p[2];
        return Promise.resolve({
          rows: [{ id: 'result-' + studentId, belt_history_id: state.existingHistoryByStudent[studentId] || null }],
        });
      }
      case 'update-student-belt':
        state.calls.studentBeltUpdates.push(p);
        return Promise.resolve({ rows: [] });
      case 'belt-history-twin':
        return Promise.resolve({ rows: state.twinHistoryId ? [{ id: state.twinHistoryId }] : [] });
      case 'insert-belt-history':
        seq += 1;
        state.calls.beltHistoryInserts.push({ sql: s, params: p });
        return Promise.resolve({ rows: [{ id: 'history-' + seq }] });
      default:
        return Promise.resolve({ rows: [] });
    }
  });
  return client;
}

function postResults(results, extra) {
  return request(buildApp())
    .post(`/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}/results`)
    .set('Authorization', 'Bearer ' + tokenA)
    .send(Object.assign({ results }, extra || {}));
}

beforeEach(() => {
  state = baseState();
  svc.__resetColumnCache();

  db.query.mockReset();
  db.query.mockImplementation(poolQuery);
  db.connect.mockReset();
  db.connect.mockImplementation(() => Promise.resolve(makeClient()));

  createOrder.mockReset();
  createOrder.mockImplementation(({ practitionerId }) =>
    Promise.resolve({ id: 'order-' + practitionerId, status: 'requested' })
  );

  isDojoLinked.mockReset();
  isDojoLinked.mockResolvedValue(true);

  r2.uploadToR2.mockReset();
  r2.uploadToR2.mockResolvedValue({ success: true, key: 'fed/docs/exam/1.pdf', size: 1024 });
  r2.getSignedUrl.mockReset();
  r2.getSignedUrl.mockResolvedValue('https://r2.example/signed');
  r2.deleteFromR2.mockReset();
  r2.deleteFromR2.mockResolvedValue({ success: true });
  r2.generateDocKey.mockReset();
  r2.generateDocKey.mockReturnValue('fed/docs/exam/1.pdf');
});

// ============================================================
// 1) O TETO DO SENSEI
// ============================================================
describe('F8.1 — o teto do sensei é o 1º kyu', () => {
  test('destino Preta é RECUSADO e nada é gravado', async () => {
    const res = await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'preta' },
    ]);

    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ student_id: STUDENT_FED, code: 'TETO_DO_SENSEI' });
    // A mensagem tem de EXPLICAR, não só recusar: é a nota da própria
    // tabela de requisitos da FPKT no degrau 1kyu → 1dan.
    expect(res.body.errors[0].message).toMatch(/banca/i);
    // Recusa em leitura pura: a transação nem chega a abrir.
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('destino Preta também é recusado para quem REPROVOU (o CHECK do banco proíbe em qualquer linha)', async () => {
    const res = await postResults([
      { student_id: STUDENT_FED, result: 'failed', to_belt_level: 'preta' },
    ]);

    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('TETO_DO_SENSEI');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('Marrom 1º kyu — o último degrau do sensei — é ACEITO', async () => {
    state.students[STUDENT_FED].belt_label = 'Marrom 2º kyu';
    const res = await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'marrom', to_belt_kyu: 1 },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.results[0].to_belt).toMatchObject({ level: 'marrom', kyu: 1, label: 'Marrom 1º kyu' });
  });

  test('a escada devolvida à UI marca a Preta como NÃO concedível pelo dojô', async () => {
    const res = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/belt-ladder`)
      .set('Authorization', 'Bearer ' + tokenA);

    expect(res.status).toBe(200);
    const grantable = res.body.data.filter((s) => s.grantable_by_dojo);
    const blocked = res.body.data.filter((s) => !s.grantable_by_dojo);
    expect(grantable[grantable.length - 1]).toMatchObject({ level: 'marrom', kyu: 1 });
    expect(blocked.every((s) => s.level === 'preta')).toBe(true);
    expect(res.body.ceiling).toMatchObject({ level: 'marrom', kyu: 1 });
  });
});

// ============================================================
// 2) GRADUAÇÃO É SEMPRE PARA CIMA
// ============================================================
describe('F8.1 — destino abaixo ou igual à faixa atual', () => {
  test('destino IGUAL à faixa atual é recusado', async () => {
    // belt_label = 'Verde' (7º kyu)
    const res = await postResults([{ student_id: STUDENT_FED, result: 'approved', to_belt_level: 'verde' }]);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('FAIXA_NAO_SUPERIOR');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('destino ABAIXO da faixa atual é recusado', async () => {
    const res = await postResults([{ student_id: STUDENT_FED, result: 'approved', to_belt_level: 'laranja' }]);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('FAIXA_NAO_SUPERIOR');
  });

  test('a faixa da FEDERAÇÃO também conta — não dá para regraduar por outro caminho', async () => {
    // Ficha do dojô diz Verde (7º kyu), mas a federação já registrou Roxa
    // (5º kyu). Azul Claro (6º kyu) está acima da ficha e ABAIXO da
    // federação: tem de ser recusado.
    state.currentBelt[PRACTITIONER] = { belt_level: 'roxo', belt_name: 'Roxa', belt_schema: 'fpkt_shotokan' };
    const res = await postResults([{ student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' }]);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('FAIXA_NAO_SUPERIOR');
  });

  test('faixa atual DESCONHECIDA não bloqueia (dado faltante é neutro)', async () => {
    state.students[STUDENT_LOCAL].belt_label = null;
    const res = await postResults([{ student_id: STUDENT_LOCAL, result: 'approved', to_belt_level: 'branca' }]);
    expect(res.status).toBe(200);
    expect(res.body.results[0].from_belt).toBeNull();
  });

  test('Marrom SEM grau é recusado — três kyus na mesma cor não se adivinha', async () => {
    const res = await postResults([{ student_id: STUDENT_FED, result: 'approved', to_belt_level: 'marrom' }]);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('GRAU_OBRIGATORIO');
  });

  test('aluno de OUTRO dojô é recusado', async () => {
    const OUTRO = '99999999-9999-4999-8999-999999999999';
    const res = await postResults([{ student_id: OUTRO, result: 'approved', to_belt_level: 'branca' }]);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('ALUNO_NAO_ENCONTRADO');
  });
});

// ============================================================
// 3) FEDERADO × NÃO FEDERADO
// ============================================================
describe('F8.1 — federado gera histórico na federação; não federado não', () => {
  test("aluno FEDERADO gera karate_belt_history com source='exam_dojo' e o dojô que registrou", async () => {
    const res = await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' },
    ]);

    expect(res.status).toBe(200);
    expect(state.calls.beltHistoryInserts).toHaveLength(1);

    const ins = state.calls.beltHistoryInserts[0];
    const cols = ins.sql.slice(ins.sql.indexOf('('), ins.sql.indexOf('VALUES'));
    expect(cols).toMatch(/\bsource\b/);
    expect(cols).toMatch(/\bsource_dojo_id\b/);
    expect(cols).toMatch(/\bbelt_kyu\b/);
    expect(ins.params).toContain('exam_dojo');
    expect(ins.params).toContain(DOJO_ID);
    expect(ins.params).toContain(PRACTITIONER);
    expect(ins.params).toContain(FED_ID);
    // A graduação é datada pelo EXAME, não pelo momento do lançamento.
    expect(ins.params).toContain('2026-07-15');
    // Azul Claro é 6º kyu na escala oficial.
    expect(ins.params).toContain(6);

    expect(res.body.results[0]).toMatchObject({ federated: true, belt_history: 'created' });
    expect(res.body.results[0].belt_history_id).toBe('history-1');
    expect(res.body.summary.belt_history_created).toBe(1);
  });

  test('aluno NÃO FEDERADO é graduado no dojô, NÃO gera histórico, e a resposta DIZ o motivo', async () => {
    const res = await postResults([
      { student_id: STUDENT_LOCAL, result: 'approved', to_belt_level: 'laranja' },
    ]);

    expect(res.status).toBe(200);
    expect(state.calls.beltHistoryInserts).toHaveLength(0);

    const r = res.body.results[0];
    expect(r.federated).toBe(false);
    expect(r.belt_history_id).toBeNull();
    expect(r.belt_history).toBeNull();
    expect(r.belt_history_skipped_reason).toBe('ALUNO_NAO_FEDERADO');
    // Mas a graduação ACONTECEU: a faixa do aluno subiu.
    expect(r.student_belt_updated).toBe(true);
    expect(res.body.summary.not_federated).toBe(1);
  });

  test('a faixa do aluno passa a ser CONSEQUÊNCIA da graduação (label + order gravados)', async () => {
    await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' },
      { student_id: STUDENT_LOCAL, result: 'approved', to_belt_level: 'laranja' },
    ]);

    expect(state.calls.studentBeltUpdates).toHaveLength(2);
    const fed = state.calls.studentBeltUpdates.find((p) => p[2] === STUDENT_FED);
    expect(fed[0]).toBe('Azul Claro');
    expect(fed[1]).toBe(5); // LEVEL_RANK canônico: azul_claro = 5
    expect(fed[3]).toBe(DOJO_ID); // escopo SEMPRE do token
  });

  test('REPROVADO não gradua: sem histórico, sem alterar a faixa do aluno', async () => {
    const res = await postResults([
      { student_id: STUDENT_FED, result: 'failed', to_belt_level: 'azul_claro' },
    ]);

    expect(res.status).toBe(200);
    expect(state.calls.beltHistoryInserts).toHaveLength(0);
    expect(state.calls.studentBeltUpdates).toHaveLength(0);
    expect(res.body.results[0].student_belt_updated).toBe(false);
    expect(res.body.summary.failed).toBe(1);
  });
});

// ============================================================
// 4) IDEMPOTÊNCIA
// ============================================================
describe('F8.1 — relançar o mesmo exame não duplica graduação', () => {
  test('1ª trava: a linha de resultado já carrega belt_history_id → REUSA', async () => {
    state.existingHistoryByStudent[STUDENT_FED] = 'history-original';

    const res = await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' },
    ]);

    expect(res.status).toBe(200);
    expect(state.calls.beltHistoryInserts).toHaveLength(0);
    expect(res.body.results[0].belt_history).toBe('reused');
    expect(res.body.results[0].belt_history_id).toBe('history-original');
    expect(res.body.summary.belt_history_created).toBe(0);
    expect(res.body.summary.belt_history_reused).toBe(1);
  });

  test('2ª trava: sem belt_history_id na linha, mas existe GÊMEO pela chave natural → REUSA', async () => {
    state.twinHistoryId = 'history-gemeo';

    const res = await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' },
    ]);

    expect(res.status).toBe(200);
    expect(state.calls.beltHistoryInserts).toHaveLength(0);
    expect(res.body.results[0].belt_history).toBe('reused');
    expect(res.body.results[0].belt_history_id).toBe('history-gemeo');
  });

  test('o UPSERT do resultado usa a UNIQUE (exam_id, student_id) — nunca um segundo INSERT', async () => {
    await postResults([{ student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' }]);
    expect(state.calls.upserts).toHaveLength(1);
    expect(state.calls.upserts[0].sql).toMatch(/ON CONFLICT \(exam_id, student_id\) DO UPDATE/i);
  });

  test('o mesmo aluno duas vezes no MESMO corpo é recusado antes de qualquer escrita', async () => {
    const res = await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' },
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'roxo' },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].code).toBe('ALUNO_DUPLICADO');
    expect(db.connect).not.toHaveBeenCalled();
  });
});

// ============================================================
// 5) A ESCOLHA DO CERTIFICADO
// ============================================================
describe('F8.1 — certificado sai só para quem o sensei marcou', () => {
  test('só o aluno marcado vira pedido de certificado', async () => {
    const OUTRO_FED = '88888888-8888-4888-8888-888888888888';
    const OUTRO_PRACT = '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a';
    state.students[OUTRO_FED] = {
      id: OUTRO_FED,
      full_name: 'Outro Federado',
      practitioner_id: OUTRO_PRACT,
      belt_label: 'Verde',
      belt_order: 4,
      status: 'active',
    };

    const res = await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro', request_certificate: true },
      { student_id: OUTRO_FED, result: 'approved', to_belt_level: 'azul_claro' },
    ]);

    expect(res.status).toBe(200);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder.mock.calls[0][0]).toMatchObject({
      practitionerId: PRACTITIONER,
      dojoId: DOJO_ID,
      federationId: FED_ID,
      beltLevel: 'azul_claro',
      beltName: 'Azul Claro',
      examDate: '2026-07-15',
    });

    const marcado = res.body.results.find((r) => r.student_id === STUDENT_FED);
    const naoMarcado = res.body.results.find((r) => r.student_id === OUTRO_FED);
    expect(marcado.certificate).toMatchObject({ requested: true, created: true, order_id: 'order-' + PRACTITIONER });
    // Quem não foi marcado fica só com a graduação — e continua na fila de
    // aptos (derivada de "graduação sem pedido ativo"), pedível depois.
    expect(naoMarcado.certificate).toMatchObject({ requested: false, created: false, order_id: null });
    expect(res.body.summary.certificates_created).toBe(1);
  });

  test('aluno NÃO FEDERADO que pediu certificado recebe o motivo, não um erro genérico', async () => {
    const res = await postResults([
      { student_id: STUDENT_LOCAL, result: 'approved', to_belt_level: 'laranja', request_certificate: true },
    ]);

    expect(res.status).toBe(200);
    expect(createOrder).not.toHaveBeenCalled();
    expect(res.body.results[0].certificate).toMatchObject({
      requested: true,
      created: false,
      reason: 'ALUNO_NAO_FEDERADO',
    });
    expect(res.body.results[0].certificate.message).toMatch(/federe/i);
  });

  test('pedido duplicado vira motivo por aluno — a graduação NÃO cai junto', async () => {
    const dup = new Error('duplicado');
    dup.code = 'DUPLICATE_ORDER';
    createOrder.mockRejectedValue(dup);

    const res = await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro', request_certificate: true },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.results[0].belt_history).toBe('created'); // a graduação ficou
    expect(res.body.results[0].certificate).toMatchObject({ created: false, reason: 'JA_SOLICITADO' });
  });

  test('dojô NÃO conectado: graduação acontece, certificado volta com motivo (nunca 409)', async () => {
    isDojoLinked.mockResolvedValue(false);

    const res = await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro', request_certificate: true },
    ]);

    expect(res.status).toBe(200);
    expect(createOrder).not.toHaveBeenCalled();
    expect(res.body.results[0].belt_history).toBe('created');
    expect(res.body.results[0].certificate.reason).toBe('DOJO_NAO_CONECTADO');
  });

  test('REPROVADO nunca pede certificado, mesmo que o corpo mande true', async () => {
    const res = await postResults([
      { student_id: STUDENT_FED, result: 'failed', to_belt_level: 'azul_claro', request_certificate: true },
    ]);

    expect(res.status).toBe(200);
    expect(createOrder).not.toHaveBeenCalled();
    expect(res.body.results[0].certificate.requested).toBe(false);
  });
});

// ============================================================
// 6) ANEXO DO ENVIO À FEDERAÇÃO
// ============================================================
describe('F8.1 — anexo (ficha de exame / comprovante)', () => {
  function postAttachment(body) {
    return request(buildApp())
      .post(`/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}/attachments`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send(body);
  }

  test('PDF é ACEITO e vai para karate_documents com owner_type=dojo_belt_exam', async () => {
    const res = await postAttachment({
      filename: 'ficha-exame-julho.pdf',
      content_type: 'application/pdf',
      content: Buffer.from('%PDF-1.4 ficha').toString('base64'),
      note: 'Ficha assinada pelo sensei',
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    expect(r2.uploadToR2).toHaveBeenCalledTimes(1);
    expect(state.calls.attachmentInserts).toHaveLength(1);
    // O anexo é do LOTE: o dono é o EXAME, não um aluno.
    expect(state.calls.attachmentInserts[0][1]).toBe('dojo_belt_exam');
    expect(state.calls.attachmentInserts[0][2]).toBe(EXAM_ID);
    // federation_id SEMPRE do token.
    expect(state.calls.attachmentInserts[0][0]).toBe(FED_ID);
  });

  test('vários arquivos num envio só', async () => {
    const res = await postAttachment({
      files: [
        { filename: 'ficha.pdf', content_type: 'application/pdf', content: 'AAAA' },
        { filename: 'comprovante.jpg', content_type: 'image/jpeg', content: 'BBBB' },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(2);
    expect(state.calls.attachmentInserts).toHaveLength(2);
  });

  test('tipo NÃO permitido é recusado e NADA sobe para o R2', async () => {
    const res = await postAttachment({
      filename: 'malicioso.exe',
      content_type: 'application/x-msdownload',
      content: 'AAAA',
    });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TIPO_NAO_PERMITIDO');
    expect(r2.uploadToR2).not.toHaveBeenCalled();
    expect(state.calls.attachmentInserts).toHaveLength(0);
  });

  test('content_type ausente é recusado', async () => {
    const res = await postAttachment({ filename: 'x.pdf', content: 'AAAA' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CONTENT_TYPE_OBRIGATORIO');
  });

  test('arquivo acima do teto é recusado com 413 (regra verificada na função pura)', () => {
    const { MAX_BASE64_LENGTH } = examRouter.__attachmentLimits;
    const grande = examRouter.__validateFile(
      { filename: 'gigante.pdf', content_type: 'application/pdf', content: 'a'.repeat(MAX_BASE64_LENGTH + 1) },
      0
    );
    expect(grande).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });

    // E o limite adotado é o MESMO de karateDocuments.js (~5MB binário).
    expect(MAX_BASE64_LENGTH).toBe(7 * 1024 * 1024);

    const noLimite = examRouter.__validateFile(
      { filename: 'ok.pdf', content_type: 'application/pdf', content: 'a'.repeat(1024) },
      0
    );
    expect(noLimite.ok).toBe(true);
  });

  test('teto de anexos por exame é respeitado', async () => {
    state.attachmentCount = examRouter.__attachmentLimits.MAX_FILES_PER_EXAM;
    const res = await postAttachment({ filename: 'mais-um.pdf', content_type: 'application/pdf', content: 'AAAA' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LIMITE_DE_ANEXOS');
    expect(r2.uploadToR2).not.toHaveBeenCalled();
  });

  test('exame CANCELADO não aceita anexo', async () => {
    state.exam.status = 'cancelled';
    const res = await postAttachment({ filename: 'x.pdf', content_type: 'application/pdf', content: 'AAAA' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXAME_CANCELADO');
  });

  test('exame CONCLUÍDO ainda aceita anexo (a ficha assinada é digitalizada depois)', async () => {
    state.exam.status = 'completed';
    const res = await postAttachment({ filename: 'ficha.pdf', content_type: 'application/pdf', content: 'AAAA' });
    expect(res.status).toBe(201);
  });
});

// ============================================================
// 7) CANAL B — O PORTAL É SOMENTE LEITURA
// ============================================================
describe('F8.1 — Canal B (portal do dojô) é read-only', () => {
  const writes = [
    ['post', `/federation/${FED_ID}/dojo/graduation-exams`, { exam_date: '2026-07-15' }],
    ['patch', `/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}`, { title: 'novo' }],
    ['post', `/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}/cancel`, {}],
    [
      'post',
      `/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}/results`,
      { results: [{ student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' }] },
    ],
    [
      'post',
      `/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}/attachments`,
      { filename: 'x.pdf', content_type: 'application/pdf', content: 'AAAA' },
    ],
    ['delete', `/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}/attachments/${DOC_ID}`, {}],
  ];

  test.each(writes)('%s %s → 403 PORTAL_READ_ONLY', async (method, path, body) => {
    const res = await request(buildApp())[method](path).set('Authorization', 'Bearer ' + tokenB).send(body);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    // O 403 é decidido ANTES de qualquer db.query: não depende de estado.
    expect(db.connect).not.toHaveBeenCalled();
    expect(r2.uploadToR2).not.toHaveBeenCalled();
  });

  test('Canal B LÊ normalmente (escada e lista de exames)', async () => {
    const ladder = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/belt-ladder`)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(ladder.status).toBe(200);

    const list = await request(buildApp())
      .get(`/federation/${FED_ID}/dojo/graduation-exams`)
      .set('Authorization', 'Bearer ' + tokenB);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data)).toBe(true);
  });

  test('sem token → 401 (não 403): não é permissão que falta, é sessão', async () => {
    const res = await request(buildApp()).get(`/federation/${FED_ID}/dojo/graduation-exams`);
    expect(res.status).toBe(401);
  });
});

// ============================================================
// 8) CICLO DO EXAME
// ============================================================
describe('F8.1 — ciclo do exame', () => {
  test('criar exige exam_date válida', async () => {
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/graduation-exams`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ title: 'sem data' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('editar exame CONCLUÍDO é 409 (estado, não corpo)', async () => {
    state.exam.status = 'completed';
    const res = await request(buildApp())
      .patch(`/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({ title: 'tentando editar' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXAME_NAO_EDITAVEL');
  });

  test('exame CANCELADO não aceita lançamento de resultado', async () => {
    state.exam.status = 'cancelled';
    const res = await postResults([{ student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' }]);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXAME_CANCELADO');
  });

  test('cancelar exame já CONCLUÍDO é 409 — cancelar não desfaz graduação', async () => {
    state.exam.status = 'completed';
    const res = await request(buildApp())
      .post(`/federation/${FED_ID}/dojo/graduation-exams/${EXAM_ID}/cancel`)
      .set('Authorization', 'Bearer ' + tokenA)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('EXAME_CONCLUIDO');
  });

  test('exame de outro dojô é 404 (escopo sempre pelo token)', async () => {
    state.exam.dojo_id = 'outro-dojo';
    const res = await postResults([{ student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' }]);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('EXAME_NAO_ENCONTRADO');
  });
});

// ============================================================
// 9) DEGRADAÇÃO — migration pendente não pode inventar coluna
// ============================================================
describe('F8.1 — deploy à frente do banco', () => {
  test('sem as colunas da 262/264, o INSERT do histórico sai sem source/belt_kyu e a resposta avisa', async () => {
    state.hasBeltHistoryOptionalCols = false;
    state.hasResultCertCols = false;

    const res = await postResults([
      { student_id: STUDENT_FED, result: 'approved', to_belt_level: 'azul_claro' },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.schema_degraded).toBe(true);

    const ins = state.calls.beltHistoryInserts[0];
    const cols = ins.sql.slice(ins.sql.indexOf('('), ins.sql.indexOf('VALUES'));
    expect(cols).not.toMatch(/\bsource\b/);
    expect(cols).not.toMatch(/\bbelt_kyu\b/);
    expect(ins.params).not.toContain('exam_dojo');

    // E o UPSERT do resultado não cita certificate_requested.
    expect(state.calls.upserts[0].sql).not.toMatch(/certificate_requested/);
  });
});
