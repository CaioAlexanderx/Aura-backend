// ============================================================
// AURA DOJÔ — Testes Integração: F9 QR único do dojô + janela de
// tolerância no check-in.
//
// MOCK POR SQL (mockImplementation despachando por regex de âncora no
// início/trecho fixo da query), NUNCA fila posicional — convenção do
// repo (karateDojoQaFixes.test.js): uma coluna/gate novo na frente
// desalinha uma fila posicional e derruba o CI sem o teste provar nada.
//
// Nos mocks, o parâmetro de escopo (dojo_id, student_id) das linhas
// simuladas é SEMPRE a CONSTANTE do teste (dojoId/sid) — nunca uma
// tautologia comparando a constante contra ela mesma.
//
// O horário "agora" (pra janela de tolerância) é calculado AQUI com o
// MESMO algoritmo (Intl America/Sao_Paulo) que karateDojoClassService.js
// usa em brtNow() — os testes de janela funcionam em qualquer horário
// que o CI rodar, sem precisar mockar Date/timers.
//
// db.query.mockReset() em afterEach (jest.clearAllMocks NÃO drena filas).
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
const cid1 = 'c1000000-0000-0000-0000-00000000000c';
const cid2 = 'c2000000-0000-0000-0000-00000000000c';
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

// ── "agora" em BRT, MESMO algoritmo do service — sem mockar Date ──
function brtNowForTest() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  let hh = parseInt(p.hour, 10);
  if (!Number.isFinite(hh) || hh === 24) hh = 0;
  const minutes = hh * 60 + parseInt(p.minute, 10);
  const dateStr = `${p.year}-${p.month}-${p.day}`;
  const weekday = new Date(Date.UTC(parseInt(p.year, 10), parseInt(p.month, 10) - 1, parseInt(p.day, 10))).getUTCDay();
  return { dateStr, minutes, weekday };
}
function minutesToHHMM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mi = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

const NOW = brtNowForTest();

// ── Dois horários dentro da janela, sem cruzar a meia-noite ──
//
// 19/08/2026 — o caso de ambiguidade falhava TODA noite entre 23:50 e
// 00:29 BRT, e derrubava o CI de qualquer PR que rodasse nesse intervalo
// (aconteceu duas vezes seguidas num PR que não toca karatê).
//
// Causa: as duas turmas nasciam em `agora - 10` e `agora + 10`, e
// minutesToHHMM faz wrap em 1440. Às 23:55, `+10` virava 00:00 — que o
// serviço lê como 1430 minutos de distância, fora da janela. Sobrava UMA
// turma candidata, então vinha 200 no lugar do 409 esperado. Depois da
// meia-noite o mesmo acontecia com `-10`, para trás.
//
// A correção é do TESTE, não do serviço: o caso quer duas turmas dentro
// da janela, não testar a virada do dia. Perto das bordas as duas vão
// para o mesmo lado — -20/-10 cabem nos 30 min antes, +10/+20 cabem nos
// 60 min depois, e nenhuma das quatro cruza o limite do dia.
//
// O serviço de fato NÃO acha uma turma de 00:00 num check-in às 23:50.
// Isso é bug de produto (turma na virada do dia), registrado à parte —
// não é o que este arquivo cobre.
function doisOffsetsNaJanela(nowMin) {
  if (nowMin + 10 > 1439) return [-20, -10];
  if (nowMin - 10 < 0)    return [10, 20];
  return [-10, 10];
}

// ── GET /dojo/qr ──
describe('F9 — GET /dojo/qr (QR único do dojô)', () => {
  test('Canal A: devolve token SEM aluno embutido (payload só dojo_id)', async () => {
    const res = await request(app).get(`${base}/qr`).set(canalA());
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(db.query).not.toHaveBeenCalled(); // stateless — não toca o banco
    const decoded = svc.verifyQrToken(res.body.token);
    expect(decoded).toEqual({ student_id: null, dojo_id: dojoId });
  });

  test('é o MESMO token a cada chamada (um cartaz só, não gira sozinho)', async () => {
    const r1 = await request(app).get(`${base}/qr`).set(canalA());
    const r2 = await request(app).get(`${base}/qr`).set(canalA());
    expect(r1.body.token).toBe(r2.body.token);
  });

  test('Canal B (portal) → 403 PORTAL_READ_ONLY (imprimir o cartaz é ação do dojô)', async () => {
    const res = await request(app).get(`${base}/qr`).set(canalB());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PORTAL_READ_ONLY');
  });
});

