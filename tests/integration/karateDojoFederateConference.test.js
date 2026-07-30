// ============================================================
// AURA DOJÔ — Testes Integração F7.1: CONFERIR ANTES DE FEDERAR
//
// O caso real (produção, 30/07/2026): uma aluna de 12 anos, CPF 123...,
// nascimento 1998 no cadastro do dojô, foi vinculada a um praticante
// nascido em 2020 com CPF diferente — aceito sem um aviso. Este arquivo
// existe para que isso não passe de novo.
//
// O que cada bloco trava:
//   1. PREVIEW não grava (nem uma query de escrita, nem uma transação)
//   2. CPF conflitante bloqueia — e não existe "confirmar mesmo assim"
//   3. praticante já vinculado em OUTRO dojô agora bloqueia (antes passava)
//   4. confirmação aplica a resolução nos DOIS lados e ADOTA a ficha
//   5. trilha: sem a 263, o rastro cai em karate_dojo_roster_events
//   6. degradação sem a 262: preview funciona, confirmação recusa limpo
//   7. desvincular devolve a gestão à federação
//
// ⚠️ MOCK POR SQL (mockImplementation + regex), NUNCA fila posicional.
// ⚠️ identityLink._resetSchemaCache() em afterEach: a sonda de schema tem
//    cache module-level e sem o reset o primeiro caso decidiria o schema
//    de todos os outros.
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, identityLink;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  identityLink = require('../../src/services/karateStudentIdentityLink');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const outroDojoId = 'd0000000-0000-0000-0000-000000000003';
const sid = 'a1000000-0000-0000-0000-00000000000a';
const pid = 'c1000000-0000-0000-0000-00000000000c';
const dojoBase = `/api/v1/federation/${fedId}/dojo`;
const LINKED_AT = new Date('2026-07-01T12:00:00Z');

const canalA = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'sensei@dojo.com.br', type: 'access', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

const matches = (m, s) => (typeof m === 'function' ? Boolean(m(s)) : m.test(s));
const sqls = () => db.query.mock.calls.map((c) => String(c[0]));
const hitSql = (m) => sqls().some((s) => matches(m, s));
const findCall = (m) => db.query.mock.calls.find((c) => matches(m, String(c[0])));

const isLinkQuery = (s) => /SELECT\s+karate_dojo_linked_at/i.test(s);
const isSchemaProbe = (s) => /information_schema/.test(s);
const isStudentLoad = (s) =>
  /FROM karate_dojo_students/.test(s) && /WHERE s\.id = \$1 AND s\.dojo_id = \$2/.test(s);
const isFpktLookup = (s) => /karate_registration_number = \$2/.test(s);
const isClaimCheck = (s) =>
  /FROM karate_dojo_students/.test(s) && /practitioner_id = \$1/.test(s);

let SCHEMA = null;
const schemaRow = (over = {}) => ({
  has_customer_identity: true,
  has_student_identity: true,
  has_is_federated: true,
  has_identity_audit: true,
  ...over,
});

// ── A ALUNA DE 12 ANOS ──────────────────────────────────────
const aluna = (over = {}) => ({
  id: sid,
  dojo_id: dojoId,
  practitioner_id: null,
  full_name: 'Ana Beatriz Souza',
  birth_date: '1998-03-10',
  cpf: '12345678909',
  rg: null,
  sex: 'F',
  phone: '91988887777',
  email: 'ana@exemplo.com',
  zip_code: null,
  street: null,
  number: null,
  complement: null,
  neighborhood: null,
  city: null,
  state: null,
  photo_url: null,
  ...over,
});

// ── O PRATICANTE DE 2020 (pessoa DIFERENTE) ─────────────────
const praticante = (over = {}) => ({
  id: pid,
  karate_registration_number: 'FPKT-4321',
  dojo_id: outroDojoId,
  dojo_name: 'Dojô Vizinho',
  is_active: true,
  full_name: 'Ana B. Souza',
  birth_date: '2020-07-02',
  cpf: '98765432100',
  rg: '1234567',
  sex: 'feminino',
  phone: null,
  email: null,
  zip_code: null,
  street: null,
  number: null,
  complement: null,
  neighborhood: null,
  city: null,
  state: null,
  photo_url: null,
  karate_identity_managed_by: 'federation',
  karate_identity_dojo_id: null,
  ...over,
});

