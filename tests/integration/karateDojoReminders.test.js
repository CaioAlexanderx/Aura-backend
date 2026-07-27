// ============================================================
// AURA DOJÔ — Testes Integração: F3c régua de cobrança (dojô→aluno)
// Cobre:
//   config: GET default (sem registro) → PUT liga+offsets → GET reflete
//   PUT validação: offsets fora de -15..30 → 422
//   run (Canal A): 1 pending vencendo hoje → sent + log
//   rerun mesmo estágio → skipped_sent (dedupe por charge_id+offset+channel)
//   sem e-mail (guardian e aluno) → skipped_no_email
//   Canal B: GET config ok / PUT config e POST run → 403 PORTAL_READ_ONLY
//
// ⚠️ QA 27/07/2026: o runner passou a devolver
// { sent, skipped_no_email, skipped_sent, failed, skipped } — `skipped`
// virou a SOMA dos dois motivos (compat com quem já consome) e os motivos
// ficaram separados porque o front rotulava TODO skip como "sem e-mail",
// o que era mentira quando o skip era dedupe. Os casos abaixo foram
// atualizados junto com o handler (e agora afirmam QUAL foi o motivo).
//
// db.query é 100% mockado (tests/jest.setup.js). RESEND_API_KEY ausente →
// karateMailer.sendKarateEmail simula o envio (não chama fetch), então o
// caminho feliz não precisa mockar rede.
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
const cid = 'c1000000-0000-0000-0000-00000000000c';
const base = `/api/v1/federation/${fedId}/dojo/billing`;

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

afterEach(() => {
  db.query.mockReset();
});

const enabledConfigRow = { enabled: true, offsets: [-3, 0, 3], send_email: true, updated_at: '2026-07-19T00:00:00Z' };
const dojoMetaRow = { name: 'Dojo Aura', slug: 'dojo-aura', karate_logo_url: null, wa_phone_display: null };
const candidate = (over = {}) => ({
  id: cid,
  amount: '140.00',
  competence: '2026-07',
  due_date: '2026-07-05',
  pix_payload: '00020101021126PIXKEYEXAMPLE',
  offset_val: 0,
  student_name: 'Aluno Teste',
  student_email: 'aluno@dojo.com.br',
  guardian_email: null,
  ...over,
});

