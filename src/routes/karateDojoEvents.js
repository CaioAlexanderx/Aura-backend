// ============================================================
// AURA DOJÔ — F9: EVENTOS DO DOJÔ (curso + seminário) — rotas
//
// Montado sob /federation/:id (padrão karateDojoStudents / karateDojoBeltExams).
// Guard: requireDojoAccess (Canal A = JWT da conta do dojô com dojo_id;
// Canal B = token do portal). REGRA DE CANAL, a mesma do resto do Aura
// Dojô: GETs aceitam A e B; toda ESCRITA exige Canal A — o portal é
// somente leitura (403 PORTAL_READ_ONLY).
//
//   POST   /federation/:id/dojo/own-events
//   GET    /federation/:id/dojo/own-events                    (?kind=&status=&page=&pageSize=)
//   GET    /federation/:id/dojo/own-events/:eventId
//   PATCH  /federation/:id/dojo/own-events/:eventId            (bloqueado só se cancelado)
//   POST   /federation/:id/dojo/own-events/:eventId/cancel
//   POST   /federation/:id/dojo/own-events/:eventId/enroll     ({student_ids:[uuid]})
//   GET    /federation/:id/dojo/own-events/:eventId/enrollments
//   DELETE /federation/:id/dojo/own-events/:eventId/enrollments/:studentId
//
//   GET    /federation/:id/dojo/events-hub                     (?kind=&page=&pageSize=)
//     — listagem UNIFICADA: eventos próprios (curso/seminário) + exames de
//       kyu (karate_dojo_belt_exams). Ver karateDojoEventService.listEventsHub.
//
// ── POR QUE "own-events" E NÃO "events" ─────────────
// "/dojo/events" (1 segmento) já existe em karateDojo.js — é a VITRINE
// (read-only) dos eventos ABERTOS DA FEDERAÇÃO. E
// "/dojo/events/:eventId/enroll" (3 segmentos) já existe em
// karateDojoFederativo.js — inscrição em lote num evento DA FEDERAÇÃO
// (karate_belt_exams/karate_events, por practitioner_id). Reusar o prefixo
// "events" para o evento PRÓPRIO do dojô colidiria com os dois — mesmo
// motivo que fez o exame de kyu virar "/dojo/graduation-exams" em vez de
// reaproveitar "/dojo/belt-exams" (que já significava o oposto: submeter
// candidato à banca). Prefixo distinto: "/dojo/own-events".
//
// ── SEM GATE DE CONEXÃO, DE PROPÓSITO ─────────────
// Curso e seminário são atos INTERNOS do dojô — o sensei organiza a
// própria turma, não depende de estar conectado à federação (mesma razão
// que fez a 264 deixar karate_dojo_belt_exams.federation_id nullable).
// A rota /events-hub também não gateia: ela só LISTA o que já existe.
//
// dojo_id e federation_id vêm SEMPRE do token (req.dojoId/req.federationId),
// nunca do corpo/query.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const svc = require('../services/karateDojoEventService');

// Canal B (portal) é SOMENTE LEITURA. Checado ANTES de qualquer db.query:
// criar/editar evento é ato do dono da conta e o motivo do 403 não
// depende de estado nenhum do banco.
function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal do dojô é somente leitura. Entre com a conta do dojô para criar ou editar eventos.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

function actor(req) {
  return {
    createdBy: (req.user && req.user.id) || null,
    createdByName: (req.user && (req.user.name || req.user.email)) || null,
  };
}

// ── Mapeamento de erro (mesma régua de karateDojoBeltExams.js) ──
function handleWriteError(res, e, ctx) {
  if (e && e.status) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    if (e.errors) body.errors = e.errors;
    return res.status(e.status).json(body);
  }
  if (e && (e.code === '42P01' || e.code === 'TABLE_MISSING')) {
    console.error(`[karateDojoEvents] ${ctx}: SCHEMA_PENDING (${e.code}):`, e.message);
    return res.status(503).json({
      error: 'Eventos do dojô indisponíveis no momento (migration 269 pendente)',
      code: 'SCHEMA_PENDING',
      pg_code: '42P01',
    });
  }
  if (e && e.code === '42703') {
    console.error(
      `[karateDojoEvents] ${ctx}: 42703 — consulta cita coluna inexistente (SQL divergente do schema):`,
      e.message
    );
    return res.status(500).json({
      error: 'Falha ao gravar: uma consulta do servidor não bate com o schema do banco. Nada foi registrado.',
      code: 'SQL_SCHEMA_MISMATCH',
      pg_code: '42703',
      detail: e.message,
    });
  }
  console.error(`[karateDojoEvents] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR', pg_code: (e && e.code) || null });
}

// Leitura degrada (lista vazia + schema_pending) em vez de 5xx.
function handleReadError(res, e, ctx, extra) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
  }
  if (e && (e.code === '42P01' || e.code === 'TABLE_MISSING')) {
    console.warn(`[karateDojoEvents] ${ctx}: schema pendente (${e.code}):`, e.message);
    return res.json(Object.assign({ data: [], count: 0, schema_pending: true }, extra || {}));
  }
  if (e && e.code === '42703') {
    console.error(`[karateDojoEvents] ${ctx}: 42703 — SQL divergente do schema:`, e.message);
    return res.json(Object.assign({ data: [], count: 0, schema_pending: true, pg_code: '42703' }, extra || {}));
  }
  console.error(`[karateDojoEvents] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
}

