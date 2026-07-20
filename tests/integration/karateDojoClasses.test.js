// ============================================================
// AURA DOJÔ — Testes Integração: F4 turmas, matrículas e presença
// Cobre:
//   turmas: POST cria (escopo dojo_id do token) + weekdays fora 0-6 → 422;
//           GET lista; DELETE com presença → 409 HAS_HISTORY
//   matrículas: enroll duplicado → 409 ALREADY_ENROLLED; inativo → 422
//   presença: PUT upsert em lote re-salvável → { saved }
//   summary: total_present/30d/90d + by_class + recent
//   QR: GET token do aluno; toggle OFF → 409 QR_DESABILITADO;
//       token de outro dojô → 403 DOJO_MISMATCH; checkin feliz + repetido
//       → already_checked; sem turma hoje → 409 NO_CLASS_TODAY
//   Canal B: PUT settings → 403 PORTAL_READ_ONLY
//
// Padrão karateDojoBilling.test.js: db.query.mockReset() em afterEach.
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, svc;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  svc = require('../../src/services/karateDojoClassService');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const otherDojo = 'd0000000-0000-0000-0000-00000000000f';
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

afterEach(() => {
  db.query.mockReset();
});

describe('F4 — turmas, matrículas e presença do dojô', () => {
  test('GET classes sem token → 401', async () => {
    const res = await request(app).get(`${base}/classes`);
    expect(res.status).toBe(401);
  });

  test('POST turma (Canal A) → 201; dojo_id vem do TOKEN; weekdays ordenados', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'cl1', name: 'Infantil', weekdays: [1, 3], start_time: '18:00', end_time: '19:00', modality: 'karate', active: true }],
    });
    const res = await request(app)
      .post(`${base}/classes`)
      .set(canalA())
      .send({ name: 'Infantil', weekdays: [3, 1], start_time: '18:00', end_time: '19:00', modality: 'karate' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('cl1');
    expect(res.body.weekdays).toEqual([1, 3]);
    expect(res.body.students_count).toBe(0);
    // escopo: dojo_id do INSERT é o do token
    expect(db.query.mock.calls[0][1][0]).toBe(dojoId);
    // weekdays normalizados/ordenados no payload enviado ao banco
    expect(db.query.mock.calls[0][1][2]).toEqual([1, 3]);
  });

  test('POST turma weekdays fora de 0-6 → 422 (sem tocar o banco)', async () => {
    const res = await request(app)
      .post(`${base}/classes`)
      .set(canalA())
      .send({ name: 'Turma', weekdays: [1, 7] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('POST turma name vazio → 422', async () => {
    const res = await request(app).post(`${base}/classes`).set(canalA()).send({ name: '  ', weekdays: [1] });
    expect(res.status).toBe(422);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('GET classes → lista com students_count', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'cl1', name: 'Infantil', weekdays: [1, 3], start_time: '18:00', end_time: null, modality: null, active: true, students_count: 5 }],
    });
    const res = await request(app).get(`${base}/classes`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].students_count).toBe(5);
    expect(db.query.mock.calls[0][1][0]).toBe(dojoId);
  });

  test('DELETE turma COM presenças → 409 HAS_HISTORY', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid }] })       // turma existe
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // tem presença
    const res = await request(app).delete(`${base}/classes/${cid}`).set(canalA());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HAS_HISTORY');
  });

  test('DELETE turma SEM presenças → delete real', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid }] }) // turma existe
      .mockResolvedValueOnce({ rows: [] })            // sem presença
      .mockResolvedValueOnce({ rows: [] });           // DELETE
    const res = await request(app).delete(`${base}/classes/${cid}`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  test('enroll aluno inativo → 422 STUDENT_INACTIVE (sem INSERT)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, name: 'Infantil' }] })  // assertClass
      .mockResolvedValueOnce({ rows: [{ id: sid, status: 'inactive' }] }); // aluno
    const res = await request(app).post(`${base}/classes/${cid}/enroll`).set(canalA()).send({ student_id: sid });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('STUDENT_INACTIVE');
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('enroll DUPLICADO → 409 ALREADY_ENROLLED', async () => {
    const dup = Object.assign(new Error('dup'), { code: '23505' });
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, name: 'Infantil' }] })   // assertClass
      .mockResolvedValueOnce({ rows: [{ id: sid, status: 'active' }] })   // aluno ativo
      .mockRejectedValueOnce(dup);                                        // INSERT viola UNIQUE
    const res = await request(app).post(`${base}/classes/${cid}/enroll`).set(canalA()).send({ student_id: sid });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_ENROLLED');
  });

  test('PUT attendance — upsert em lote re-salvável → { saved }', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, name: 'Infantil' }] }) // assertClass
      .mockResolvedValueOnce({ rows: [{ id: 'att1' }] });               // upsert RETURNING
    const res = await request(app)
      .put(`${base}/classes/${cid}/attendance`)
      .set(canalA())
      .send({ date: '2026-07-20', records: [{ student_id: sid, present: true }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ saved: 1 });
    // escopo por dojô do token no upsert
    expect(db.query.mock.calls[1][1][0]).toBe(dojoId);
  });

  test('PUT attendance date inválida → 422', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: cid, name: 'Infantil' }] }); // assertClass
    const res = await request(app)
      .put(`${base}/classes/${cid}/attendance`)
      .set(canalA())
      .send({ date: '2026/07/20', records: [{ student_id: sid, present: true }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('GET attendance-summary → totais + by_class + recent', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: sid }] })                                                              // aluno existe
      .mockResolvedValueOnce({ rows: [{ total_present: 12, present_30d: 4, present_90d: 10 }] })                   // totais
      .mockResolvedValueOnce({ rows: [{ class_id: 'cl1', class_name: 'Infantil', present_count: 12, last_present_date: '2026-07-18' }] }) // by_class
      .mockResolvedValueOnce({ rows: [{ date: '2026-07-18', class_name: 'Infantil', present: true, method: 'manual' }] });               // recent
    const res = await request(app).get(`${base}/students/${sid}/attendance-summary`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.total_present).toBe(12);
    expect(res.body.present_30d).toBe(4);
    expect(res.body.by_class).toHaveLength(1);
    expect(res.body.by_class[0].last_present_date).toBe('2026-07-18');
    expect(res.body.recent[0].method).toBe('manual');
  });

  test('GET student qr → token stateless (2 partes)', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: sid }] }); // aluno existe
    const res = await request(app).get(`${base}/students/${sid}/qr`).set(canalA());
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.split('.')).toHaveLength(2);
    // o token verifica para o par (aluno, dojô)
    expect(svc.verifyQrToken(res.body.token)).toEqual({ student_id: sid, dojo_id: dojoId });
  });

  test('checkin com toggle OFF → 409 QR_DESABILITADO', async () => {
    const token = svc.signQrToken({ student_id: sid, dojo_id: dojoId });
    db.query.mockResolvedValueOnce({ rows: [{ qr_checkin_enabled: false }] }); // getSettings
    const res = await request(app).post(`${base}/classes/checkin`).set(canalA()).send({ token });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('QR_DESABILITADO');
  });

  test('checkin com token de OUTRO dojô → 403 DOJO_MISMATCH (sem tocar o banco)', async () => {
    const token = svc.signQrToken({ student_id: sid, dojo_id: otherDojo });
    const res = await request(app).post(`${base}/classes/checkin`).set(canalA()).send({ token });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DOJO_MISMATCH');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('checkin feliz (class_id) → marca present/qr; repetir → already_checked', async () => {
    const token = svc.signQrToken({ student_id: sid, dojo_id: dojoId });
    // 1ª vez: sem presença prévia → already_checked false
    db.query
      .mockResolvedValueOnce({ rows: [{ qr_checkin_enabled: true }] })                    // getSettings
      .mockResolvedValueOnce({ rows: [{ id: sid, full_name: 'Aluno', belt_label: 'Branca' }] }) // aluno
      .mockResolvedValueOnce({ rows: [{ id: cid, name: 'Infantil' }] })                   // turma
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })                               // matrícula ok
      .mockResolvedValueOnce({ rows: [] })                                                // sem presença prévia
      .mockResolvedValueOnce({ rows: [] });                                               // INSERT/upsert
    const r1 = await request(app).post(`${base}/classes/checkin`).set(canalA())
      .send({ token, class_id: cid, date: '2026-07-20' });
    expect(r1.status).toBe(200);
    expect(r1.body.already_checked).toBe(false);
    expect(r1.body.student.id).toBe(sid);
    expect(r1.body.class.id).toBe(cid);

    db.query.mockReset();

    // 2ª vez: já presente → already_checked true (idempotente)
    db.query
      .mockResolvedValueOnce({ rows: [{ qr_checkin_enabled: true }] })
      .mockResolvedValueOnce({ rows: [{ id: sid, full_name: 'Aluno', belt_label: 'Branca' }] })
      .mockResolvedValueOnce({ rows: [{ id: cid, name: 'Infantil' }] })
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ present: true }] }) // já presente
      .mockResolvedValueOnce({ rows: [] });
    const r2 = await request(app).post(`${base}/classes/checkin`).set(canalA())
      .send({ token, class_id: cid, date: '2026-07-20' });
    expect(r2.status).toBe(200);
    expect(r2.body.already_checked).toBe(true);
  });

  test('checkin sem class_id e sem turma no dia → 409 NO_CLASS_TODAY', async () => {
    const token = svc.signQrToken({ student_id: sid, dojo_id: dojoId });
    db.query
      .mockResolvedValueOnce({ rows: [{ qr_checkin_enabled: true }] })                    // getSettings
      .mockResolvedValueOnce({ rows: [{ id: sid, full_name: 'Aluno', belt_label: null }] }) // aluno
      .mockResolvedValueOnce({ rows: [] });                                               // nenhuma turma no dia
    const res = await request(app).post(`${base}/classes/checkin`).set(canalA())
      .send({ token, date: '2026-07-20' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_CLASS_TODAY');
  });

  test('Canal B: PUT settings → 403 PORTAL_READ_ONLY (sem tocar o banco)', async () => {
    const res = await request(app).put(`${base}/classes/settings`).set(canalB()).send({ qr_checkin_enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('Canal B: GET classes OK (portal lê)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`${base}/classes`).set(canalB());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