describe('F3c — régua de cobrança do dojô (dojô→aluno)', () => {
  test('GET reminder-config sem registro → default {enabled:false, offsets:[-3,0,3], send_email:true}', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`${base}/reminder-config`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.offsets).toEqual([-3, 0, 3]);
    expect(res.body.send_email).toBe(true);
    // escopo por dojô do token
    expect(db.query.mock.calls[0][1][0]).toBe(dojoId);
  });

  test('PUT reminder-config (Canal A) liga + offsets ordenados; GET reflete', async () => {
    // PUT: upsert retorna a linha salva (offsets já ordenados no service)
    db.query.mockResolvedValueOnce({ rows: [{ enabled: true, offsets: [-5, 0, 7], send_email: true, updated_at: '2026-07-19T10:00:00Z' }] });
    const put = await request(app)
      .put(`${base}/reminder-config`)
      .set(canalA())
      .send({ enabled: true, offsets: [7, -5, 0], send_email: true });
    expect(put.status).toBe(200);
    expect(put.body.enabled).toBe(true);
    expect(put.body.offsets).toEqual([-5, 0, 7]); // ordenados
    // escopo: dojo_id do upsert é o do token
    expect(db.query.mock.calls[0][1][0]).toBe(dojoId);

    db.query.mockReset();
    db.query.mockResolvedValueOnce({ rows: [{ enabled: true, offsets: [-5, 0, 7], send_email: true, updated_at: '2026-07-19T10:00:00Z' }] });
    const get = await request(app).get(`${base}/reminder-config`).set(canalA());
    expect(get.status).toBe(200);
    expect(get.body.enabled).toBe(true);
    expect(get.body.offsets).toEqual([-5, 0, 7]);
  });

  test('PUT reminder-config offset fora de -15..30 → 422 (sem tocar o banco)', async () => {
    const res = await request(app)
      .put(`${base}/reminder-config`)
      .set(canalA())
      .send({ enabled: true, offsets: [0, 99], send_email: true });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('POST reminders/run (Canal A): 1 pending vencendo hoje → sent + log', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [enabledConfigRow] })   // getConfig
      .mockResolvedValueOnce({ rows: [candidate()] })         // candidatas (offset 0)
      .mockResolvedValueOnce({ rows: [dojoMetaRow] })         // getDojoMeta
      .mockResolvedValueOnce({ rows: [] })                    // alreadyLogged → nenhum 'sent'
      .mockResolvedValueOnce({ rows: [{ id: 'log1' }] });     // logSend 'sent'

    const res = await request(app).post(`${base}/reminders/run`).set(canalA()).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 1, skipped_no_email: 0, skipped_sent: 0, failed: 0, skipped: 0 });

    // o INSERT do log gravou status 'sent' e escopo por dojô
    const insert = db.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO karate_dojo_reminder_log'));
    expect(insert).toBeDefined();
    expect(insert[1][0]).toBe(dojoId);       // dojo_id
    expect(insert[1][4]).toBe('sent');       // status
  });

  test('POST reminders/run: rerun do mesmo estágio JÁ ENVIADO → skipped_sent (dedupe)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [enabledConfigRow] })                 // getConfig
      .mockResolvedValueOnce({ rows: [candidate()] })                       // candidatas
      .mockResolvedValueOnce({ rows: [dojoMetaRow] })                       // getDojoMeta
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] });                    // alreadyLogged → já 'sent'

    const res = await request(app).post(`${base}/reminders/run`).set(canalA()).send({});
    expect(res.status).toBe(200);
    // skipped continua sendo a SOMA (compat), mas agora dá pra saber o motivo
    expect(res.body).toEqual({ sent: 0, skipped_no_email: 0, skipped_sent: 1, failed: 0, skipped: 1 });
    // não inseriu novo log
    const insert = db.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO karate_dojo_reminder_log'));
    expect(insert).toBeUndefined();
  });

  test('POST reminders/run: aluno e responsável sem e-mail → skipped_no_email', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [enabledConfigRow] })                                   // getConfig
      .mockResolvedValueOnce({ rows: [candidate({ student_email: null, guardian_email: null })] }) // candidatas
      .mockResolvedValueOnce({ rows: [dojoMetaRow] })                                        // getDojoMeta
      .mockResolvedValueOnce({ rows: [] })                                                   // alreadyLogged
      .mockResolvedValueOnce({ rows: [] });                                                  // logSend skipped_no_email

    const res = await request(app).post(`${base}/reminders/run`).set(canalA()).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 0, skipped_no_email: 1, skipped_sent: 0, failed: 0, skipped: 1 });
    const insert = db.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO karate_dojo_reminder_log'));
    expect(insert).toBeDefined();
    expect(insert[1][4]).toBe('skipped_no_email'); // status
    // e o log NUNCA mais é DO NOTHING: o retry precisa sobrescrever o skip
    expect(String(insert[0])).toContain('DO UPDATE');
  });

  test('Canal B: GET reminder-config OK / PUT + run → 403 PORTAL_READ_ONLY', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const g = await request(app).get(`${base}/reminder-config`).set(canalB());
    expect(g.status).toBe(200);
    expect(g.body.offsets).toEqual([-3, 0, 3]);

    db.query.mockReset();
    const p = await request(app).put(`${base}/reminder-config`).set(canalB()).send({ enabled: true, offsets: [0], send_email: true });
    expect(p.status).toBe(403);
    expect(p.body.code).toBe('PORTAL_READ_ONLY');

    const r = await request(app).post(`${base}/reminders/run`).set(canalB()).send({});
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });
});
