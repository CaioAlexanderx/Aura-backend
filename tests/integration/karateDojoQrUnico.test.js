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
    mockCheckinCommon([
      { id: cid1, name: 'Infantil', start_time: minutesToHHMM(NOW.minutes - 10), end_time: null, weekdays: [NOW.weekday] },
      { id: cid2, name: 'Adulto', start_time: minutesToHHMM(NOW.minutes + 10), end_time: null, weekdays: [NOW.weekday] },
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

// ── regressão: a janela NÃO cruza a meia-noite (limite conhecido) ──
//
// 19/08/2026 — FIXA o comportamento atual, não descreve o desejado. Uma
// turma na virada do dia (00:00, ou 23:50 vista do dia seguinte) NÃO é
// encontrada pelo check-in do QR único. Medido antes de decidir: ZERO
// turmas com start_time em 23:xx/00:xx na base inteira e ZERO presenças
// method='qr_dojo' — o caminho com o bug nunca rodou em produção. O
// racional completo (e o que um conserto de verdade exigiria) está no
// bloco CHECKIN_WINDOW_*_MIN em src/services/karateDojoClassService.js.
//
// São DUAS barreiras independentes, e cada uma é pinada no nível em que
// dá pra ser determinística:
//   • a aritmética da janela (minutos lineares 0..1439) — unitária, com
//     `nowMin` explícito: pelo HTTP o "agora" é o relógio do CI e o caso
//     é justamente 23:50, que só existiria 40 min por dia;
//   • o filtro de weekday, que rejeita ANTES da janela sequer rodar —
//     esse é determinístico via HTTP, porque a turma nasce no weekday de
//     AMANHÃ, que nunca é o de hoje, em qualquer horário que o CI rode.
describe('F9 — regressão: janela é linear por data, não cruza a meia-noite', () => {
  test('aritmética: turma 00:00 vs check-in 23:50 fica FORA da janela (1430 min, não 10)', () => {
    const meiaNoite = 0;
    const vinteTresCinquenta = 23 * 60 + 50;

    // O caso do bug, nos dois sentidos.
    expect(svc.inCheckinWindow(meiaNoite, vinteTresCinquenta)).toBe(false);
    expect(svc.inCheckinWindow(vinteTresCinquenta, 10)).toBe(false);

    // Contraprova: dentro do MESMO dia a janela funciona nas duas pontas,
    // então o false acima é a virada do dia — não uma janela quebrada.
    expect(svc.inCheckinWindow(30, 10)).toBe(true);   // 20 min antes  (≤ 30)
    expect(svc.inCheckinWindow(0, 60)).toBe(true);    // 60 min depois (≤ 60)
    expect(svc.inCheckinWindow(0, 61)).toBe(false);   // 61 min depois → fora

    // Turma sem start_time nunca bloqueia (fallback permissivo do F4).
    expect(svc.inCheckinWindow(null, vinteTresCinquenta)).toBe(true);
  });

  // Instantes FIXOS (BRT = UTC-3 o ano todo, sem horário de verão desde
  // 2019 — a conversão é estável). Segunda 17/08/2026 é weekday 1, terça
  // 18/08/2026 é weekday 2.
  const SEG_2350 = new Date('2026-08-18T02:50:00Z'); // 2026-08-17 23:50 BRT (seg)
  const TER_0010 = new Date('2026-08-18T03:10:00Z'); // 2026-08-18 00:10 BRT (ter)
  const SEG = 1;
  const TER = 2;

  async function checkinEm(now, enrolledRows) {
    const token = svc.signDojoQrToken({ dojo_id: dojoId });
    mockCheckinCommon(enrolledRows, (s) => {
      if (/SELECT present FROM karate_dojo_attendance/.test(s)) return { rows: [] };
      if (/INSERT INTO karate_dojo_attendance/.test(s)) return { rows: [] };
      return null;
    });
    // direto no service: `opts.now` é a costura de teste, a rota não passa.
    return svc.checkin(dojoId, { token, student_id: sid }, { now });
  }

  test('CONTROLE: às 23:50, turma de 23:45 no MESMO dia entra na janela (23:50 não é o problema)', async () => {
    const r = await checkinEm(SEG_2350, [
      { id: cid1, name: 'Noturna', start_time: '23:45', end_time: null, weekdays: [SEG] },
    ]);
    expect(r.class.id).toBe(cid1);
    expect(r.date).toBe('2026-08-17'); // data do relógio, e a turma é desse dia
  });

  test('turma de 00:00 (weekday de TERÇA) num check-in às 23:50 de SEGUNDA → 409 NO_CLASS_TODAY', async () => {
    // NÃO é NO_CLASS_NOW: classesEnrolledOnWeekday() descarta a turma no
    // filtro de weekday, ANTES de inCheckinWindow() ser chamada. Ou seja,
    // trocar a janela por distância circular sozinha não mudaria este 409.
    await expect(
      checkinEm(SEG_2350, [{ id: cid1, name: 'Madrugada', start_time: '00:00', end_time: null, weekdays: [TER] }])
    ).rejects.toMatchObject({ status: 409, code: 'NO_CLASS_TODAY' });

    const insertCalls = db.query.mock.calls.filter((c) => /INSERT INTO karate_dojo_attendance/.test(String(c[0])));
    expect(insertCalls).toHaveLength(0);
  });

  test('sentido inverso: turma de 23:50 de SEGUNDA num check-in às 00:10 de TERÇA → 409 NO_CLASS_TODAY', async () => {
    await expect(
      checkinEm(TER_0010, [{ id: cid1, name: 'Noturna', start_time: '23:50', end_time: null, weekdays: [SEG] }])
    ).rejects.toMatchObject({ status: 409, code: 'NO_CLASS_TODAY' });

    const insertCalls = db.query.mock.calls.filter((c) => /INSERT INTO karate_dojo_attendance/.test(String(c[0])));
    expect(insertCalls).toHaveLength(0);
  });

  test('mesmo com o weekday certo, a janela linear rejeita a turma de 00:00 às 23:50 → 409 NO_CLASS_NOW', async () => {
    // Segunda barreira isolada: aqui a turma passa no filtro de weekday
    // (cadastrada na SEGUNDA), então quem rejeita é a aritmética da janela.
    await expect(
      checkinEm(SEG_2350, [{ id: cid1, name: 'Madrugada', start_time: '00:00', end_time: null, weekdays: [SEG] }])
    ).rejects.toMatchObject({ status: 409, code: 'NO_CLASS_NOW' });
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