function mockRead({ student = aluna(), practitioner = praticante(), claim = null, linkedAt = LINKED_AT } = {}) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (isLinkQuery(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: linkedAt }] });
    if (isSchemaProbe(s)) return Promise.resolve({ rows: [SCHEMA || schemaRow()] });
    if (isClaimCheck(s)) return Promise.resolve({ rows: claim ? [claim] : [] });
    if (isStudentLoad(s)) return Promise.resolve({ rows: student ? [student] : [] });
    if (isFpktLookup(s)) return Promise.resolve({ rows: practitioner ? [practitioner] : [] });
    return Promise.resolve({ rows: [] });
  });
}

function mockTx(dispatch) {
  const client = {
    query: jest.fn((sql) => Promise.resolve(dispatch(String(sql)) || { rows: [] })),
    release: jest.fn(),
  };
  db.connect.mockImplementation(() => client);
  return client;
}

const txSqls = (client) => client.query.mock.calls.map((c) => String(c[0]));
const txFind = (client, m) => client.query.mock.calls.find((c) => matches(m, String(c[0])));
const txHit = (client, m) => txSqls(client).some((s) => matches(m, s));

function mockConfirmTx({ student = aluna(), practitioner = praticante(), claim = null, auditFails = false } = {}) {
  return mockTx((s) => {
    if (isClaimCheck(s)) return { rows: claim ? [claim] : [] };
    if (isStudentLoad(s)) return { rows: [student] };
    if (isFpktLookup(s)) return { rows: [practitioner] };
    if (/UPDATE karate_dojo_students/.test(s)) return { rows: [{ id: sid }] };
    if (/UPDATE customers/.test(s)) {
      return { rows: [{ id: practitioner.id, name: practitioner.full_name, karate_registration_number: practitioner.karate_registration_number }] };
    }
    if (auditFails && /INSERT INTO karate_identity_audit/.test(s)) {
      const e = new Error('relation "karate_identity_audit" does not exist');
      e.code = '42P01';
      throw e;
    }
    return { rows: [] };
  });
}

const field = (body, key) => (body.comparison || []).find((c) => c.field === key);

afterEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  identityLink._resetSchemaCache();
  SCHEMA = null;
});

// ============================================================
// 1) PREVIEW NÃO GRAVA
// ============================================================
describe('F7.1 — preview (sem confirm) não grava nada', () => {
  test('devolve a comparação campo a campo e NENHUMA escrita acontece', async () => {
    mockRead({ practitioner: praticante({ cpf: null }) }); // sem CPF do outro lado: nada bloqueia

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321' });

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.linked).toBe(false);
    expect(res.body.can_link).toBe(true);
    expect(res.body.blockers).toEqual([]);
    expect(res.body.is_transfer).toBe(true);

    // A PROMESSA DESTE PR: preview não abre transação e não escreve.
    expect(db.connect).not.toHaveBeenCalled();
    expect(hitSql(/UPDATE karate_dojo_students/)).toBe(false);
    expect(hitSql(/UPDATE customers/)).toBe(false);
    expect(hitSql(/INSERT INTO/i)).toBe(false);
  });

  test('nascimento divergente NÃO bloqueia — vira divergência destacada', async () => {
    mockRead({ practitioner: praticante({ cpf: null }) });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321' });

    const birth = field(res.body, 'birth_date');
    expect(birth).toMatchObject({
      dojo_value: '1998-03-10',
      federation_value: '2020-07-02',
      diverges: true,
      suggested: 'dojo', // o dojô é a fonte da identidade
    });
    expect(res.body.can_link).toBe(true); // erro de digitação não pode travar
  });

  test('valor ausente de um lado NÃO é divergência (dado faltante é neutro)', async () => {
    mockRead({ practitioner: praticante({ cpf: null }) });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321' });

    // RG só a federação tem
    expect(field(res.body, 'rg')).toMatchObject({
      dojo_value: null,
      federation_value: '1234567',
      diverges: false,
      suggested: 'federation',
    });
    // Telefone só o dojô tem
    expect(field(res.body, 'phone')).toMatchObject({
      federation_value: null,
      diverges: false,
      suggested: 'dojo',
    });
    // Ninguém tem: aparece na lista, sem sugestão
    expect(field(res.body, 'city')).toMatchObject({
      dojo_value: null,
      federation_value: null,
      diverges: false,
      suggested: null,
    });
  });

  test('diferença só de acento/caixa/máscara NÃO é divergência', async () => {
    mockRead({
      student: aluna({ full_name: 'ana beatriz souza', cpf: '123.456.789-09', sex: 'F' }),
      practitioner: praticante({ full_name: 'Ana Beatriz Sóuza', cpf: '12345678909', sex: 'feminino' }),
    });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321' });

    expect(res.status).toBe(200);
    expect(field(res.body, 'full_name').diverges).toBe(false);
    expect(field(res.body, 'cpf').diverges).toBe(false);
    expect(field(res.body, 'sex').diverges).toBe(false);
    expect(res.body.can_link).toBe(true);
  });
});