// ============================================================
// 0) A LISTAGEM UNIFICADA (rota ESTÁTICA — /events-hub não colide com
//    /own-events/:eventId porque são prefixos literais distintos, mas
//    fica declarada primeiro por clareza e consistência com o resto do
//    repo: rota estática antes da paramétrica).
// ============================================================
router.get('/dojo/events-hub', requireDojoAccess, async (req, res) => {
  try {
    const out = await svc.listEventsHub(req.dojoId, {
      kind: req.query.kind,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    return res.json(out);
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/events-hub');
  }
});

// ============================================================
// 1) CRUD DO EVENTO
// ============================================================

// ── POST /dojo/own-events ──
// { kind:'curso'|'seminario', name, event_date, location?, fee_amount?,
//   max_participants?, hours?, description? } → 201 { event }
router.post('/dojo/own-events', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const event = await svc.createEvent({
      dojoId: req.dojoId,
      federationId: req.federationId,
      body: req.body,
      ...actor(req),
    });
    return res.status(201).json({ event });
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/own-events');
  }
});

// ── GET /dojo/own-events ──
router.get('/dojo/own-events', requireDojoAccess, async (req, res) => {
  try {
    const out = await svc.listEvents(req.dojoId, {
      kind: req.query.kind,
      status: req.query.status,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    return res.json({ data: out.data, count: out.data.length, page: out.page, pageSize: out.pageSize });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/own-events');
  }
});

// ── GET /dojo/own-events/:eventId ──
router.get('/dojo/own-events/:eventId', requireDojoAccess, async (req, res) => {
  try {
    const out = await svc.getEvent({ dojoId: req.dojoId, eventId: req.params.eventId });
    return res.json({ event: out.event, enrollments: out.enrollments, count: out.enrollments.length });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/own-events/:eventId', { event: null, enrollments: [] });
  }
});

// ── PATCH /dojo/own-events/:eventId ── (bloqueado só se cancelado)
router.patch('/dojo/own-events/:eventId', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const out = await svc.updateEvent({ dojoId: req.dojoId, eventId: req.params.eventId, body: req.body });
    return res.json({ event: out.event, enrollments: out.enrollments, count: out.enrollments.length });
  } catch (e) {
    return handleWriteError(res, e, 'PATCH /dojo/own-events/:eventId');
  }
});

// ── POST /dojo/own-events/:eventId/cancel ──
router.post('/dojo/own-events/:eventId/cancel', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const out = await svc.cancelEvent({ dojoId: req.dojoId, eventId: req.params.eventId });
    return res.json({ event: out.event, enrollments: out.enrollments, count: out.enrollments.length });
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/own-events/:eventId/cancel');
  }
});

// ============================================================
// 2) INSCRIÇÃO EM LOTE
// ============================================================

// ── POST /dojo/own-events/:eventId/enroll ──
// { student_ids: [uuid] } → 200 { enrolled, enrollments, event, skipped }
router.post('/dojo/own-events/:eventId/enroll', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.enrollBatch({
      dojoId: req.dojoId,
      eventId: req.params.eventId,
      studentIds: (req.body || {}).student_ids,
    });
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/own-events/:eventId/enroll');
  }
});

// ── GET /dojo/own-events/:eventId/enrollments ──
router.get('/dojo/own-events/:eventId/enrollments', requireDojoAccess, async (req, res) => {
  try {
    const out = await svc.listEnrollments({ dojoId: req.dojoId, eventId: req.params.eventId });
    return res.json({ event: out.event, data: out.data, count: out.data.length });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/own-events/:eventId/enrollments', { event: null });
  }
});

// ── DELETE /dojo/own-events/:eventId/enrollments/:studentId ──
router.delete(
  '/dojo/own-events/:eventId/enrollments/:studentId',
  requireDojoAccess,
  requireChannelA,
  async (req, res) => {
    try {
      const out = await svc.unenroll({
        dojoId: req.dojoId,
        eventId: req.params.eventId,
        studentId: req.params.studentId,
      });
      return res.json(out);
    } catch (e) {
      return handleWriteError(res, e, 'DELETE /dojo/own-events/:eventId/enrollments/:studentId');
    }
  }
);

module.exports = router;
