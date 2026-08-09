// ============================================================
// AURA DOJÔ — F11: Tags configuráveis do aluno (migration 274)
//
// Montado sob /federation/:id (padrão karateDojoStudents/karateDojoClasses).
// Guard: requireDojoAccess (Canal A = JWT de acesso com dojo_id; Canal B =
// token do portal). REGRA DE CANAL: GETs aceitam A e B; POST/PATCH/DELETE
// exigem Canal A — o portal (B) é somente leitura (403 PORTAL_READ_ONLY).
//
// Tag ≠ turma (karate_dojo_classes, migration 246): turma tem dia/horário
// e controla presença; tag é rótulo livre, sem horário. As duas coexistem.
//
// Escopo SEMPRE por req.dojoId do guard — nunca do body/query. Defensivo
// 42P01 (migration 274 pendente): GET de lista devolve vazio +
// schema_pending; escrita devolve 503 SCHEMA_PENDING.
//
//   GET    /federation/:id/dojo/tags                     (?active=)
//   POST   /federation/:id/dojo/tags                     ({name, color?})
//   PATCH  /federation/:id/dojo/tags/:tid                 ({name?, color?, active?})
//   DELETE /federation/:id/dojo/tags/:tid                 (409 TAG_EM_USO se houver vínculo)
//   GET    /federation/:id/dojo/students/:sid/tags
//   POST   /federation/:id/dojo/students/:sid/tags        ({tag_id})
//   DELETE /federation/:id/dojo/students/:sid/tags/:tid
//
// Filtro na listagem de alunos (?tag_id=) vive em karateDojoStudents.js /
// karateDojoStudentService.js — não duplicado aqui.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const svc = require('../services/karateDojoTagService');

// Canal B (portal do dojô) é SOMENTE LEITURA — mesma regra de
// karateDojoStudents.js/karateDojoClasses.js.
function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal do dojô é somente leitura. Entre com a conta do dojô para alterar dados.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

function handleError(res, e, ctx) {
  if (e && e.status) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    if (e.errors) body.errors = e.errors;
    return res.status(e.status).json(body);
  }
  if (e && e.code === '23505') {
    return res.status(409).json({ error: 'Já existe uma tag com este nome neste dojô', code: 'DUPLICATE_TAG_NAME' });
  }
  if (e && e.code === '42P01') {
    return res.status(503).json({ error: 'Tags do dojô ainda não disponíveis (migration 274 pendente)', code: 'SCHEMA_PENDING' });
  }
  console.error(`[karateDojoTags] ${ctx}:`, e.message);
  return res.status(500).json({ error: 'Erro interno' });
}

// ── GET /federation/:id/dojo/tags ──
router.get('/dojo/tags', requireDojoAccess, async (req, res) => {
  try {
    const active = svc.parseActiveFilter(req.query.active);
    const data = await svc.listTags(req.dojoId, { active });
    return res.json({ data, count: data.length });
  } catch (e) {
    if (e && e.code === '42P01') return res.json({ data: [], count: 0, schema_pending: true });
    console.error('[karateDojoTags] list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar tags' });
  }
});

// ── POST /federation/:id/dojo/tags ──
router.post('/dojo/tags', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateTagPayload(req.body, { partial: false });
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }
  try {
    const tag = await svc.createTag(req.dojoId, data);
    return res.status(201).json(tag);
  } catch (e) {
    return handleError(res, e, 'create tag');
  }
});

// ── PATCH /federation/:id/dojo/tags/:tid ──
// Cobre renomear (name), cor (color) e desativar/reativar (active) — o
// mesmo endpoint faz as 3 operações de CRUD que faltam além de criar.
router.patch('/dojo/tags/:tid', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateTagPayload(req.body, { partial: true });
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }
  try {
    const tag = await svc.updateTag(req.dojoId, req.params.tid, data);
    return res.json(tag);
  } catch (e) {
    return handleError(res, e, 'update tag');
  }
});

// ── DELETE /federation/:id/dojo/tags/:tid ──
// Só apaga de verdade quando a tag nunca foi usada (ver comentário no
// service). Em uso: 409 TAG_EM_USO — use PATCH {active:false}.
router.delete('/dojo/tags/:tid', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.deleteTag(req.dojoId, req.params.tid);
    return res.json(result);
  } catch (e) {
    return handleError(res, e, 'delete tag');
  }
});

// ── GET /federation/:id/dojo/students/:sid/tags ──
router.get('/dojo/students/:sid/tags', requireDojoAccess, async (req, res) => {
  try {
    const data = await svc.listStudentTags(req.dojoId, req.params.sid);
    return res.json({ data, count: data.length });
  } catch (e) {
    return handleError(res, e, 'list student tags');
  }
});

// ── POST /federation/:id/dojo/students/:sid/tags ──
// Body: { tag_id }. Bloqueia atribuir tag desativada (422 TAG_INATIVA).
router.post('/dojo/students/:sid/tags', requireDojoAccess, requireChannelA, async (req, res) => {
  const tagId = req.body && req.body.tag_id != null ? String(req.body.tag_id).trim() : '';
  if (!tagId) {
    return res.status(422).json({ error: 'Campo tag_id é obrigatório', code: 'VALIDATION_ERROR' });
  }
  try {
    const data = await svc.assignTag(req.dojoId, req.params.sid, tagId);
    return res.status(201).json({ data, count: data.length });
  } catch (e) {
    return handleError(res, e, 'assign tag');
  }
});

// ── DELETE /federation/:id/dojo/students/:sid/tags/:tid ──
router.delete('/dojo/students/:sid/tags/:tid', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const data = await svc.removeTagFromStudent(req.dojoId, req.params.sid, req.params.tid);
    return res.json({ data, count: data.length });
  } catch (e) {
    return handleError(res, e, 'remove tag');
  }
});

module.exports = router;
