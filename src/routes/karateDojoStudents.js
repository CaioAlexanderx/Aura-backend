// ============================================================
// AURA DOJÔ — F2: Alunos do dojô (registro PRÓPRIO) + responsáveis
//
// Montado sob /federation/:id (padrão karateDojoPractitionerRequests).
// Guard: requireDojoAccess (Canal A = JWT de acesso com dojo_id; Canal B =
// token do portal). REGRA DE CANAL: GETs aceitam A e B; POST/PATCH/DELETE
// exigem Canal A — o portal (B) é somente leitura (403 PORTAL_READ_ONLY).
//
// DECISÃO CENTRAL (F2): o aluno do dojô é registro PRÓPRIO
// (karate_dojo_students, migration 242) — NUNCA escreve em
// karate_practitioners/customers (federação).
//
// F5a (26/07/2026): o SENSEI declara se o aluno é FEDERADO e a FEDERAÇÃO
// confirma. practitioner_id deixou de ser "vínculo futuro" — ele é gravado
// pelo /federate (número FPKT já existente) ou pela aprovação da
// solicitação H1. Continua valendo que estas rotas NÃO escrevem em
// karate_practitioners/customers: elas só gravam a referência no ALUNO.
//
// Escopo SEMPRE por req.dojoId do guard — nunca do body/query.
// Defensivo 42P01 (migration 242 pendente): GETs de lista devolvem vazio +
// schema_pending; writes e ficha devolvem 503 SCHEMA_PENDING.
//
//   GET    /federation/:id/dojo/students             (?status=&q=&belt=&federated=&summary=1)
//   POST   /federation/:id/dojo/students             (422 inválido / menor sem responsável)
//   POST   /federation/:id/dojo/students/import      ({rows:[...]}, máx 500)
//   GET    /federation/:id/dojo/students/:sid        (ficha + responsável)
//   PATCH  /federation/:id/dojo/students/:sid
//   DELETE /federation/:id/dojo/students/:sid        (delete real por ora; F3 → 409 HAS_HISTORY)
//   POST   /federation/:id/dojo/students/:sid/federate    (F5a — Canal A)
//   DELETE /federation/:id/dojo/students/:sid/federate    (F5a — Canal A)
//   GET    /federation/:id/dojo/guardians            (+ contagem de alunos vinculados)
//   POST   /federation/:id/dojo/guardians
//   PATCH  /federation/:id/dojo/guardians/:gid
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const svc = require('../services/karateDojoStudentService');
const { isDojoLinked } = require('../services/karateDojoLinkStatus');

// Canal B (portal do dojô) é SOMENTE LEITURA: o portal existe para
// consulta; alteração de cadastro exige a conta do dojô (Canal A).
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
    // Ficha da solicitação H1 devolve a lista completa de campos faltando.
    if (e.errors) body.errors = e.errors;
    return res.status(e.status).json(body);
  }
  if (e && e.code === '23505') {
    // UNIQUE parcial (dojo_id, cpf) — migration 242
    return res.status(409).json({ error: 'Já existe um aluno com este CPF neste dojô', code: 'DUPLICATE_CPF' });
  }
  if (e && e.code === '42P01') {
    return res.status(503).json({ error: 'Alunos do dojô ainda não disponíveis (migration 242 pendente)', code: 'SCHEMA_PENDING' });
  }
  console.error(`[karateDojoStudents] ${ctx}:`, e.message);
  return res.status(500).json({ error: 'Erro interno' });
}

// ?federated=true|false — ausente/inválido = TODOS (nunca filtra por
// engano: "dado faltante ≠ pendência" vale também para filtro de query).
function parseFederatedFilter(raw) {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}

// ── GET /federation/:id/dojo/students ──
router.get('/dojo/students', requireDojoAccess, async (req, res) => {
  try {
    const status = ['active', 'inactive'].includes(req.query.status) ? req.query.status : null;
    const q = req.query.q != null && String(req.query.q).trim() !== '' ? String(req.query.q).trim() : null;
    const belt = req.query.belt != null && String(req.query.belt).trim() !== '' ? String(req.query.belt).trim() : null;
    const federated = parseFederatedFilter(req.query.federated);

    const data = await svc.listStudents(req.dojoId, { status, q, belt, federated });
    const payload = { data, count: data.length };
    if (req.query.summary === '1' || req.query.summary === 'true') {
      payload.summary = await svc.getSummary(req.dojoId);
    }
    return res.json(payload);
  } catch (e) {
    if (e && e.code === '42P01') return res.json({ data: [], count: 0, schema_pending: true });
    console.error('[karateDojoStudents] list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar alunos' });
  }
});

// ── POST /federation/:id/dojo/students ──
router.post('/dojo/students', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateStudentPayload(req.body, { partial: false });
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }
  try {
    const student = await svc.createStudent(req.dojoId, data);
    return res.status(201).json(student);
  } catch (e) {
    return handleWriteError(res, e, 'create student');
  }
});

// ── POST /federation/:id/dojo/students/import ──
// Lote de até 500 linhas JSON já parseadas pelo front. Import é TOLERANTE
// (menor sem responsável entra com warning; campo inválido vira NULL com
// warning; dup de CPF é skipped). Transação única no service.
// Definido ANTES das rotas /:sid (convenção do repo — literal antes de param).
router.post('/dojo/students/import', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.importStudents(req.dojoId, (req.body || {}).rows);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'import students');
  }
});

