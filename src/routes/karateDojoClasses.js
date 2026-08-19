// ============================================================
// AURA DOJÔ — F4: Rotas de turmas, matrículas, presença + check-in QR
// F9: QR Único do dojô (GET /dojo/qr) + janela de tolerância no checkin.
//
// Montado sob /federation/:id (padrão karateDojoStudents/karateDojoBilling).
// Guard: requireDojoAccess (Canal A = conta do dojô; Canal B = portal do
// responsável). REGRA DE CANAL: GET aceita A e B; POST/PATCH/PUT/DELETE
// exigem Canal A — o portal (B) é somente leitura (403 PORTAL_READ_ONLY).
// EXCEÇÃO semântica: POST /dojo/classes/checkin é Canal A (é o DOJÔ
// escaneando o QR — pessoal do aluno ou o único do dojô, F9 — não o
// portal). GET /dojo/qr TAMBÉM é Canal A: imprimir o cartaz único é
// ação do dojô, não do portal do responsável.
//
// Escopo SEMPRE por req.dojoId do guard — nunca do body/query. Defensivo
// 42P01 (migration 246 pendente): GETs de lista devolvem vazio/default +
// schema_pending; writes devolvem 503 SCHEMA_PENDING. F9: defensivo
// também a 23514 (check_violation) em karate_dojo_attendance_method_check
// — acontece se o check-in pelo QR único ('qr_dojo') for usado ANTES da
// migration 268 (que amplia o CHECK) ser aplicada.
//
// ORDEM: rotas LITERais (/settings, /checkin, /qr) ANTES das paramétricas
// (/:cid) — convenção do repo (o Express casa na ordem de registro).
//
//   GET/PUT  /federation/:id/dojo/classes/settings                (toggle QR)
//   POST     /federation/:id/dojo/classes/checkin                 (QR — Canal A)
//   GET      /federation/:id/dojo/qr                              (F9 — QR único do dojô, Canal A)
//   GET/POST /federation/:id/dojo/classes
//   PATCH/DELETE /federation/:id/dojo/classes/:cid                (DELETE c/ presença → 409 HAS_HISTORY)
//   GET      /federation/:id/dojo/classes/:cid/students
//   POST     /federation/:id/dojo/classes/:cid/enroll             (409 ALREADY_ENROLLED / 422 inativo)
//   DELETE   /federation/:id/dojo/classes/:cid/enroll/:studentId  (presenças ficam)
//   GET/PUT  /federation/:id/dojo/classes/:cid/attendance         (?date=YYYY-MM-DD / upsert em lote)
//   GET      /federation/:id/dojo/students/:sid/attendance-summary
//   GET      /federation/:id/dojo/students/:sid/qr                (token stateless, F4 — QR pessoal)
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const svc = require('../services/karateDojoClassService');

// Canal B (portal) é SOMENTE LEITURA — alterar turma/presença exige a conta
// do dojô (Canal A).
function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal do dojô é somente leitura. Entre com a conta do dojô para alterar dados.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

function handleWriteError(res, e, ctx) {
  if (e && e.status) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    // F9: 409 AMBIGUOUS_CLASS carrega as turmas candidatas — o front
    // pergunta ao aluno/operador qual delas, nunca escolhe sozinho.
    if (e.candidates) body.candidates = e.candidates;
    return res.status(e.status).json(body);
  }
  if (e && e.code === '42P01') {
    return res.status(503).json({ error: 'Turmas do dojô ainda não disponíveis (migration 246 pendente)', code: 'SCHEMA_PENDING' });
  }
  // F9: check-in pelo QR único grava method='qr_dojo'; se a migration 268
  // (que amplia o CHECK de attendance.method) ainda não foi aplicada, o
  // INSERT viola a constraint — devolve SCHEMA_PENDING em vez de vazar
  // erro de banco (mesmo racional do 42P01 acima).
  if (e && e.code === '23514' && /karate_dojo_attendance_method_check/.test(String(e.constraint || e.message || ''))) {
    return res.status(503).json({ error: 'Check-in pelo QR único do dojô ainda não disponível (migration 268 pendente)', code: 'SCHEMA_PENDING' });
  }
  console.error(`[karateDojoClasses] ${ctx}:`, e.message);
  return res.status(500).json({ error: 'Erro interno' });
}

// ── Toggle do check-in por QR (literal — ANTES de /classes/:cid) ──
router.get('/dojo/classes/settings', requireDojoAccess, async (req, res) => {
  try {
    const cfg = await svc.getSettings(req.dojoId);
    return res.json(cfg);
  } catch (e) {
    // A faixa de horário é constante do código, não depende da migration —
    // vai junto mesmo no fallback pro front não ficar sem a dica.
    if (e && e.code === '42P01') {
      return res.json({ qr_checkin_enabled: false, class_start_time_range: svc.CLASS_START_TIME_RANGE });
    }
    console.error('[karateDojoClasses] get settings:', e.message);
    return res.status(500).json({ error: 'Erro ao obter configuração de check-in' });
  }
});

router.put('/dojo/classes/settings', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const cfg = await svc.putSettings(req.dojoId, req.body || {});
    return res.json(cfg);
  } catch (e) {
    return handleWriteError(res, e, 'put settings');
  }
});

