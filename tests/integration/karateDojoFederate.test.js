// ============================================================
// AURA DOJÔ — Testes Integração: F5a aluno FEDERADO
// (karate_dojo_students.is_federated + practitioner_id;
//  karate_practitioner_requests.student_id — migration 253)
//
// MODELO: o SENSEI declara que o aluno é federado; a FEDERAÇÃO confirma.
//   caminho 1 — o aluno JÁ tem número FPKT → lookup confirma e vincula
//   caminho 2 — o aluno é NOVO → abre a solicitação H1 (com student_id) e
//                a aprovação devolve o practitioner_id ao aluno
//
// ⚠️ MOCK POR SQL (mockImplementation), NUNCA fila posicional de
// mockResolvedValueOnce: query nova entrando na frente (foi o que o helper
// karateDojoLinkStatus fez no PR #422) desalinha a fila inteira e derruba
// o CI. Mock genérico {rows: []} também não serve: os handlers leem
// rows[0] direto.
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
const outroDojoId = 'd0000000-0000-0000-0000-000000000003';
const sid = 'a1000000-0000-0000-0000-00000000000a';
const reqId = 'r1000000-0000-0000-0000-00000000000b';
const dojoBase = `/api/v1/federation/${fedId}/dojo`;
const fedBase = `/api/v1/federation/${fedId}`;
const LINKED_AT = new Date('2026-07-01T12:00:00Z');

// Canal A: JWT de acesso do Aura Dojô (dojo_id no token)
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