// ── GET /federation/:id/dojo/students/:sid ──
router.get('/dojo/students/:sid', requireDojoAccess, async (req, res) => {
  try {
    const student = await svc.getStudent(req.dojoId, req.params.sid);
    if (!student) {
      return res.status(404).json({ error: 'Aluno não encontrado neste dojô', code: 'NOT_FOUND' });
    }
    return res.json(student);
  } catch (e) {
    return handleWriteError(res, e, 'get student');
  }
});

// ── PATCH /federation/:id/dojo/students/:sid ──
router.patch('/dojo/students/:sid', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateStudentPayload(req.body, { partial: true });
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }
  try {
    const student = await svc.updateStudent(req.dojoId, req.params.sid, data);
    return res.json(student);
  } catch (e) {
    return handleWriteError(res, e, 'update student');
  }
});

// ── DELETE /federation/:id/dojo/students/:sid ──
// Por ora DELETE REAL (aluno F2 não tem dependências). Quando a F3 criar
// cobranças, deve virar 409 HAS_HISTORY (ver comentário no service).
router.delete('/dojo/students/:sid', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.deleteStudent(req.dojoId, req.params.sid);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'delete student');
  }
});

// ============================================================
// F5a — FEDERAR / DESFEDERAR o aluno
//
// POST /dojo/students/:sid/federate  (Canal A)
//   { fpkt_number }        → o aluno JÁ tem número (outro dojô/carteirinha):
//                            confirma pelo MESMO lookup do H1 e vincula.
//                            200 { linked: true, practitioner, is_transfer }
//                            404 FPKT_NUMBER_NOT_FOUND
//                            409 PRACTITIONER_JA_VINCULADO
//   { request: true, ... }  → o aluno é NOVO na federação: abre a
//                            solicitação H1 (mesma rota/fila de sempre) e
//                            o aluno fica 'pending'.
//                            200 { linked: false, request_id, status }
//                            Repetir devolve a MESMA solicitação (idempotente).
//
// Sempre 200 nos dois caminhos: o front lê `linked`/`status`, não o código
// HTTP, e "já pendente" x "criada agora" são o MESMO estado para o sensei.
// ============================================================
router.post('/dojo/students/:sid/federate', requireDojoAccess, requireChannelA, async (req, res) => {
  const b = req.body || {};

  try {
    // Gate de conexão ANTES de olhar o corpo (mesma decisão do H1, PR #422):
    // federar cria/reivindica algo na FEDERAÇÃO — não existe para um dojô
    // que ainda não se conectou. 409 (conflito de ESTADO), nunca 403.
    if (!(await isDojoLinked(req.dojoId))) {
      return res.status(409).json({
        error: 'Conecte seu dojô à federação para federar alunos',
        code: 'DOJO_NAO_CONECTADO',
      });
    }

    const rawNumber = b.fpkt_number != null ? String(b.fpkt_number).trim() : '';
    const wantsRequest = b.request === true || b.request === 'true';

    if (!rawNumber && !wantsRequest) {
      return res.status(422).json({
        error: 'Informe fpkt_number (aluno já federado) ou request: true (solicitar cadastro à federação)',
        code: 'VALIDATION_ERROR',
      });
    }

    const result = rawNumber
      ? await svc.federateStudentByFpktNumber(req.dojoId, req.federationId, req.params.sid, rawNumber)
      : await svc.federateStudentByRequest(req.dojoId, req.federationId, req.params.sid, {
          body: b,
          channel: req.dojoAuthChannel || null,
          actorLabel: (req.user && req.user.email) || null,
        });

    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'federate student');
  }
});

// ── DELETE /federation/:id/dojo/students/:sid/federate ──
// Desvincula: is_federated=false, practitioner_id=NULL.
//
// ⚠️ NÃO apaga NADA em karate_practitioners/customers: o praticante segue
// existindo na FEDERAÇÃO (número, faixa, histórico) — só o dojô deixa de
// reivindicá-lo. Excluir praticante é ato da federação, jamais efeito
// colateral de um clique no portal do dojô.
//
// SEM gate de conexão de propósito: desfazer uma marcação errada é higiene
// do cadastro INTERNO e não pode depender de estar conectado.
router.delete('/dojo/students/:sid/federate', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const result = await svc.unfederateStudent(req.dojoId, req.params.sid);
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'unfederate student');
  }
});

// ── GET /federation/:id/dojo/guardians ──
router.get('/dojo/guardians', requireDojoAccess, async (req, res) => {
  try {
    const data = await svc.listGuardians(req.dojoId);
    return res.json({ data, count: data.length });
  } catch (e) {
    if (e && e.code === '42P01') return res.json({ data: [], count: 0, schema_pending: true });
    console.error('[karateDojoStudents] list guardians error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar responsáveis' });
  }
});

// ── POST /federation/:id/dojo/guardians ──
router.post('/dojo/guardians', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateGuardianPayload(req.body, { partial: false });
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }
  try {
    const guardian = await svc.createGuardian(req.dojoId, data);
    return res.status(201).json(guardian);
  } catch (e) {
    return handleWriteError(res, e, 'create guardian');
  }
});

// ── PATCH /federation/:id/dojo/guardians/:gid ──
router.patch('/dojo/guardians/:gid', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = svc.validateGuardianPayload(req.body, { partial: true });
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }
  try {
    const guardian = await svc.updateGuardian(req.dojoId, req.params.gid, data);
    return res.json(guardian);
  } catch (e) {
    return handleWriteError(res, e, 'update guardian');
  }
});

module.exports = router;
