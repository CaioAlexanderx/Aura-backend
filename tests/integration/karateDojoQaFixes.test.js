// ============================================================
// AURA DOJÔ — Testes Integração: correções do QA de produção (27/07/2026)
//
// Cobre os caminhos NOVOS dos 6 itens do QA:
//   1. GET /dojo/me com cadastro + bloco federativo completos
//   2. PATCH /dojo/me — campo federativo no body é IGNORADO em silêncio;
//      validação 422; Canal B → 403 PORTAL_READ_ONLY
//   3. GET /dojo/students — paginação real (limit capado, offset, count
//      total sem paginação)
//   4. régua: retry depois de um 'skipped_no_email' ENVIA (dedupe só conta
//      status='sent'; o log faz ON CONFLICT DO UPDATE)
//   5. canal WhatsApp: fila + confirmação idempotente
//   6. check-in QR: aluno sem nenhuma matrícula → 409 NOT_ENROLLED
//
// ⚠️ MOCK POR SQL (mockImplementation despachando por regex), NUNCA fila
// posicional: um gate/coluna nova entra na frente e desalinha tudo
// (foi o que quebrou o CI nos PRs #421 e #423). E nunca {rows: []}
// genérico: vários handlers leem rows[0].x direto e viram 500.
//
// db.query.mockReset() em afterEach (jest.clearAllMocks NÃO drena filas).
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, classSvc;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  classSvc = require('../../src/services/karateDojoClassService');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const sid = 'a1000000-0000-0000-0000-00000000000a';
const cid = 'c1000000-0000-0000-0000-00000000000c';
const base = `/api/v1/federation/${fedId}/dojo`;

const canalA = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'sensei@dojo.com.br', type: 'access', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