// Federação: role 'admin' de plataforma passa em requireCompanyAccess SEM
// SELECT de papel — as únicas db.query são as do handler.
const adminHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'staff1', role: 'admin' }, SECRET, { expiresIn: '1h' })}`,
});

const sqls = () => db.query.mock.calls.map((c) => String(c[0]));
const hitSql = (re) => sqls().some((s) => re.test(s));
const findCall = (re) => db.query.mock.calls.find((c) => re.test(String(c[0])));

// Query do helper karateDojoLinkStatus (a única que menciona a coluna).
const isLinkQuery = (s) => /SELECT\s+karate_dojo_linked_at/i.test(s);
// Ficha do aluno lida pelos fluxos de federação (loadStudentOrThrow).
const isStudentLoad = (s) =>
  /FROM karate_dojo_students/.test(s) && /WHERE id = \$1 AND dojo_id = \$2/.test(s);
// "Este praticante já pertence a outro aluno deste dojô?"
const isClaimCheck = (s) =>
  /FROM karate_dojo_students/.test(s) && /practitioner_id = \$2/.test(s);
// lookupByFpktNumber (karatePractitionerDedup)
const isFpktLookup = (s) => /karate_registration_number = \$2/.test(s);
// Solicitação H1 pendente DESTE aluno
const isPendingByStudent = (s) =>
  /FROM karate_practitioner_requests/.test(s) && /student_id = \$2/.test(s);

const studentRow = (over = {}) => ({
  id: sid,
  full_name: 'Aluno Teste',
  birth_date: '1995-04-12',
  cpf: '52998224725',
  sex: 'M',
  phone: '91999990000',
  email: 'aluno@exemplo.com',
  photo_url: null,
  belt_label: 'Branca',
  belt_order: 1,
  status: 'active',
  guardian_id: null,
  consent_lgpd: false,
  notes: null,
  practitioner_id: null,
  enrolled_at: '2026-07-01',
  created_at: '2026-07-19T00:00:00Z',
  updated_at: '2026-07-19T00:00:00Z',
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

// Client de transação despachando por SQL (mesma filosofia do db.query).
function mockTx(dispatch) {
  const client = {
    query: jest.fn((sql) => Promise.resolve(dispatch(String(sql)) || { rows: [] })),
    release: jest.fn(),
  };
  db.connect.mockImplementation(() => client);
  return client;
}

const txSqls = (client) => client.query.mock.calls.map((c) => String(c[0]));

afterEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
});

// ============================================================
// CAMINHO 1 — o aluno JÁ tem número FPKT
// ============================================================
describe('F5a — federar informando o número FPKT', () => {
  test('sem token → 401', async () => {
    const res = await request(app).post(`${dojoBase}/students/${sid}/federate`).send({ fpkt_number: 'FPKT-123' });
    expect(res.status).toBe(401);
  });

  test('número existente em OUTRO dojô → vincula e avisa que é transferência', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (/UPDATE karate_dojo_students/.test(s)) return { rows: [{ id: sid }] };
      if (isClaimCheck(s)) return { rows: [] };
      if (isStudentLoad(s)) return { rows: [studentRow()] };
      if (isFpktLookup(s)) {
        return {
          rows: [{
            id: 'p1',
            name: 'João Praticante',
            dojo_id: outroDojoId,
            dojo_name: 'Dojô Vizinho',
            is_active: true,
          }],
        };
      }
      return null;
    });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: '  FPKT-123 ' });

    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(res.body.federated).toBe(true);
    expect(res.body.federation_link_status).toBe('linked');
    expect(res.body.is_transfer).toBe(true); // está hoje em outro dojô
    expect(res.body.practitioner).toMatchObject({
      id: 'p1',
      name: 'João Praticante',
      fpkt_number: 'FPKT-123', // normalizado (trim)
    });

    // O vínculo gravado: practitioner_id + declaração, escopado pelo TOKEN
    const upd = findCall(/UPDATE karate_dojo_students/);
    expect(String(upd[0])).toContain('is_federated = true');
    expect(upd[1]).toEqual(['p1', sid, dojoId]);
  });

  test('número do PRÓPRIO dojô → vincula, mas is_transfer:false', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (/UPDATE karate_dojo_students/.test(s)) return { rows: [{ id: sid }] };
      if (isClaimCheck(s)) return { rows: [] };
      if (isStudentLoad(s)) return { rows: [studentRow()] };
      if (isFpktLookup(s)) {
        return { rows: [{ id: 'p1', name: 'João Praticante', dojo_id: dojoId, dojo_name: 'Meu Dojô', is_active: true }] };
      }
      return null;
    });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-123' });

    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(res.body.is_transfer).toBe(false);
  });

  test('número inexistente → 404 FPKT_NUMBER_NOT_FOUND, nada gravado', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isStudentLoad(s)) return { rows: [studentRow()] };
      return null; // lookup cai no default {rows: []} → found:false
    });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-INEXISTENTE' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('FPKT_NUMBER_NOT_FOUND');
    expect(hitSql(/UPDATE karate_dojo_students/)).toBe(false);
  });

  test('número já vinculado a OUTRO aluno do mesmo dojô → 409 PRACTITIONER_JA_VINCULADO', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isClaimCheck(s)) return { rows: [{ id: 'outro-aluno', full_name: 'Maria Aluna' }] };
      if (isStudentLoad(s)) return { rows: [studentRow()] };
      if (isFpktLookup(s)) {
        return { rows: [{ id: 'p1', name: 'João Praticante', dojo_id: dojoId, dojo_name: 'Meu Dojô', is_active: true }] };
      }
      return null;
    });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-123' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRACTITIONER_JA_VINCULADO');
    expect(res.body.error).toMatch(/Maria Aluna/);
    expect(hitSql(/UPDATE karate_dojo_students/)).toBe(false);
  });

  test('aluno de outro dojô → 404 (query escopada por req.dojoId)', async () => {
    mockDojo(LINKED_AT); // student load cai no default {rows: []}

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-123' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    const load = findCall(isStudentLoad);
    expect(load[1]).toEqual([sid, dojoId]);
  });

  test('sem fpkt_number e sem request:true → 422 (nada gravado)', async () => {
    mockDojo(LINKED_AT);
    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(hitSql(/UPDATE karate_dojo_students/)).toBe(false);
    expect(hitSql(/INSERT INTO karate_practitioner_requests/)).toBe(false);
  });
});

// ============================================================
// CAMINHO 2 — o aluno é NOVO na federação (solicitação H1)
// ============================================================
describe('F5a — federar aluno novo (abre a solicitação H1 que já existia)', () => {
  // O que o aluno NÃO tem no cadastro do dojô (rg + endereço) vem do corpo;
  // nome/nascimento/cpf/telefone/e-mail/sexo/faixa vêm do PRÓPRIO aluno.
  const complementoDaFicha = () => ({
    request: true,
    rg: '1234567',
    zip_code: '66000-000',
    street: 'Rua das Palmeiras',
    number: '100',
    neighborhood: 'Centro',
    city: 'Belém',
    state: 'PA',
  });

  test('cria a solicitação com student_id e o aluno fica pending', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isPendingByStudent(s)) return { rows: [] };
      if (isStudentLoad(s)) return { rows: [studentRow()] };
      if (/INSERT INTO karate_practitioner_requests/.test(s)) {
        return { rows: [{ id: reqId, status: 'pendente', created_at: '2026-07-26T10:00:00Z' }] };
      }
      return null;
    });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send(complementoDaFicha());

    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    expect(res.body.federated).toBe(false);
    expect(res.body.request_id).toBe(reqId);
    expect(res.body.status).toBe('pending');
    expect(res.body.federation_link_status).toBe('pending');
    expect(res.body.already_pending).toBe(false);

    const insert = findCall(/INSERT INTO karate_practitioner_requests/);
    // O fio de volta: student_id na SQL e o id do aluno no ÚLTIMO parâmetro
    expect(String(insert[0])).toContain('student_id');
    expect(insert[1][insert[1].length - 1]).toBe(sid);
    // Escopo do TOKEN, nunca do body
    expect(insert[1][0]).toBe(fedId);
    expect(insert[1][1]).toBe(dojoId);
    // Ficha pré-preenchida com os dados do ALUNO (não vieram no corpo)
    expect(insert[1][2]).toBe('Aluno Teste');
    expect(insert[1][3]).toBe('1995-04-12');

    // Pendente é pendente: NADA de marcar vínculo antes da federação aprovar
    expect(hitSql(/UPDATE karate_dojo_students/)).toBe(false);
  });

  test('pedir de novo → idempotente: devolve a mesma solicitação, sem INSERT', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isPendingByStudent(s)) {
        return { rows: [{ id: reqId, status: 'pendente', created_at: '2026-07-26T10:00:00Z' }] };
      }
      if (isStudentLoad(s)) return { rows: [studentRow()] };
      return null;
    });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send(complementoDaFicha());

    expect(res.status).toBe(200);
    expect(res.body.request_id).toBe(reqId);
    expect(res.body.status).toBe('pending');
    expect(res.body.already_pending).toBe(true);
    expect(hitSql(/INSERT INTO karate_practitioner_requests/)).toBe(false);
  });

  test('aluno JÁ vinculado → 409 JA_FEDERADO (não abre solicitação duplicada)', async () => {
    mockDojo(LINKED_AT, (s) => {
      if (isStudentLoad(s)) return { rows: [studentRow({ practitioner_id: 'p1' })] };
      return null;
    });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send(complementoDaFicha());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JA_FEDERADO');
    expect(hitSql(/INSERT INTO karate_practitioner_requests/)).toBe(false);
  });
});

// ============================================================
// GATE DE CONEXÃO + CANAL
// ============================================================
describe('F5a — gate de conexão e canal', () => {
  test('dojô NÃO conectado → 409 DOJO_NAO_CONECTADO, nada gravado', async () => {
    mockDojo(null, (s) => (isStudentLoad(s) ? { rows: [studentRow()] } : null));

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-123' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOJO_NAO_CONECTADO');
    expect(hitSql(/UPDATE karate_dojo_students/)).toBe(false);
    expect(hitSql(/INSERT INTO karate_practitioner_requests/)).toBe(false);
    // Gate ANTES de qualquer leitura de aluno/federação
    expect(hitSql(/karate_registration_number = \$2/)).toBe(false);
  });

  test('Canal B (portal) → 403 PORTAL_READ_ONLY sem tocar o banco', async () => {
    mockDojo(LINKED_AT);
    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalB())
      .send({ fpkt_number: 'FPKT-123' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ============================================================
// DESFEDERAR
// ============================================================
describe('F5a — DELETE /federate desvincula sem tocar no cadastro da federação', () => {
  test('desvincula (is_federated=false, practitioner_id=NULL) e NÃO escreve em karate_practitioners/customers', async () => {
    mockDojo(LINKED_AT, (s) => (/UPDATE karate_dojo_students/.test(s) ? { rows: [{ id: sid }] } : null));

    const res = await request(app).delete(`${dojoBase}/students/${sid}/federate`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.unlinked).toBe(true);
    expect(res.body.federated).toBe(false);
    expect(res.body.practitioner_id).toBeNull();
    expect(res.body.federation_link_status).toBe('none');

    const upd = findCall(/UPDATE karate_dojo_students/);
    expect(String(upd[0])).toContain('is_federated = false');
    expect(upd[1]).toEqual([null, sid, dojoId]);

    // A ASSERÇÃO QUE IMPORTA: o praticante continua existindo na federação.
    expect(hitSql(/DELETE FROM customers/i)).toBe(false);
    expect(hitSql(/UPDATE customers/i)).toBe(false);
    expect(hitSql(/karate_practitioners/i)).toBe(false);
  });

  test('aluno de outro dojô → 404', async () => {
    mockDojo(LINKED_AT); // UPDATE cai no default {rows: []}
    const res = await request(app).delete(`${dojoBase}/students/${sid}/federate`).set(canalA());
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

// ============================================================
// FILTRO ?federated=
// ============================================================
describe('F5a — GET /students?federated=', () => {
  const isListQuery = (s) => /FROM karate_dojo_students s/.test(s) && /ORDER BY s\.full_name/.test(s);

  test('federated=true entra na SQL e no parâmetro', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
    const res = await request(app).get(`${dojoBase}/students?federated=true`).set(canalA());

    expect(res.status).toBe(200);
    const call = findCall(isListQuery);
    expect(String(call[0])).toContain('s.is_federated = $5');
    expect(call[1][0]).toBe(dojoId);
    expect(call[1][4]).toBe(true);
  });

  test('federated=false filtra os NÃO federados', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
    await request(app).get(`${dojoBase}/students?federated=false`).set(canalA());
    expect(findCall(isListQuery)[1][4]).toBe(false);
  });

  test('sem o parâmetro → TODOS (filtro neutro, null)', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
    await request(app).get(`${dojoBase}/students?status=active`).set(canalA());
    const call = findCall(isListQuery);
    expect(call[1][1]).toBe('active'); // filtro antigo intacto
    expect(call[1][4]).toBeNull();
  });
});

// ============================================================
// LADO FEDERAÇÃO — aprovar devolve o praticante ao aluno
// ============================================================
describe('F5a — approve-create fecha o ciclo no aluno do dojô', () => {
  const requestRow = (over = {}) => ({
    id: reqId,
    federation_id: fedId,
    dojo_id: dojoId,
    status: 'pendente',
    full_name: 'Aluno Teste',
    birth_date: null,
    cpf: null,
    rg: null,
    phone: null,
    email: null,
    claimed_belt: null, // sem faixa alegada: não semeia karate_belt_history
    payload: {},
    photo_url: null,
    student_id: sid,
    ...over,
  });

  test('solicitação vinda de um aluno → practitioner_id volta para o aluno na MESMA transação', async () => {
    const client = mockTx((s) => {
      if (/FROM karate_practitioner_requests/.test(s) && /FOR UPDATE/.test(s)) {
        return { rows: [requestRow()] };
      }
      if (/SELECT id FROM customers/.test(s)) return { rows: [] }; // número livre
      if (/INSERT INTO customers/.test(s)) {
        return { rows: [{ id: 'p9', name: 'Aluno Teste', karate_registration_number: 'FPKT-999', dojo_id: dojoId }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${fedBase}/practitioner-requests/${reqId}/approve-create`)
      .set(adminHeader())
      .send({ fpkt_number: 'FPKT-999' });

    expect(res.status).toBe(201);
    expect(res.body.student_id).toBe(sid);
    expect(res.body.student_linked).toBe(true);
    expect(res.body.practitioner.id).toBe('p9');

    const upd = client.query.mock.calls.find((c) => /UPDATE karate_dojo_students/.test(String(c[0])));
    expect(upd).toBeDefined();
    expect(String(upd[0])).toContain('is_federated = true');
    expect(upd[1]).toEqual(['p9', sid, dojoId]);

    const all = txSqls(client);
    expect(all).toContain('BEGIN');
    expect(all).toContain('COMMIT');
    expect(all).not.toContain('ROLLBACK');
    // Best-effort protegido por SAVEPOINT — nunca try/catch nu no BEGIN
    expect(all).toContain('SAVEPOINT sp_link_dojo_student');
  });

  test('solicitação avulsa (student_id NULL) → nenhum UPDATE em aluno', async () => {
    const client = mockTx((s) => {
      if (/FROM karate_practitioner_requests/.test(s) && /FOR UPDATE/.test(s)) {
        return { rows: [requestRow({ student_id: null })] };
      }
      if (/SELECT id FROM customers/.test(s)) return { rows: [] };
      if (/INSERT INTO customers/.test(s)) {
        return { rows: [{ id: 'p9', name: 'Aluno Teste', karate_registration_number: 'FPKT-999', dojo_id: dojoId }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${fedBase}/practitioner-requests/${reqId}/approve-create`)
      .set(adminHeader())
      .send({ fpkt_number: 'FPKT-999' });

    expect(res.status).toBe(201);
    expect(res.body.student_id).toBeNull();
    expect(res.body.student_linked).toBe(false);
    expect(txSqls(client).some((s) => /UPDATE karate_dojo_students/.test(s))).toBe(false);
  });
});