// ── check-in pelo QR único ──
function mockCheckinCommon(enrolledRows, extra) {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/karate_dojo_class_settings/.test(s)) return Promise.resolve({ rows: [{ qr_checkin_enabled: true }] });
    if (/SELECT id, full_name, belt_label FROM karate_dojo_students/.test(s)) {
      // escopo: o SELECT do aluno tem que vir com O MESMO student_id que o
      // corpo do check-in mandou (nunca a constante `sid` cega — comparar
      // contra params[0] prova que o body.student_id chegou até a query).
      if (params[0] !== sid || params[1] !== dojoId) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [{ id: sid, full_name: 'Aluno QR Único', belt_label: 'Roxa' }] });
    }
    if (/JOIN karate_dojo_class_enrollments e ON e\.class_id = c\.id AND e\.student_id/.test(s)) {
      if (params[0] !== dojoId || params[1] !== sid) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: enrolledRows });
    }
    if (extra) {
      const r = extra(s, params);
      if (r) return Promise.resolve(r);
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('F9 — check-in pelo QR único exige student_id no corpo', () => {
  test('sem body.student_id → 422 STUDENT_ID_REQUIRED (sem tocar o banco além do settings)', async () => {
    const token = svc.signDojoQrToken({ dojo_id: dojoId });
    db.query.mockResolvedValueOnce({ rows: [{ qr_checkin_enabled: true }] }); // getSettings
    const res = await request(app).post(`${base}/classes/checkin`).set(canalA()).send({ token });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('STUDENT_ID_REQUIRED');
  });
});

describe('F9 — janela de tolerância (30 min antes / 60 min depois)', () => {
  test('exporta as constantes usadas na janela (não some número mágico)', () => {
    expect(svc.CHECKIN_WINDOW_BEFORE_MIN).toBe(30);
    expect(svc.CHECKIN_WINDOW_AFTER_MIN).toBe(60);
  });

  test('turma agora mesmo (dist 0) → 200, method qr_dojo, already_checked false', async () => {
    const token = svc.signDojoQrToken({ dojo_id: dojoId });
    mockCheckinCommon(
      [{ id: cid1, name: 'Adulto', start_time: minutesToHHMM(NOW.minutes), end_time: null, weekdays: [NOW.weekday] }],
      (s, params) => {
        if (/SELECT present FROM karate_dojo_attendance/.test(s)) return { rows: [] }; // sem presença prévia
        if (/INSERT INTO karate_dojo_attendance/.test(s)) {
          expect(params[0]).toBe(dojoId);
          expect(params[2]).toBe(sid);
          expect(params[4]).toBe('qr_dojo'); // method — distingue do QR pessoal
          return { rows: [] };
        }
        return null;
      }
    );

    const res = await request(app)
      .post(`${base}/classes/checkin`)
      .set(canalA())
      .send({ token, student_id: sid, date: NOW.dateStr });

    expect(res.status).toBe(200);
    expect(res.body.class.id).toBe(cid1);
    expect(res.body.already_checked).toBe(false);
  });

  test('turma 5h fora da janela (mesmo dia da semana) → 409 NO_CLASS_NOW', async () => {
    const token = svc.signDojoQrToken({ dojo_id: dojoId });
    mockCheckinCommon([
      { id: cid1, name: 'Longe da janela', start_time: minutesToHHMM(NOW.minutes + 300), end_time: null, weekdays: [NOW.weekday] },
    ]);

    const res = await request(app)
      .post(`${base}/classes/checkin`)
      .set(canalA())
      .send({ token, student_id: sid, date: NOW.dateStr });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_CLASS_NOW');
    expect(res.body.error).toMatch(/30 min/);
    expect(res.body.error).toMatch(/60 min/);
  });

  test('2 turmas dentro da janela ao mesmo tempo → 409 AMBIGUOUS_CLASS com candidates (não escolhe sozinho)', async () => {
    const token = svc.signDojoQrToken({ dojo_id: dojoId });
    const [offA, offB] = doisOffsetsNaJanela(NOW.minutes);
    mockCheckinCommon([
      { id: cid1, name: 'Infantil', start_time: minutesToHHMM(NOW.minutes + offA), end_time: null, weekdays: [NOW.weekday] },
      { id: cid2, name: 'Adulto', start_time: minutesToHHMM(NOW.minutes + offB), end_time: null, weekdays: [NOW.weekday] },
    ]);

    const res = await request(app)
      .post(`${base}/classes/checkin`)
      .set(canalA())
      .send({ token, student_id: sid, date: NOW.dateStr });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMBIGUOUS_CLASS');
    expect(Array.isArray(res.body.candidates)).toBe(true);
    expect(res.body.candidates).toHaveLength(2);
    expect(res.body.candidates.map((c) => c.id).sort()).toEqual([cid1, cid2].sort());

    // nenhum INSERT de presença aconteceu — a ambiguidade não decide sozinha
    const insertCalls = db.query.mock.calls.filter((c) => /INSERT INTO karate_dojo_attendance/.test(String(c[0])));
    expect(insertCalls).toHaveLength(0);
  });

  test('reenvio com class_id explícito (turma escolhida após AMBIGUOUS_CLASS) ignora a janela', async () => {
    const token = svc.signDojoQrToken({ dojo_id: dojoId });
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/karate_dojo_class_settings/.test(s)) return Promise.resolve({ rows: [{ qr_checkin_enabled: true }] });
      if (/SELECT id, full_name, belt_label FROM karate_dojo_students/.test(s)) {
        return Promise.resolve({ rows: [{ id: sid, full_name: 'Aluno', belt_label: null }] });
      }
      if (/SELECT id, name FROM karate_dojo_classes WHERE id = \$1 AND dojo_id = \$2/.test(s)) {
        if (params[0] !== cid2 || params[1] !== dojoId) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ id: cid2, name: 'Adulto' }] });
      }
      if (/SELECT 1 FROM karate_dojo_class_enrollments WHERE class_id = \$1 AND student_id = \$2/.test(s)) {
        return Promise.resolve({ rows: [{ '?column?': 1 }] });
      }
      if (/SELECT present FROM karate_dojo_attendance/.test(s)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO karate_dojo_attendance/.test(s)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    // start_time nem entra em jogo — o class_id explícito pula a janela.
    const res = await request(app)
      .post(`${base}/classes/checkin`)
      .set(canalA())
      .send({ token, student_id: sid, class_id: cid2, date: NOW.dateStr });

    expect(res.status).toBe(200);
    expect(res.body.class.id).toBe(cid2);
  });

  test('aluno sem NENHUMA matrícula (via QR único) → 409 NOT_ENROLLED, não NO_CLASS_NOW', async () => {
    const token = svc.signDojoQrToken({ dojo_id: dojoId });
    mockCheckinCommon([]);
    const res = await request(app)
      .post(`${base}/classes/checkin`)
      .set(canalA())
      .send({ token, student_id: sid, date: NOW.dateStr });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_ENROLLED');
  });

  test('matriculado, mas turma é de outro dia da semana → 409 NO_CLASS_TODAY', async () => {
    const token = svc.signDojoQrToken({ dojo_id: dojoId });
    const outroDia = (NOW.weekday + 1) % 7;
    mockCheckinCommon([{ id: cid1, name: 'Infantil', start_time: '18:00', end_time: null, weekdays: [outroDia] }]);
    const res = await request(app)
      .post(`${base}/classes/checkin`)
      .set(canalA())
      .send({ token, student_id: sid, date: NOW.dateStr });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_CLASS_TODAY');
  });

  test('token de OUTRO dojô → 403 DOJO_MISMATCH mesmo sendo o QR único', async () => {
    const token = svc.signDojoQrToken({ dojo_id: otherDojo });
    const res = await request(app).post(`${base}/classes/checkin`).set(canalA()).send({ token, student_id: sid });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DOJO_MISMATCH');
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ── regressão: o QR PESSOAL do aluno continua gravando method='qr' ──
describe('F9 — regressão: QR pessoal do aluno não muda de comportamento', () => {
  test('check-in com token pessoal (class_id explícito) grava method "qr" (não "qr_dojo")', async () => {
    const token = svc.signQrToken({ student_id: sid, dojo_id: dojoId });
    let insertedMethod = null;
    db.query.mockImplementation((sql, params) => {
      const s = String(sql);
      if (/karate_dojo_class_settings/.test(s)) return Promise.resolve({ rows: [{ qr_checkin_enabled: true }] });
      if (/SELECT id, full_name, belt_label FROM karate_dojo_students/.test(s)) {
        return Promise.resolve({ rows: [{ id: sid, full_name: 'Aluno', belt_label: null }] });
      }
      if (/SELECT id, name FROM karate_dojo_classes WHERE id = \$1 AND dojo_id = \$2/.test(s)) {
        return Promise.resolve({ rows: [{ id: cid1, name: 'Infantil' }] });
      }
      if (/SELECT 1 FROM karate_dojo_class_enrollments WHERE class_id = \$1 AND student_id = \$2/.test(s)) {
        return Promise.resolve({ rows: [{ '?column?': 1 }] });
      }
      if (/SELECT present FROM karate_dojo_attendance/.test(s)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO karate_dojo_attendance/.test(s)) {
        insertedMethod = params[4];
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`${base}/classes/checkin`)
      .set(canalA())
      .send({ token, class_id: cid1, date: NOW.dateStr });

    expect(res.status).toBe(200);
    expect(insertedMethod).toBe('qr');
  });
});
