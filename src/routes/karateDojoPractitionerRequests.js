// ============================================================
// AURA KARATÊ — Solicitação de criação/transferência de praticante (H1)
// Portal do SENSEI — token-gated (requireDojoAccess: Canal A JWT de acesso
// OU Canal B portal OTP do responsável do dojô). Montado sob /federation/:id.
//
//   POST /federation/:id/dojo/practitioner-requests
//        — cria uma solicitação. dojo_id/federation_id vêm SEMPRE do token
//          (req.dojoId/req.federationId) — NUNCA do body. Idempotente: duas
//          submissões da mesma pessoa (dojô + nome normalizado + nascimento)
//          não geram duas solicitações pendentes (ver índice único parcial
//          uq_karate_practitioner_requests_pending_dedup, migration 231).
//   GET  /federation/:id/dojo/practitioner-requests?status=
//        — solicitações do PRÓPRIO dojô (o sensei vê o que foi aprovado/
//          rejeitado e o motivo/o número atribuído).
//   GET  /federation/:id/dojo/practitioner-requests/lookup-fpkt?number=
//        — dado um número FPKT, diz se já pertence a alguém NA FEDERAÇÃO
//          (escopo = federação, não só o dojô — o praticante pode estar em
//          outro dojô da mesma federação). Se pertence, a resposta deixa
//          explícito que isto é TRANSFERÊNCIA, não criação.
//
// O número FPKT é gerado pela FEDERAÇÃO, fora do nosso sistema — o sensei
// pode ou não sabê-lo (fpkt_number_claimed é OPCIONAL). Quem aprova e
// registra o número de verdade é a federação (karatePractitionerRequestsAdmin.js).
//
// ── GATE DE CONEXÃO (polish 25/07/2026) ─────────────────────
// Solicitar praticante é ESCRITA na federação — só existe depois que o dojô
// se conectou (companies.karate_dojo_linked_at, migration 251). Sem conexão:
// 409 DOJO_NAO_CONECTADO. Ver src/services/karateDojoLinkStatus.js.
//
// ── F5a (26/07/2026) ─────────────────────────────────────
// A criação em si saiu deste arquivo para
// src/services/karatePractitionerRequestCreate.js: o fluxo
// POST /dojo/students/:sid/federate abre a MESMA solicitação e não pode
// ter uma segunda cópia da validação/dedup/INSERT. Contrato, SQL e ordem
// das queries desta rota: idênticos.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const { lookupByFpktNumber } = require('../services/karatePractitionerDedup');
const { uploadToR2 } = require('../utils/r2Storage');
const { isDojoLinked } = require('../services/karateDojoLinkStatus');
const { createPractitionerRequest } = require('../services/karatePractitionerRequestCreate');

const isTestEnv = () => process.env.NODE_ENV === 'test';

function keyByDojoAndIp(req) {
  return `${req.dojoId || 'no-dojo'}:${req.ip || 'no-ip'}`;
}

// Rate limit de criação: um dojô real cadastra dezenas de praticantes numa
// sessão de matrícula (início de semestre), não milhares — 30/10min dá
// folga generosa sem abrir porta para flood.
const createLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByDojoAndIp,
  skip: () => isTestEnv(),
});

const lookupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByDojoAndIp,
  skip: () => isTestEnv(),
});

function shapeRequest(r) {
  return {
    id: r.id,
    status: r.status,
    resolution: r.resolution || null,
    reject_reason: r.reject_reason || null,
    full_name: r.full_name,
    birth_date: r.birth_date || null,
    claimed_belt: r.claimed_belt || null,
    fpkt_number_claimed: r.fpkt_number_claimed || null,
    resolved_practitioner_id: r.resolved_practitioner_id || null,
    // Quando aprovada, o sensei precisa ver o número REAL atribuído pela
    // federação — não o que ele digitou (claimed pode ter vindo errado).
    resolved_fpkt_number: r.resolved_fpkt_number || null,
    resolved_practitioner_name: r.resolved_practitioner_name || null,
    photo_url: r.photo_url || null,
    created_at: r.created_at,
    resolved_at: r.resolved_at || null,
  };
}

// ── POST /federation/:id/dojo/practitioner-requests ────────
router.post('/dojo/practitioner-requests', requireDojoAccess, createLimiter, async (req, res) => {
  const dojoId = req.dojoId;
  const federationId = req.federationId;

  // Gate de conexão (polish 25/07/2026): esta rota CRIA algo na federação
  // — não pode existir para um dojô que ainda não se conectou a ela.
  // 409 (conflito de ESTADO do dojô), não 403 (que soaria como permissão
  // do usuário). Antes da validação da ficha de propósito: mandar o sensei
  // preencher 15 campos para depois dizer "seu dojô nem está conectado"
  // seria cruel. Fail-open no helper (migration 251 pendente → passa).
  if (!(await isDojoLinked(dojoId))) {
    return res.status(409).json({
      error: 'Conecte seu dojô à federação para enviar solicitações',
      code: 'DOJO_NAO_CONECTADO',
    });
  }

  try {
    // Ponto ÚNICO de criação (compartilhado com POST /dojo/students/:sid/federate).
    // studentId fica null aqui: esta rota é o cadastro avulso do sensei,
    // não nasce de um aluno do dojô.
    const result = await createPractitionerRequest({
      federationId,
      dojoId,
      body: req.body,
      channel: req.dojoAuthChannel || null,
      actorLabel: (req.user && req.user.email) || null,
    });
    return res.status(result.status).json(result.body);
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(503).json({ error: 'Solicitação de praticante ainda não disponível (migração pendente)', code: 'MIGRATION_PENDING' });
    }
    console.error('[karateDojoPractitionerRequests] create error:', e.message);
    return res.status(500).json({ error: 'Erro ao criar solicitação' });
  }
});