// ============================================================
// 2) CPF CONFLITANTE BLOQUEIA
// ============================================================
describe('F7.1 — CPF conflitante bloqueia (sem override)', () => {
  test('preview: can_link false + blocker CPF_CONFLITANTE', async () => {
    mockRead(); // aluna 123..., praticante 987...

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321' });

    expect(res.status).toBe(200);
    expect(res.body.can_link).toBe(false);
    expect(res.body.blockers).toHaveLength(1);
    expect(res.body.blockers[0].code).toBe('CPF_CONFLITANTE');
    // A mensagem tem que dizer que NÃO existe confirmar mesmo assim.
    expect(res.body.blockers[0].message).toMatch(/pessoas diferentes/i);
    expect(res.body.blockers[0].message).toMatch(/não existe confirmar mesmo assim/i);
  });

  test('confirmar assim mesmo → 409 e NADA é gravado', async () => {
    mockRead();
    mockConfirmTx();

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321', confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CPF_CONFLITANTE');
    expect(res.body.blockers[0].field).toBe('cpf');
    // Recusa ANTES de abrir a transação
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('CPF só de um lado NÃO bloqueia (ausente é neutro)', async () => {
    mockRead({ practitioner: praticante({ cpf: null }) });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321' });

    expect(res.body.can_link).toBe(true);
    expect(field(res.body, 'cpf').suggested).toBe('dojo');
  });
});

// ============================================================
// 3) PRATICANTE JÁ VINCULADO — AGORA GLOBAL
// ============================================================
describe('F7.1 — praticante já vinculado a aluno de OUTRO dojô', () => {
  const claimDeOutroDojo = {
    id: 'outro-aluno',
    full_name: 'Ana Beatriz Souza',
    dojo_id: outroDojoId,
    dojo_name: 'Dojô Vizinho',
  };

  test('antes passava; agora bloqueia com o nome do outro dojô', async () => {
    mockRead({ practitioner: praticante({ cpf: null }), claim: claimDeOutroDojo });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321' });

    expect(res.status).toBe(200);
    expect(res.body.can_link).toBe(false);
    expect(res.body.blockers[0].code).toBe('PRATICANTE_JA_VINCULADO');
    expect(res.body.blockers[0].message).toMatch(/Dojô Vizinho/);
  });

  test('a checagem é GLOBAL: o parâmetro é o praticante, não o dojô', async () => {
    mockRead({ practitioner: praticante({ cpf: null }), claim: claimDeOutroDojo });

    await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321' });

    const call = findCall(isClaimCheck);
    expect(call).toBeDefined();
    // Antes era [dojoId, practitionerId, studentId] — o escopo do dojô era
    // exatamente o buraco. Agora é [practitionerId, studentId].
    expect(call[1]).toEqual([pid, sid]);
    expect(String(call[0])).not.toMatch(/dojo_id = \$/);
  });

  test('confirmar → 409 PRATICANTE_JA_VINCULADO antes de abrir transação', async () => {
    mockRead({ practitioner: praticante({ cpf: null }), claim: claimDeOutroDojo });
    mockConfirmTx();

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321', confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRATICANTE_JA_VINCULADO');
    expect(db.connect).not.toHaveBeenCalled();
  });
});