const canalB = () => ({
  Authorization: `Bearer ${jwt.sign(
    { type: 'portal', scope: 'dojo_portal', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

const sqls = () => db.query.mock.calls.map((c) => String(c[0]));
const findSql = (re) => sqls().find((s) => re.test(s));
const findCall = (re) => db.query.mock.calls.find((c) => re.test(String(c[0])));

afterEach(() => {
  db.query.mockReset();
});

// ────────────────────────────────────────────────────────
// 1 + 2 — /dojo/me completo e editável
// ────────────────────────────────────────────────────────

const companyRow = (over = {}) => ({
  id: dojoId,
  legal_name: 'Dojô QA LTDA',
  trade_name: 'Dojô QA',
  slug: 'dojo-qa',
  cnpj: '12345678000199',
  email: 'contato@dojoqa.com.br',
  phone: '91999990000',
  federation_id: fedId,
  vertical: 'karate_dojo',
  created_at: '2026-07-01T00:00:00Z',
  fpkt_affiliation_id: 'FPKT-DOJO-77',
  affiliation_model: 'plena',
  region: 'Belém',
  affiliated_since: '2019-03-10',
  founded_at: '2015-08-01',
  owner_email: 'sensei@dojo.com.br',
  federation_name: 'FPKT',
  federation_slug: 'fpkt',
  practitioners_count: 42,
  ...over,
});

// linkedAt = null → dojô não conectado. `extra(sql)` responde as demais.
function mockDojoMe(linkedAt, extra) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/SELECT\s+karate_dojo_linked_at/i.test(s)) {
      return Promise.resolve({ rows: [{ karate_dojo_linked_at: linkedAt }] });
    }
    // Âncora do SELECT do /dojo/me (o mesmo prefixo usado em
    // karateDojoNotLinked.test.js — casar pelo FROM pegaria a query do
    // contato da federação em /dojo/events).
    if (/SELECT c\.id, c\.legal_name/.test(s)) return Promise.resolve({ rows: [companyRow()] });
    if (extra) {
      const r = extra(s);
      if (r) return Promise.resolve(r);
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('QA 1 — GET /dojo/me devolve o cadastro completo (fim dos 11 campos "—")', () => {
  test('dojô conectado: cadastro + bloco federativo + linked no topo', async () => {
    mockDojoMe(new Date('2026-07-01T12:00:00Z'));
    const res = await request(app).get(`${base}/me`).set(canalA());

    expect(res.status).toBe(200);
    const d = res.body.dojo;
    // cadastro do próprio dojô
    expect(d.id).toBe(dojoId);
    expect(d.name).toBe('Dojô QA');
    expect(d.slug).toBe('dojo-qa');
    expect(d.cnpj).toBe('12345678000199');
    expect(d.email).toBe('contato@dojoqa.com.br');
    expect(d.phone).toBe('91999990000');
    expect(d.founded_at).toBe('2015-08-01');
    // bloco federativo (read-only)
    expect(d.federation_id).toBe(fedId);
    expect(d.federation_name).toBe('FPKT');
    expect(d.federation_slug).toBe('fpkt');
    expect(d.fpkt_affiliation_id).toBe('FPKT-DOJO-77');
    expect(d.affiliation_status).toBe('filiado');
    expect(d.affiliation_model).toBe('plena');
    expect(d.affiliated_since).toBe('2019-03-10');
    expect(d.region).toBe('Belém');
    expect(d.practitioners_count).toBe(42);
    // contexto (compat com o front atual)
    expect(d.auth_channel).toBe('A');
    expect(d.linked).toBe(true);
    expect(res.body.linked).toBe(true);
    expect(res.body.linked_at).toBe('2026-07-01T12:00:00.000Z');
    // federation_name sai de COALESCE(trade_name, legal_name) — companies
    // não tem `name` confiável
    expect(findSql(/COALESCE\(f\.trade_name, f\.legal_name\) AS federation_name/)).toBeDefined();
  });

  test('sem número de filiação + conectado → affiliation_status "pendente"', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/SELECT\s+karate_dojo_linked_at/i.test(s)) {
        return Promise.resolve({ rows: [{ karate_dojo_linked_at: new Date('2026-07-01T12:00:00Z') }] });
      }
      if (/SELECT c\.id, c\.legal_name/.test(s)) {
        return Promise.resolve({ rows: [companyRow({ fpkt_affiliation_id: null })] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get(`${base}/me`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.dojo.affiliation_status).toBe('pendente');
  });

  test('sem número e não conectado → "nao_filiado" (e nada quebra)', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/SELECT\s+karate_dojo_linked_at/i.test(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: null }] });
      if (/SELECT c\.id, c\.legal_name/.test(s)) {
        return Promise.resolve({ rows: [companyRow({ fpkt_affiliation_id: null, affiliation_model: null, region: null, affiliated_since: null })] });
      }
      return Promise.resolve({ rows: [] });
    });
    const res = await request(app).get(`${base}/me`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.dojo.affiliation_status).toBe('nao_filiado');
    expect(res.body.dojo.region).toBeNull();
    expect(res.body.linked).toBe(false);
  });
});

describe('QA 2 — PATCH /dojo/me (o dojô edita o próprio cadastro)', () => {
  test('campo FEDERATIVO no body é ignorado em silêncio (nunca entra no UPDATE)', async () => {
    mockDojoMe(new Date('2026-07-01T12:00:00Z'), (s) => {
      if (/^UPDATE companies SET/.test(s)) return { rows: [{ id: dojoId }] };
      return null;
    });

    const res = await request(app)
      .patch(`${base}/me`)
      .set(canalA())
      .send({
        name: 'Dojô Novo Nome',
        phone: '(91) 98888-7777',
        // bloco federativo ecoado pelo front — tem que ser IGNORADO
        fpkt_affiliation_id: 'HACK-1',
        affiliation_status: 'filiado',
        affiliation_model: 'plena',
        affiliated_since: '2000-01-01',
        region: 'Outra Região',
        practitioners_count: 9999,
        federation_id: 'fed-hack',
      });

    expect(res.status).toBe(200);

    const upd = findCall(/^UPDATE companies SET/);
    expect(upd).toBeDefined();
    const updSql = String(upd[0]);
    for (const col of ['fpkt_affiliation_id', 'affiliation_model', 'affiliation_since', 'region', 'federation_id =']) {
      expect(updSql).not.toContain(col);
    }
    expect(updSql).toContain('trade_name =');
    expect(updSql).toContain('phone =');
    // escopo: id + federation_id do TOKEN, nas duas últimas posições
    const params = upd[1];
    expect(params[params.length - 2]).toBe(dojoId);
    expect(params[params.length - 1]).toBe(fedId);
    // telefone normalizado para dígitos
    expect(params).toContain('91988887777');
    expect(params).toContain('Dojô Novo Nome');
    // resposta com o MESMO shape do GET
    expect(res.body.dojo.affiliation_status).toBe('filiado');
    expect(res.body.dojo.auth_channel).toBe('A');
  });

  test('founded_at grava a data E espelha o ano em dojo_founded_year', async () => {
    mockDojoMe(null, (s) => (/^UPDATE companies SET/.test(s) ? { rows: [{ id: dojoId }] } : null));

    const res = await request(app).patch(`${base}/me`).set(canalA()).send({ founded_at: '2015-08-01' });
    expect(res.status).toBe(200);

    const updSql = String(findCall(/^UPDATE companies SET/)[0]);
    expect(updSql).toContain('dojo_founded_at =');
    expect(updSql).toContain('dojo_founded_year = EXTRACT(YEAR FROM');
  });

  test('cnpj/e-mail/telefone inválidos → 422 VALIDATION_ERROR sem tocar o banco', async () => {
    for (const body of [{ cnpj: '123' }, { email: 'nao-e-email' }, { phone: '999' }, { name: '   ' }, { founded_at: '01/08/2015' }]) {
      db.query.mockReset();
      const res = await request(app).patch(`${base}/me`).set(canalA()).send(body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(db.query).not.toHaveBeenCalled();
    }
  });

  test('Canal B (portal) → 403 PORTAL_READ_ONLY (sem tocar o banco)', async () => {
    const res = await request(app).patch(`${base}/me`).set(canalB()).send({ name: 'X' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────
// 3 — paginação de /dojo/students
// ────────────────────────────────────────────────────────

const studentListRow = (over = {}) => ({
  id: sid,
  full_name: 'Aluno Teste',
  birth_date: '1990-05-10',
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
  is_federated: false,
  has_pending_request: false,
  fpkt_number: null,
  total_count: '205',
  ...over,
});

function mockStudentList(rows) {
  db.query.mockImplementation((sql) => {
    if (/FROM karate_dojo_students s/.test(String(sql))) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
}

describe('QA 3 — GET /dojo/students respeita limit/offset (105 KB fixos era o bug)', () => {
  test('limit acima do teto é capado em 500 e o offset é repassado ao SQL', async () => {
    mockStudentList([studentListRow()]);
    const res = await request(app).get(`${base}/students?limit=1000&offset=20`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(500);
    expect(res.body.offset).toBe(20);
    // count = TOTAL sem paginação (count(*) OVER()), não data.length
    expect(res.body.count).toBe(205);
    expect(res.body.data).toHaveLength(1);

    const call = findCall(/FROM karate_dojo_students s/);
    expect(String(call[0])).toContain('LIMIT $6 OFFSET $7');
    expect(call[1][0]).toBe(dojoId); // escopo pelo dojô do token
    expect(call[1][5]).toBe(500);
    expect(call[1][6]).toBe(20);
  });

  test('sem query params → default 100/0 (e os filtros continuam valendo)', async () => {
    mockStudentList([studentListRow()]);
    const res = await request(app).get(`${base}/students?status=active&belt=Branca`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
    const params = findCall(/FROM karate_dojo_students s/)[1];
    expect(params[1]).toBe('active');
    expect(params[3]).toBe('Branca');
    expect(params[5]).toBe(100);
    expect(params[6]).toBe(0);
  });

  test('limit lixo (negativo/NaN) cai no default — nunca 422', async () => {
    mockStudentList([studentListRow()]);
    const res = await request(app).get(`${base}/students?limit=-5&offset=abc`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
    expect(res.body.offset).toBe(0);
  });
});

// ────────────────────────────────────────────────────────
// 6 — check-in QR: NOT_ENROLLED ≠ NO_CLASS_TODAY
// ────────────────────────────────────────────────────────

function mockCheckin(enrollmentRows) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/karate_dojo_class_settings/.test(s)) return Promise.resolve({ rows: [{ qr_checkin_enabled: true }] });
    if (/SELECT id, full_name, belt_label FROM karate_dojo_students/.test(s)) {
      return Promise.resolve({ rows: [{ id: sid, full_name: 'Aluno', belt_label: null }] });
    }
    if (/JOIN karate_dojo_class_enrollments e ON e\.class_id = c\.id AND e\.student_id/.test(s)) {
      return Promise.resolve({ rows: enrollmentRows });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('QA 6 — check-in QR: cadastro (NOT_ENROLLED) x agenda (NO_CLASS_TODAY)', () => {
  test('aluno sem NENHUMA matrícula → 409 NOT_ENROLLED com mensagem de cadastro', async () => {
    const token = classSvc.signQrToken({ student_id: sid, dojo_id: dojoId });
    mockCheckin([]);

    const res = await request(app).post(`${base}/classes/checkin`).set(canalA())
      .send({ token, date: '2026-07-20' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_ENROLLED');
    expect(res.body.error).toBe('Aluno não está matriculado em nenhuma turma.');
  });

  test('aluno matriculado, mas a turma é de outro dia → 409 NO_CLASS_TODAY', async () => {
    const token = classSvc.signQrToken({ student_id: sid, dojo_id: dojoId });
    // 2026-07-20 é SEGUNDA (weekday 1); a turma só tem quarta (3).
    mockCheckin([{ id: cid, name: 'Infantil', start_time: '18:00', weekdays: [3] }]);

    const res = await request(app).post(`${base}/classes/checkin`).set(canalA())
      .send({ token, date: '2026-07-20' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_CLASS_TODAY');
  });

  test('matriculado na turma do dia → marca presença (regressão do caminho feliz)', async () => {
    const token = classSvc.signQrToken({ student_id: sid, dojo_id: dojoId });
    mockCheckin([{ id: cid, name: 'Infantil', start_time: '18:00', weekdays: [1, 3] }]);

    const res = await request(app).post(`${base}/classes/checkin`).set(canalA())
      .send({ token, date: '2026-07-20' });

    expect(res.status).toBe(200);
    expect(res.body.class.id).toBe(cid);
    expect(res.body.already_checked).toBe(false);
    expect(findSql(/INSERT INTO karate_dojo_attendance/)).toBeDefined();
  });

  test('token com assinatura inválida → erro genérico de QR (sem tocar o banco)', async () => {
    const token = `${classSvc.signQrToken({ student_id: sid, dojo_id: dojoId })}x`;
    const res = await request(app).post(`${base}/classes/checkin`).set(canalA()).send({ token });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_TOKEN');
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────
// 4 — régua: retry depois de skipped_no_email
// ────────────────────────────────────────────────────────

const billingBase = `/api/v1/federation/${fedId}/dojo/billing`;
const dojoMetaRow = { name: 'Dojô QA', slug: 'dojo-qa', karate_logo_url: null, wa_phone_display: null };

function mockRun({ candidates, sentLogRows = [] }) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/FROM karate_dojo_reminder_config/.test(s)) {
      return Promise.resolve({ rows: [{ enabled: true, offsets: [0], send_email: true, updated_at: null }] });
    }
    if (/INSERT INTO karate_dojo_reminder_log/.test(s)) return Promise.resolve({ rows: [] });
    if (/SELECT 1 FROM karate_dojo_reminder_log/.test(s)) return Promise.resolve({ rows: sentLogRows });
    if (/karate_logo_url, wa_phone_display/.test(s)) return Promise.resolve({ rows: [dojoMetaRow] });
    if (/unnest\(\$2::int\[\]\)/.test(s)) return Promise.resolve({ rows: candidates });
    return Promise.resolve({ rows: [] });
  });
}

const candidate = (over = {}) => ({
  id: cid,
  amount: '140.00',
  competence: '2026-07',
  due_date: '2026-07-05',
  pix_payload: '00020101021126PIXKEYEXAMPLE',
  offset_val: 0,
  student_name: 'Aluno Teste',
  student_email: null,
  guardian_email: null,
  ...over,
});

describe('QA 4 — um skipped_no_email não pode travar o estágio para sempre', () => {
  test('e-mail cadastrado DEPOIS do skip → o próximo run ENVIA', async () => {
    // O log antigo é 'skipped_no_email': a query de dedupe filtra por
    // status='sent', então ela não encontra nada e o envio acontece.
    mockRun({ candidates: [candidate({ guardian_email: 'mae@exemplo.com' })], sentLogRows: [] });

    const res = await request(app).post(`${billingBase}/reminders/run`).set(canalA()).send({});

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(res.body.skipped_no_email).toBe(0);
    expect(res.body.skipped_sent).toBe(0);
    expect(res.body.skipped).toBe(0);

    // o dedupe só considera envio EFETIVO
    expect(findSql(/SELECT 1 FROM karate_dojo_reminder_log/)).toContain("status = 'sent'");
    // e o log sobrescreve a linha do skip anterior
    const ins = findSql(/INSERT INTO karate_dojo_reminder_log/);
    expect(ins).toContain('DO UPDATE');
    expect(ins).not.toContain('DO NOTHING');
  });

  test('já enviado de verdade → skipped_sent (e não skipped_no_email)', async () => {
    mockRun({ candidates: [candidate({ guardian_email: 'mae@exemplo.com' })], sentLogRows: [{ '?column?': 1 }] });

    const res = await request(app).post(`${billingBase}/reminders/run`).set(canalA()).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 0, skipped_no_email: 0, skipped_sent: 1, failed: 0, skipped: 1 });
  });

  test('sem e-mail nenhum → skipped_no_email (o front pode finalmente rotular certo)', async () => {
    mockRun({ candidates: [candidate()], sentLogRows: [] });

    const res = await request(app).post(`${billingBase}/reminders/run`).set(canalA()).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 0, skipped_no_email: 1, skipped_sent: 0, failed: 0, skipped: 1 });
  });
});

// ────────────────────────────────────────────────────────
// 5 — canal WhatsApp (fila manual)
// ────────────────────────────────────────────────────────

const waBase = `/api/v1/federation/${fedId}/dojo/reminders`;

const waRow = (over = {}) => ({
  id: cid,
  amount: '140.00',
  competence: '2026-07',
  due_date: '2026-07-05',
  pix_payload: '00020101021126PIXKEYEXAMPLE',
  offset_val: 0,
  student_name: 'Aluno Teste',
  student_phone: null,
  guardian_name: 'Mãe Zelosa',
  guardian_phone: '(91) 99999-0000',
  already_sent: false,
  ...over,
});

function mockWaQueue(rows) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/FROM karate_dojo_reminder_config/.test(s)) {
      return Promise.resolve({ rows: [{ enabled: true, offsets: [0], send_email: true, updated_at: null }] });
    }
    if (/karate_logo_url, wa_phone_display/.test(s)) return Promise.resolve({ rows: [dojoMetaRow] });
    if (/unnest\(\$2::int\[\]\)/.test(s)) return Promise.resolve({ rows });
    return Promise.resolve({ rows: [] });
  });
}

describe('QA 5 — fila de WhatsApp (responsável de menor quase nunca tem e-mail)', () => {
  test('monta mensagem pt-BR + wa.me e só inclui quem TEM telefone', async () => {
    mockWaQueue([
      waRow(),
      waRow({ id: 'c2000000-0000-0000-0000-00000000000c', guardian_phone: null, student_phone: null, student_name: 'Sem Telefone' }),
    ]);

    const res = await request(app).get(`${waBase}/whatsapp-queue?date=2026-07-05`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.date).toBe('2026-07-05');
    expect(res.body.count).toBe(1); // o sem telefone ficou de fora
    const item = res.body.data[0];
    expect(item.charge_id).toBe(cid);
    expect(item.offset).toBe(0);
    expect(item.recipient_name).toBe('Mãe Zelosa');
    expect(item.phone).toBe('91999990000'); // só dígitos, sem o 55
    expect(item.amount).toBe(140);
    expect(item.already_sent).toBe(false);
    expect(item.message).toContain('vence hoje'); // offset 0
    expect(item.message).toContain('2026-07');
    expect(item.wa_url.startsWith('https://wa.me/5591999990000?text=')).toBe(true);
    expect(decodeURIComponent(item.wa_url.split('?text=')[1])).toBe(item.message);
    // escopo por dojô do token
    expect(findCall(/unnest\(\$2::int\[\]\)/)[1][0]).toBe(dojoId);
  });

  test('offset positivo vira texto de atraso; negativo, de "a vencer"', async () => {
    mockWaQueue([waRow({ offset_val: 3 })]);
    const atraso = await request(app).get(`${waBase}/whatsapp-queue?date=2026-07-08`).set(canalA());
    expect(atraso.body.data[0].message).toContain('em aberto');

    db.query.mockReset();
    mockWaQueue([waRow({ offset_val: -3 })]);
    const aVencer = await request(app).get(`${waBase}/whatsapp-queue?date=2026-07-02`).set(canalA());
    expect(aVencer.body.data[0].message).toContain('vence em');
  });

  test('date inválida → 422 (sem tocar o banco)', async () => {
    const res = await request(app).get(`${waBase}/whatsapp-queue?date=05/07/2026`).set(canalA());
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('whatsapp-sent é IDEMPOTENTE (200 nas duas chamadas, grava channel whatsapp)', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/INSERT INTO karate_dojo_reminder_log/.test(s)) return Promise.resolve({ rows: [] });
      if (/FROM karate_dojo_charges c/.test(s)) {
        return Promise.resolve({ rows: [{ id: cid, student_phone: null, guardian_phone: '(91) 99999-0000' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const r1 = await request(app).post(`${waBase}/${cid}/whatsapp-sent`).set(canalA()).send({ offset: 0 });
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({
      ok: true, charge_id: cid, offset: 0, channel: 'whatsapp', status: 'sent', recipient: '91999990000',
    });

    const r2 = await request(app).post(`${waBase}/${cid}/whatsapp-sent`).set(canalA()).send({ offset: 0 });
    expect(r2.status).toBe(200); // repetir não é erro

    const ins = findCall(/INSERT INTO karate_dojo_reminder_log/);
    expect(ins[1][0]).toBe(dojoId);        // dojo_id do token
    expect(ins[1][3]).toBe('whatsapp');    // channel
    expect(ins[1][4]).toBe('sent');        // status
    expect(String(ins[0])).toContain('DO UPDATE');
  });

  test('cobrança de OUTRO dojô → 404 (escopo por req.dojoId, nunca pelo body)', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
    const res = await request(app).post(`${waBase}/${cid}/whatsapp-sent`).set(canalA()).send({ offset: 0 });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(findSql(/INSERT INTO karate_dojo_reminder_log/)).toBeUndefined();
  });

  test('offset ausente/não inteiro → 422', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
    const res = await request(app).post(`${waBase}/${cid}/whatsapp-sent`).set(canalA()).send({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('Canal B confirma envio → 403 PORTAL_READ_ONLY (mas PODE consultar a fila)', async () => {
    const p = await request(app).post(`${waBase}/${cid}/whatsapp-sent`).set(canalB()).send({ offset: 0 });
    expect(p.status).toBe(403);
    expect(p.body.code).toBe('PORTAL_READ_ONLY');

    db.query.mockReset();
    mockWaQueue([]);
    const g = await request(app).get(`${waBase}/whatsapp-queue`).set(canalB());
    expect(g.status).toBe(200);
    expect(g.body.data).toEqual([]);
  });
});