// ── GET /federation/:id/dojo/practitioner-requests ──────────
router.get('/dojo/practitioner-requests', requireDojoAccess, async (req, res) => {
  const dojoId = req.dojoId;
  const status = ['pendente', 'aprovada', 'rejeitada'].includes(req.query.status) ? req.query.status : null;

  try {
    const { rows } = await db.query(
      `SELECT r.id, r.status, r.resolution, r.reject_reason, r.full_name, r.birth_date,
              r.claimed_belt, r.fpkt_number_claimed, r.resolved_practitioner_id, r.photo_url,
              r.created_at, r.resolved_at,
              c.karate_registration_number AS resolved_fpkt_number,
              c.name AS resolved_practitioner_name
         FROM karate_practitioner_requests r
         LEFT JOIN customers c ON c.id = r.resolved_practitioner_id
        WHERE r.dojo_id = $1
          AND ($2::text IS NULL OR r.status = $2)
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [dojoId, status]
    );
    return res.json({ data: rows.map(shapeRequest) });
  } catch (e) {
    if (e.code === '42P01') return res.json({ data: [] });
    console.error('[karateDojoPractitionerRequests] list error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar solicitações' });
  }
});

// ── GET /federation/:id/dojo/practitioner-requests/lookup-fpkt ──
router.get('/dojo/practitioner-requests/lookup-fpkt', requireDojoAccess, lookupLimiter, async (req, res) => {
  const number = req.query.number != null ? String(req.query.number).trim() : '';
  if (!number) {
    return res.status(422).json({ error: 'Parâmetro number é obrigatório', code: 'VALIDATION_ERROR' });
  }
  try {
    const result = await lookupByFpktNumber(db, { federationId: req.federationId, number });
    return res.json(result);
  } catch (e) {
    console.error('[karateDojoPractitionerRequests] lookup-fpkt error:', e.message);
    return res.status(500).json({ error: 'Erro ao consultar número FPKT' });
  }
});


// ── POST /federation/:id/dojo/practitioner-requests/:requestId/photo ──
// Item 9 (revisão Atualização Cadastral, 15/07/2026): foto do praticante
// NA SOLICITAÇÃO, antes de existir customer. Reusa o MESMO mecanismo de
// upload de karatePractitioners.js (JSON + base64 -> uploadToR2 -> grava
// URL) — só troca o destino (photo_url da solicitação, não
// customers.karate_photo_url ainda) porque o praticante não existe até a
// federação aprovar. Na aprovação (karatePractitionerRequestsAdmin.js) a
// URL é copiada 1:1 para customers.karate_photo_url.
// NÃO gateado por conexão de propósito: opera sobre uma solicitação que só
// existe se a CRIAÇÃO passou pelo gate acima (e é escopada ao próprio dojô).
const PHOTO_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

router.post('/dojo/practitioner-requests/:requestId/photo', requireDojoAccess, createLimiter, async (req, res) => {
  const dojoId = req.dojoId;
  const { requestId } = req.params;
  const { content, content_type } = req.body || {};

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Campo content (imagem em base64) é obrigatório', code: 'VALIDATION_ERROR' });
  }
  const mime = ((content_type || 'image/jpeg') + '').toLowerCase().split(';')[0].trim();
  if (!PHOTO_ALLOWED_TYPES.includes(mime)) {
    return res.status(400).json({
      error: 'Tipo de imagem não suportado: ' + mime + '. Use image/jpeg, image/png ou image/webp.',
      code: 'INVALID_CONTENT_TYPE',
    });
  }
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';

  try {
    // ESCOPO: só a solicitação DESTE dojô (nunca de outro dojô da federação).
    const reqRes = await db.query(
      `SELECT id FROM karate_practitioner_requests WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
      [requestId, dojoId]
    );
    if (!reqRes.rows.length) {
      return res.status(404).json({ error: 'Solicitação não encontrada neste dojô', code: 'NOT_FOUND' });
    }

    const key = 'karate/practitioner-requests/' + requestId + '.' + ext;
    const result = await uploadToR2(key, content, mime);
    if (!result.success) {
      console.error('[karateDojoPractitionerRequests] photo R2 error:', result.error);
      return res.status(500).json({ error: 'Erro no armazenamento da imagem' });
    }

    await db.query(
      `UPDATE karate_practitioner_requests SET photo_url = $1 WHERE id = $2`,
      [result.url, requestId]
    );

    res.json({ photo_url: result.url });
  } catch (e) {
    if (e.code === '42703') {
      console.warn('[karateDojoPractitionerRequests] photo_url ausente (migration 232 pendente)');
      return res.status(503).json({ error: 'Foto na solicitação ainda não disponível (migração pendente)', code: 'MIGRATION_PENDING' });
    }
    if (e.code === '42P01') {
      return res.status(503).json({ error: 'Solicitação de praticante ainda não disponível (migração pendente)', code: 'MIGRATION_PENDING' });
    }
    console.error('[karateDojoPractitionerRequests] photo error:', e.message);
    return res.status(500).json({ error: 'Erro ao anexar foto à solicitação' });
  }
});

module.exports = router;