// ============================================================
// 4) CONFIRMAÇÃO: APLICA A RESOLUÇÃO E ADOTA
// ============================================================
describe('F7.1 — confirmação aplica a resolução nos dois lados e adota a ficha', () => {
  // Mesma pessoa (CPF igual), com nome divergente, RG só na federação e
  // nascimento divergente resolvido MANUALMENTE para o lado da federação.
  const alunaOk = () => aluna({ full_name: 'Ana Beatriz Souza', cpf: '12345678909' });
  const praticanteOk = () =>
    praticante({ full_name: 'Ana B. Souza', cpf: '12345678909', rg: '1234567', birth_date: '1998-03-11' });

  test('grava o vencedor de cada campo no lado que perdeu, adota e devolve applied[]', async () => {
    mockRead({ student: alunaOk(), practitioner: praticanteOk() });
    const client = mockConfirmTx({ student: alunaOk(), practitioner: praticanteOk() });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({
        fpkt_number: 'FPKT-4321',
        confirm: true,
        resolution: { birth_date: 'federation' }, // o resto usa o suggested
      });

    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(res.body.adopted).toBe(true);
    expect(res.body.identity_managed_by).toBe('dojo');

    const applied = res.body.applied.reduce((acc, a) => { acc[a.field] = a; return acc; }, {});
    // nome: os dois têm e divergem → o DOJÔ vence (fonte da identidade)
    expect(applied.full_name).toMatchObject({ from: 'dojo', value: 'Ana Beatriz Souza' });
    // RG: só a federação tem → desce para o dojô
    expect(applied.rg).toMatchObject({ from: 'federation', value: '1234567' });
    // nascimento: resolução manual venceu o suggested
    expect(applied.birth_date).toMatchObject({ from: 'federation', value: '1998-03-11' });

    // ── lado do DOJÔ ──
    const updStudent = txFind(client, /UPDATE karate_dojo_students/);
    expect(String(updStudent[0])).toMatch(/\brg = \$\d+/);
    expect(String(updStudent[0])).toMatch(/birth_date = \$\d+/);
    expect(updStudent[1][0]).toBe(pid); // practitioner_id sempre no $1
    expect(updStudent[1]).toContain('1234567');
    expect(updStudent[1]).toContain('1998-03-11');
    // o vínculo continua escopado pelo TOKEN
    expect(updStudent[1].slice(-2)).toEqual([sid, dojoId]);

    // ── lado da FEDERAÇÃO (adoção + nome vencedor) ──
    const updFed = txFind(client, /UPDATE customers/);
    expect(String(updFed[0])).toContain("karate_identity_managed_by = 'dojo'");
    expect(String(updFed[0])).toContain('karate_identity_dojo_id = $1');
    expect(String(updFed[0])).toMatch(/\bname = \$\d+/);
    expect(updFed[1][0]).toBe(dojoId);
    expect(updFed[1]).toContain('Ana Beatriz Souza');
    expect(updFed[1][updFed[1].length - 1]).toBe(pid);

    // ── tudo numa transação só ──
    const all = txSqls(client);
    expect(all).toContain('BEGIN');
    expect(all).toContain('COMMIT');
    expect(all).not.toContain('ROLLBACK');
    // e as travas são REAVALIADAS com lock dentro dela
    expect(all.some((s) => /FOR UPDATE/.test(s))).toBe(true);
  });

  test('sexo atravessa os dois vocabulários: dojô grava M/F, federação grava o canônico', async () => {
    const st = aluna({ cpf: '12345678909', sex: 'F' });
    const pr = praticante({ cpf: '12345678909', sex: null, full_name: 'Ana Beatriz Souza', birth_date: '1998-03-10', rg: null });
    mockRead({ student: st, practitioner: pr });
    const client = mockConfirmTx({ student: st, practitioner: pr });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321', confirm: true });

    expect(res.status).toBe(200);
    const updFed = txFind(client, /UPDATE customers/);
    // 'F' do dojô sobe como 'feminino' (canônico de customers.sex)
    expect(updFed[1]).toContain('feminino');
    expect(updFed[1]).not.toContain('F');
  });

  test('vencedor SEM valor nunca apaga o outro lado', async () => {
    // Federação não tem telefone; o sensei ainda assim pede "federation".
    const st = aluna({ cpf: '12345678909', phone: '91988887777' });
    const pr = praticante({ cpf: '12345678909', phone: null, full_name: 'Ana Beatriz Souza', birth_date: '1998-03-10', rg: null });
    mockRead({ student: st, practitioner: pr });
    const client = mockConfirmTx({ student: st, practitioner: pr });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321', confirm: true, resolution: { phone: 'federation' } });

    expect(res.status).toBe(200);
    expect((res.body.applied || []).some((a) => a.field === 'phone')).toBe(false);
    const updStudent = txFind(client, /UPDATE karate_dojo_students/);
    expect(String(updStudent[0])).not.toMatch(/\bphone = \$/);
  });

  test('resolution com valor inválido → 422, sem transação', async () => {
    mockRead({ student: alunaOk(), practitioner: praticanteOk() });
    mockConfirmTx();

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321', confirm: true, resolution: { full_name: 'sensei' } });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors[0]).toMatch(/resolution\.full_name/);
    expect(db.connect).not.toHaveBeenCalled();
  });
});

