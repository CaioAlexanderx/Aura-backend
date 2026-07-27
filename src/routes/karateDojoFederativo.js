// ============================================================
// AURA DOJÔ — F5b: as TRÊS TROCAS FEDERATIVAS (rotas)
//
// Montado sob /federation/:id (padrão karateDojoStudents/karateDojoConnection).
// Guard: requireDojoAccess (Canal A = JWT da conta do dojô com dojo_id;
// Canal B = token do portal). REGRA DE CANAL: GETs aceitam A e B; POSTs
// exigem Canal A — o portal é somente leitura (403 PORTAL_READ_ONLY).
//
//   GET  /federation/:id/dojo/aptos
//   POST /federation/:id/dojo/cert-orders                   {items:[...]}
//   GET  /federation/:id/dojo/cert-orders?status=&page=&pageSize=
//   POST /federation/:id/dojo/events/:eventId/enroll        {student_ids:[...]}
//   GET  /federation/:id/dojo/events/:eventId/enrollments
//   POST /federation/:id/dojo/belt-exams/:examId/candidates {student_ids:[...]}
//   GET  /federation/:id/dojo/belt-exams/:examId/candidates
//
// ── GATE DE CONEXÃO EM TODAS AS ROTAS ──────────────────────
// Toda rota desta fase é FEDERATIVA: certificado é emitido PELA federação,
// evento é DA federação, exame é julgado pela BANCA. Nenhuma delas existe
// para um dojô que ainda não se conectou → 409 DOJO_NAO_CONECTADO
// (conflito de ESTADO, nunca 403: não falta permissão, falta conexão).
//
// ⚠️ Divergência DELIBERADA de GET /dojo/events (karateDojo.js), que devolve
// 200 vazio + not_linked:true. Aquela rota é a VITRINE: o front precisa
// distinguir "sem eventos" de "não conectado" para escolher a tela, e um
// 409 viraria erro genérico. Estas aqui são ATOS (e listas de atos): um 200
// vazio esconderia o motivo real de nada estar acontecendo, que é exatamente
// o buraco de QA que o gate de conexão nasceu para fechar.
//
// ── O DOJÔ NUNCA GRADUA ─────────────────────────────────
// POST /belt-exams/:examId/candidates SUBMETE candidatos — status
// 'registered'. Quem lança resultado é a banca, pela rota da FEDERAÇÃO
// (karateExams.js PATCH /belt-exams/:examId/candidates/:candidateId,
// guards.examResults). Nenhuma rota deste arquivo escreve em
// karate_belt_history nem em karate_exam_results.
//
// dojo_id e federation_id vêm SEMPRE do token (req.dojoId/req.federationId),
// nunca do corpo/query.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const { isDojoLinked } = require('../services/karateDojoLinkStatus');
const svc = require('../services/karateDojoFederativeService');

// Canal B (portal) é SOMENTE LEITURA. Checado ANTES do gate de conexão e de
// qualquer db.query: pedir certificado/inscrever aluno é ato do dono da
// conta, e o motivo do 403 não depende de estado nenhum do banco.
function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal do dojô é somente leitura. Entre com a conta do dojô para solicitar certificados ou inscrever alunos.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

// isDojoLinked é fail-open por decisão (ver karateDojoLinkStatus.js): coluna
// ausente / falha transitória devolve linked:true. Aqui não há try/catch
// justamente porque ele não lança — engolir erro aqui esconderia bug nosso.
async function requireDojoLinked(req, res, next) {
  if (!(await isDojoLinked(req.dojoId))) {
    return res.status(409).json({
      error: 'Conecte seu dojô à federação para usar certificados, inscrições e exames',
      code: 'DOJO_NAO_CONECTADO',
    });
  }
  return next();
}