// ── Check-in por QR (Canal A — o dojô escaneando; literal ANTES de /:cid) ──
// Aceita os DOIS formatos de token (mesma assinatura): QR pessoal do
// aluno (F4) e QR único do dojô (F9, exige body.student_id).
router.post('/dojo/classes/checkin', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.checkin(req.dojoId, req.body || {});
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'checkin');
  }
});

// ── F9: QR ÚNICO do dojô (literal — ANTES de /:cid) ──
// Stateless (não toca o banco) — sempre o MESMO token pro mesmo dojô, o
// sensei imprime o cartaz uma vez. Canal A: gerar/reimprimir o cartaz único
// é ação do dojô, o portal do responsável não precisa disso.
router.get('/dojo/qr', requireDojoAccess, requireChannelA, (req, res) => {
  return res.json(svc.getDojoQrToken(req.dojoId));
});

// ── Turmas ──
router.get('/dojo/classes', requireDojoAccess, async (req, res) => {
  try {
    const data = await svc.listClasses(req.dojoId);
    return res.json({ data, count: data.length });
  } catch (e) {
    if (e && e.code === '42P01') return res.json({ data: [], count: 0, schema_pending: true });
    console.error('[karateDojoClasses] list classes:', e.message);
    return res.status(500).json({ error: 'Erro ao listar turmas' });
  }
});

router.post('/dojo/classes', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateClassPayload(req.body, { partial: false });
  if (errors.length) return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  try {
    const klass = await svc.createClass(req.dojoId, data);
    return res.status(201).json(klass);
  } catch (e) {
    return handleWriteError(res, e, 'create class');
  }
});

router.patch('/dojo/classes/:cid', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateClassPayload(req.body, { partial: true });
  if (errors.length) return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  try {
    const klass = await svc.updateClass(req.dojoId, req.params.cid, data);
    return res.json(klass);
  } catch (e) {
    return handleWriteError(res, e, 'update class');
  }
});

router.delete('/dojo/classes/:cid', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.deleteClass(req.dojoId, req.params.cid);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'delete class');
  }
});

// ── Matrículas ──
router.get('/dojo/classes/:cid/students', requireDojoAccess, async (req, res) => {
  try {
    const data = await svc.listClassStudents(req.dojoId, req.params.cid);
    return res.json({ data, count: data.length });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
    if (e && e.code === '42P01') return res.json({ data: [], count: 0, schema_pending: true });
    console.error('[karateDojoClasses] class students:', e.message);
    return res.status(500).json({ error: 'Erro ao listar alunos da turma' });
  }
});

router.post('/dojo/classes/:cid/enroll', requireDojoAccess, requireChannelA, async (req, res) => {
  const studentId = req.body && req.body.student_id != null ? String(req.body.student_id).trim() : '';
  if (!studentId) return res.status(422).json({ error: 'student_id é obrigatório', code: 'VALIDATION_ERROR' });
  try {
    const result = await svc.enrollStudent(req.dojoId, req.params.cid, studentId);
    return res.status(201).json(result);
  } catch (e) {
    return handleWriteError(res, e, 'enroll');
  }
});

router.delete('/dojo/classes/:cid/enroll/:studentId', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.unenrollStudent(req.dojoId, req.params.cid, req.params.studentId);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'unenroll');
  }
});

// ── Presença ──
router.get('/dojo/classes/:cid/attendance', requireDojoAccess, async (req, res) => {
  try {
    const date = req.query.date != null && String(req.query.date).trim() !== '' ? String(req.query.date).trim() : null;
    const result = await svc.getAttendance(req.dojoId, req.params.cid, date);
    return res.json(result);
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
    if (e && e.code === '42P01') return res.json({ date: null, data: [], schema_pending: true });
    console.error('[karateDojoClasses] get attendance:', e.message);
    return res.status(500).json({ error: 'Erro ao obter presença' });
  }
});

router.put('/dojo/classes/:cid/attendance', requireDojoAccess, requireChannelA, async (req, res) => {
  const b = req.body || {};
  try {
    const result = await svc.putAttendance(req.dojoId, req.params.cid, b.date, b.records);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'put attendance');
  }
});

// ── Resumo de presença por aluno + QR do aluno ──
router.get('/dojo/students/:sid/attendance-summary', requireDojoAccess, async (req, res) => {
  try {
    const result = await svc.getAttendanceSummary(req.dojoId, req.params.sid);
    return res.json(result);
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
    if (e && e.code === '42P01') {
      return res.json({ total_present: 0, present_30d: 0, present_90d: 0, by_class: [], recent: [], schema_pending: true });
    }
    console.error('[karateDojoClasses] attendance summary:', e.message);
    return res.status(500).json({ error: 'Erro ao obter resumo de presença' });
  }
});

router.get('/dojo/students/:sid/qr', requireDojoAccess, async (req, res) => {
  try {
    const result = await svc.getStudentQrToken(req.dojoId, req.params.sid);
    return res.json(result);
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
    if (e && e.code === '42P01') return res.status(503).json({ error: 'Alunos do dojô ainda não disponíveis (migration 246 pendente)', code: 'SCHEMA_PENDING' });
    console.error('[karateDojoClasses] student qr:', e.message);
    return res.status(500).json({ error: 'Erro ao gerar QR do aluno' });
  }
});

module.exports = router;