// ============================================================
// 5) TRILHA
// ============================================================
describe('F7.1 — toda adoção deixa rastro', () => {
  const st = () => aluna({ cpf: '12345678909' });
  const pr = () => praticante({ cpf: '12345678909' });

  test('com a 263 aplicada: grava em karate_identity_audit, dentro de SAVEPOINT', async () => {
    mockRead({ student: st(), practitioner: pr() });
    const client = mockConfirmTx({ student: st(), practitioner: pr() });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321', confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.audit_table).toBe('karate_identity_audit');

    const ins = txFind(client, /INSERT INTO karate_identity_audit/);
    expect(ins).toBeDefined();
    const vals = ins[1];
    expect(vals).toContain(dojoId);
    expect(vals).toContain(pid);
    expect(vals).toContain('adopt');
    expect(vals).toContain('dojo_federate');
    expect(vals).toContain('sensei@dojo.com.br'); // actor_label vem do token
    // Nunca try/catch nu dentro do BEGIN
    const all = txSqls(client);
    expect(all).toContain('SAVEPOINT sp_identity_audit');
    expect(all).toContain('RELEASE SAVEPOINT sp_identity_audit');
  });

  test('actor_user_id fora de forma uuid vira NULL (nunca derruba a trilha)', async () => {
    mockRead({ student: st(), practitioner: pr() });
    const client = mockConfirmTx({ student: st(), practitioner: pr() });

    await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA()) // id do token é 'u1'
      .send({ fpkt_number: 'FPKT-4321', confirm: true });

    const ins = txFind(client, /INSERT INTO karate_identity_audit/);
    expect(ins[1]).not.toContain('u1');
    expect(ins[1]).toContain('sensei@dojo.com.br');
  });

  test('sem a 263: cai para karate_dojo_roster_events e a adoção continua', async () => {
    SCHEMA = schemaRow({ has_identity_audit: false });
    mockRead({ student: st(), practitioner: pr() });
    const client = mockConfirmTx({ student: st(), practitioner: pr() });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321', confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.audit_table).toBe('karate_dojo_roster_events');
    expect(txHit(client, /INSERT INTO karate_identity_audit/)).toBe(false);
    const ins = txFind(client, /INSERT INTO karate_dojo_roster_events/);
    expect(ins[1]).toContain('identity_adopted');
    expect(txSqls(client)).toContain('COMMIT');
  });

  test('263 existe mas o INSERT falha → rollback ao SAVEPOINT e cai na rede, sem abortar', async () => {
    mockRead({ student: st(), practitioner: pr() });
    const client = mockConfirmTx({ student: st(), practitioner: pr(), auditFails: true });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321', confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.audit_table).toBe('karate_dojo_roster_events');
    const all = txSqls(client);
    expect(all).toContain('ROLLBACK TO SAVEPOINT sp_identity_audit');
    expect(all).toContain('COMMIT');
    expect(all).not.toContain('ROLLBACK'); // o SAVEPOINT protegeu a transação
  });
});