// ── Mapeamento de erro: TABELA ausente ≠ COLUNA ausente ──────
//
// ⚠️ P0 27/07/2026. A versão anterior jogava 42P01 E 42703 no MESMO balde
// 503 SCHEMA_PENDING, sem NENHUM log. Resultado: uma SQL nossa que citava
// uma coluna inexistente (karateCertificateService.createOrder, ver o
// comentário lá) devolvia "indisponível no momento" — mensagem que diz ao
// operador para esperar uma migration que nunca viria, ao front que não é
// erro dele, e ao log absolutamente nada. O pedido de certificado ficou
// morto em produção e o console do navegador ficou limpo.
//
// Regra nova:
//   42P01 / TABLE_MISSING → a RELAÇÃO não existe. Isso é migration pendente
//     de verdade (o deploy pode ir à frente do banco). 503, retentável.
//   42703 → a coluna não existe numa tabela que EXISTE. Neste repo toda
//     coluna nasce em migration numerada junto com o código que a usa;
//     quando falta, quase sempre é a NOSSA SQL divergindo do schema. Os
//     poucos casos legítimos de coluna pendente (registration_responses da
//     migr. 200, karate_current_belt da 229) já degradam DENTRO do service.
//     Então aqui é erro real: 500 + código próprio + o texto do Postgres.
// Em qualquer caminho: SEMPRE console.error. Erro de escrita silencioso foi
// a causa de o P0 sobreviver a um QA inteiro.
function handleWriteError(res, e, ctx) {
  if (e && e.status) {
    const body = { error: e.message, code: e.code || 'ERROR' };
    if (e.errors) body.errors = e.errors;
    return res.status(e.status).json(body);
  }
  if (e && (e.code === '42P01' || e.code === 'TABLE_MISSING')) {
    console.error(`[karateDojoFederativo] ${ctx}: SCHEMA_PENDING (${e.code}):`, e.message);
    return res.status(503).json({
      error: 'Recurso federativo indisponível no momento (schema pendente)',
      code: 'SCHEMA_PENDING',
      pg_code: '42P01',
    });
  }
  if (e && e.code === '42703') {
    console.error(
      `[karateDojoFederativo] ${ctx}: 42703 — consulta cita coluna inexistente (SQL divergente do schema):`,
      e.message
    );
    return res.status(500).json({
      error: 'Falha ao gravar: uma consulta do servidor não bate com o schema do banco. O pedido NÃO foi registrado.',
      code: 'SQL_SCHEMA_MISMATCH',
      pg_code: '42703',
      detail: e.message,
    });
  }
  console.error(`[karateDojoFederativo] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({
    error: 'Erro interno',
    code: 'INTERNAL_ERROR',
    pg_code: (e && e.code) || null,
  });
}

// Erro de LEITURA: degrada (lista vazia + schema_pending) em vez de 5xx —
// uma tela em branco com aviso é melhor que um erro vermelho quando o
// único problema é uma migration ainda não aplicada.
//
// A degradação FICA (é decisão de UX), mas nunca mais é silenciosa: 42703
// numa leitura é o mesmo cheiro de SQL divergente do schema e vai para o
// log como console.error, com o texto do Postgres.
function handleReadError(res, e, ctx, extra) {
  if (e && e.status) {
    return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
  }
  if (e && (e.code === '42P01' || e.code === 'TABLE_MISSING')) {
    console.warn(`[karateDojoFederativo] ${ctx}: schema pendente (${e.code}):`, e.message);
    return res.json(Object.assign({ data: [], count: 0, schema_pending: true }, extra || {}));
  }
  if (e && e.code === '42703') {
    console.error(
      `[karateDojoFederativo] ${ctx}: 42703 — consulta cita coluna inexistente (SQL divergente do schema):`,
      e.message
    );
    return res.json(
      Object.assign({ data: [], count: 0, schema_pending: true, pg_code: '42703' }, extra || {})
    );
  }
  console.error(`[karateDojoFederativo] ${ctx}:`, e && e.code, e && e.message);
  return res.status(500).json({ error: 'Erro interno', code: 'INTERNAL_ERROR' });
}

function actor(req) {
  return {
    createdBy: (req.user && req.user.id) || null,
    createdByName: (req.user && (req.user.name || req.user.email)) || null,
  };
}

// ============================================================
// 1) CERTIFICADOS
// ============================================================

// ── GET /federation/:id/dojo/aptos ──────────────────────────
// Graduações de alunos FEDERADOS deste dojô que ainda não têm pedido de
// certificado. A unidade é a GRADUAÇÃO (ver decisão no service): o mesmo
// aluno pode aparecer 2x se subiu 2 faixas e só pediu 1 certificado.
router.get('/dojo/aptos', requireDojoAccess, requireDojoLinked, async (req, res) => {
  try {
    const data = await svc.listAptos(req.dojoId, req.federationId);
    return res.json({ data, count: data.length });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/aptos');
  }
});

// ── POST /federation/:id/dojo/cert-orders ─────────────────────
// { items: [{ student_id, belt_history_id? }], delivery_type?, addr_*?, observacao? }
// 200 { created, orders, skipped:[{student_id, reason, message}] }
//
// Sempre 200 (mesmo com created:0): um lote parcial NÃO é erro — o front
// mostra quem entrou e por que cada um ficou de fora. Erro só quando NADA
// pôde ser avaliado (corpo inválido → 422, tabela ausente → 503, SQL
// divergente do schema → 500 SQL_SCHEMA_MISMATCH).
router.post('/dojo/cert-orders', requireDojoAccess, requireChannelA, requireDojoLinked, async (req, res) => {
  const b = req.body || {};
  try {
    const result = await svc.createCertOrdersBatch({
      dojoId: req.dojoId,
      federationId: req.federationId,
      items: b.items,
      delivery: {
        delivery_type: b.delivery_type,
        addr_cep: b.addr_cep,
        addr_logradouro: b.addr_logradouro,
        addr_numero: b.addr_numero,
        addr_complemento: b.addr_complemento,
        addr_cidade: b.addr_cidade,
        observacao: b.observacao,
      },
      ...actor(req),
    });
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/cert-orders');
  }
});

// ── GET /federation/:id/dojo/cert-orders ──────────────────────
// Pedidos DESTE dojô com o status atualizado pela federação
// (requested→in_production→printed→shipped | refused). Reuso puro de
// getOrdersByDojo — a novidade é o CANAL (token do dojô), não a query.
router.get('/dojo/cert-orders', requireDojoAccess, requireDojoLinked, async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : undefined;
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize, 10) || 50, 200);
    const data = await svc.listCertOrders(req.dojoId, req.federationId, { status, page, pageSize });
    return res.json({ data, count: data.length, page, pageSize });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/cert-orders');
  }
});

// ============================================================
// 2) INSCRIÇÃO EM LOTE EM EVENTOS
// ============================================================

// ── POST /federation/:id/dojo/events/:eventId/enroll ─────────────
// { student_ids: [uuid] } → 200 { enrolled, enrollments, event, skipped }
// Idempotente: reinscrever devolve JA_INSCRITO e não duplica (dup check +
// UNIQUE como rede de segurança).
//
// ⚠️ 3 segmentos (/events/:eventId/enroll) — não colide com o GET
// /dojo/events (1 segmento) de karateDojo.js.
router.post('/dojo/events/:eventId/enroll', requireDojoAccess, requireChannelA, requireDojoLinked, async (req, res) => {
  try {
    const result = await svc.enrollBatch({
      dojoId: req.dojoId,
      federationId: req.federationId,
      eventId: req.params.eventId,
      studentIds: (req.body || {}).student_ids,
      mode: 'event',
    });
    return res.json(result);
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/events/:eventId/enroll');
  }
});

// ── GET /federation/:id/dojo/events/:eventId/enrollments ─────────
router.get('/dojo/events/:eventId/enrollments', requireDojoAccess, requireDojoLinked, async (req, res) => {
  try {
    const out = await svc.listEnrollments({
      dojoId: req.dojoId,
      federationId: req.federationId,
      eventId: req.params.eventId,
      mode: 'event',
    });
    return res.json({ event: out.event, data: out.data, count: out.data.length });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/events/:eventId/enrollments', { event: null });
  }
});

// ============================================================
// 3) CANDIDATOS A EXAME DE FAIXA
// ============================================================

// ── POST /federation/:id/dojo/belt-exams/:examId/candidates ──────
// { student_ids: [uuid] } → 200 { submitted, candidates, event, skipped }
// O dojô SUBMETE; a banca decide. target_belt NÃO é enviado (decisão de
// 08/06, a mesma do caminho público): a faixa pretendida é definida pela
// federação/banca, não pelo sensei no ato da inscrição.
// 422 NAO_E_EXAME quando o id aponta para um CURSO — a rota está errada
// para aquele objeto, e isso é diferente de um aluno ter sido pulado.
router.post('/dojo/belt-exams/:examId/candidates', requireDojoAccess, requireChannelA, requireDojoLinked, async (req, res) => {
  try {
    const result = await svc.enrollBatch({
      dojoId: req.dojoId,
      federationId: req.federationId,
      eventId: req.params.examId,
      studentIds: (req.body || {}).student_ids,
      mode: 'belt_exam',
    });
    // Mesmo motor, vocabulário da troca: aqui se SUBMETE candidato.
    return res.json({
      submitted: result.enrolled,
      candidates: result.enrollments,
      event: result.event,
      skipped: result.skipped,
    });
  } catch (e) {
    return handleWriteError(res, e, 'POST /dojo/belt-exams/:examId/candidates');
  }
});

// ── GET /federation/:id/dojo/belt-exams/:examId/candidates ───────
router.get('/dojo/belt-exams/:examId/candidates', requireDojoAccess, requireDojoLinked, async (req, res) => {
  try {
    const out = await svc.listEnrollments({
      dojoId: req.dojoId,
      federationId: req.federationId,
      eventId: req.params.examId,
      mode: 'belt_exam',
    });
    return res.json({ event: out.event, data: out.data, count: out.data.length });
  } catch (e) {
    return handleReadError(res, e, 'GET /dojo/belt-exams/:examId/candidates', { event: null });
  }
});

module.exports = router;