// ============================================================
// 6) DEGRADAÇÃO SEM A MIGRATION 262
// ============================================================
describe('F7.1 — sem a migration 262 aplicada', () => {
  const st = () => aluna({ cpf: '12345678909' });
  const pr = () => praticante({ cpf: '12345678909' });

  test('PREVIEW funciona: shape igual, campos da 262 vazios, schema_pending:true', async () => {
    SCHEMA = schemaRow({ has_customer_identity: false, has_student_identity: false });
    mockRead({ student: st(), practitioner: pr() });

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321' });

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.schema_pending).toBe(true);
    // O SHAPE não muda de formato — a linha existe, só vem vazia do lado do dojô
    expect(field(res.body, 'rg')).toBeDefined();
    expect(field(res.body, 'city')).toBeDefined();

    // A SQL do aluno degrada para NULL::text em vez de citar coluna inexistente
    const load = findCall(isStudentLoad);
    expect(String(load[0])).toContain('NULL::text AS rg');
    expect(String(load[0])).toContain('NULL::text AS city');
    // E a do praticante não cita a coluna da 262
    const fed = findCall(isFpktLookup);
    expect(String(fed[0])).not.toContain('c.karate_identity_managed_by');
    expect(String(fed[0])).toContain("'federation'::text AS karate_identity_managed_by");
  });

  test('CONFIRMAÇÃO recusa limpo: 503 SCHEMA_PENDING_262, sem transação e sem 500', async () => {
    SCHEMA = schemaRow({ has_customer_identity: false, has_student_identity: false });
    mockRead({ student: st(), practitioner: pr() });
    mockConfirmTx();

    const res = await request(app)
      .post(`${dojoBase}/students/${sid}/federate`)
      .set(canalA())
      .send({ fpkt_number: 'FPKT-4321', confirm: true });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SCHEMA_PENDING_262');
    expect(res.body.error).toMatch(/262/);
    expect(res.body.error).toMatch(/Nada foi gravado/i);
    expect(db.connect).not.toHaveBeenCalled();
  });
});

// ============================================================
// 7) DESVINCULAR DEVOLVE A GESTÃO
// ============================================================
describe('F7.1 — DELETE /federate devolve a gestão da ficha à federação', () => {
  function mockUnlinkTx({ practitionerId = pid, backRows = null } = {}) {
    return mockTx((s) => {
      if (/FROM karate_dojo_students/.test(s) && /FOR UPDATE/.test(s)) {
        return { rows: [{ id: sid, full_name: 'Ana Beatriz Souza', practitioner_id: practitionerId }] };
      }
      if (/UPDATE karate_dojo_students/.test(s)) return { rows: [{ id: sid }] };
      if (/UPDATE customers/.test(s)) {
        return { rows: backRows !== null ? backRows : [{ id: pid, name: 'Ana B. Souza', karate_registration_number: 'FPKT-4321' }] };
      }
      return { rows: [] };
    });
  }

  test('managed_by volta para federation e o evento entra na trilha', async () => {
    mockRead();
    const client = mockUnlinkTx();

    const res = await request(app).delete(`${dojoBase}/students/${sid}/federate`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.identity_returned).toBe(true);
    expect(res.body.identity_managed_by).toBe('federation');

    const ins = txFind(client, /INSERT INTO karate_identity_audit/);
    expect(ins[1]).toContain('release');
    expect(ins[1]).toContain('dojo_unfederate');
  });

  test('a ficha adotada por OUTRO dojô não é devolvida por este (UPDATE não casa)', async () => {
    mockRead();
    const client = mockUnlinkTx({ backRows: [] }); // WHERE karate_identity_dojo_id = $2 não casou

    const res = await request(app).delete(`${dojoBase}/students/${sid}/federate`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.unlinked).toBe(true); // o desvínculo local acontece SEMPRE
    expect(res.body.identity_returned).toBe(false);
    expect(txHit(client, /INSERT INTO karate_identity_audit/)).toBe(false);
  });

  test('aluno que nunca foi federado: desvincula sem tocar em customers', async () => {
    mockRead();
    const client = mockUnlinkTx({ practitionerId: null });

    const res = await request(app).delete(`${dojoBase}/students/${sid}/federate`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.identity_returned).toBe(false);
    expect(txHit(client, /UPDATE customers/)).toBe(false);
  });

  test('sem a 262: desvincula MESMO ASSIM (higiene não depende de migration)', async () => {
    SCHEMA = schemaRow({ has_customer_identity: false, has_student_identity: false });
    mockRead();
    const client = mockUnlinkTx();

    const res = await request(app).delete(`${dojoBase}/students/${sid}/federate`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.unlinked).toBe(true);
    expect(res.body.identity_returned).toBe(false);
    expect(res.body.schema_pending).toBe(true);
    expect(txHit(client, /UPDATE customers/)).toBe(false);
    expect(txSqls(client)).toContain('COMMIT');
  });
});
