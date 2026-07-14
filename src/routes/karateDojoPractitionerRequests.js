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
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const { buildDedupKey, lookupByFpktNumber, normalizeFpktNumber } = require('../services/karatePractitionerDedup');

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

const VALID_SEX_VALUES = ['M', 'F', 'other'];

// Best-effort: nunca derruba a solicitação por falta da tabela de eventos
// (deploy parcial) — mesmo padrão dos demais arquivos de roster (SEM
// SAVEPOINT porque aqui NÃO estamos dentro de uma transação do caller;
// db.query é autocommit por statement).
async function logRosterEventBestEffort({ dojoId, federationId, event, affected, actorId = null }) {
  try {
    await db.query(
      `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [dojoId, federationId, event, JSON.stringify(affected), actorId]
    );
  } catch (e) {
    if (e.code === '42P01') {
      console.warn('[karateDojoPractitionerRequests] karate_dojo_roster_events ausente (schema pendente)');
    } else {
      console.error('[karateDojoPractitionerRequests] falha ao gravar roster event (não bloqueia):', e.message);
    }
  }
}

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
    created_at: r.created_at,
    resolved_at: r.resolved_at || null,
  };
}

// ── POST /federation/:id/dojo/practitioner-requests ────────
router.post('/dojo/practitioner-requests', requireDojoAccess, createLimiter, async (req, res) => {
  const dojoId = req.dojoId;
  const federationId = req.federationId;
  const b = req.body || {};

  const full_name = b.full_name != null ? String(b.full_name).trim() : '';
  if (!full_name) {
    return res.status(422).json({ error: 'Campo full_name é obrigatório', code: 'VALIDATION_ERROR' });
  }

  const birth_date = (typeof b.birth_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.birth_date))
    ? b.birth_date
    : null;
  if (b.birth_date && !birth_date) {
    return res.status(422).json({ error: 'birth_date deve ser YYYY-MM-DD', code: 'VALIDATION_ERROR' });
  }

  if (b.sex !== undefined && b.sex !== null && b.sex !== '' && !VALID_SEX_VALUES.includes(b.sex)) {
    return res.status(422).json({ error: `sex inválido. Use: ${VALID_SEX_VALUES.join(', ')}`, code: 'VALIDATION_ERROR' });
  }

  const cpf = b.cpf != null ? String(b.cpf).trim() || null : null;
  const rg = b.rg != null ? String(b.rg).trim() || null : null;
  const phone = b.phone != null ? String(b.phone).trim() || null : null;
  const email = b.email != null ? String(b.email).trim() || null : null;
  const claimed_belt = b.claimed_belt != null ? String(b.claimed_belt).trim() || null : null;
  const fpktClaimed = b.fpkt_number_claimed != null ? normalizeFpktNumber(b.fpkt_number_claimed) || null : null;

  // Ficha completa (nome, nascimento, CPF, RG, telefone, e-mail, faixa
  // alegada, endereço, responsável se menor) — sempre a versão bruta do
  // que o sensei mandou, mesmo os campos que também viram coluna própria.
  // dojo_id/federation_id NUNCA entram aqui (não são confiáveis do body e
  // já vêm do token acima).
  const payload = {
    full_name, birth_date, cpf, rg, phone, email, sex: b.sex || null,
    claimed_belt, fpkt_number_claimed: fpktClaimed,
    street: b.street || null, number: b.number || null, complement: b.complement || null,
    neighborhood: b.neighborhood || null, city: b.city || null, state: b.state || null, zip_code: b.zip_code || null,
    guardian_name: b.guardian_name || null, guardian_cpf: b.guardian_cpf || null,
    guardian_phone: b.guardian_phone || null, guardian_relationship: b.guardian_relationship || null,
  };

  const dedupKey = buildDedupKey(full_name, birth_date);

  try {
    const insertRes = await db.query(
      `INSERT INTO karate_practitioner_requests
         (federation_id, dojo_id, full_name, birth_date, cpf, rg, phone, email,
          claimed_belt, payload, fpkt_number_claimed, dedup_key,
          requested_by_channel, requested_by_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
       ON CONFLICT (dojo_id, dedup_key) WHERE status = 'pendente' DO NOTHING
       RETURNING id, status, created_at`,
      [
        federationId, dojoId, full_name, birth_date, cpf, rg, phone, email,
        claimed_belt, JSON.stringify(payload), fpktClaimed, dedupKey,
        req.dojoAuthChannel || null, (req.user && req.user.email) || null,
      ]
    );

    if (!insertRes.rows.length) {
      // Já existe uma solicitação PENDENTE idêntica (mesmo dojô + nome
      // normalizado + nascimento) — idempotente: não cria duplicata,
      // devolve a existente.
      const existing = await db.query(
        `SELECT id, status, created_at FROM karate_practitioner_requests
          WHERE dojo_id = $1 AND dedup_key = $2 AND status = 'pendente'
          LIMIT 1`,
        [dojoId, dedupKey]
      );
      const row = existing.rows[0];
      return res.status(200).json({
        id: row.id,
        status: row.status,
        created_at: row.created_at,
        already_pending: true,
        message: 'Já existe uma solicitação pendente para esta pessoa neste dojô.',
      });
    }

    const created = insertRes.rows[0];

    // Hint imediato: se o sensei já digitou um número FPKT, avisa na hora
    // se ele já pertence a alguém (provável transferência) — a decisão de
    // como tratar continua sendo da federação na aprovação; isto é só um
    // aviso amigável para o sensei não se surpreender depois.
    let fpktHint = null;
    if (fpktClaimed) {
      try {
        fpktHint = await lookupByFpktNumber(db, { federationId, number: fpktClaimed });
      } catch (e) {
        console.error('[karateDojoPractitionerRequests] fpkt hint falhou (não bloqueia):', e.message);
      }
    }

    await logRosterEventBestEffort({
      dojoId, federationId, event: 'practitioner_request_created',
      affected: [{ request_id: created.id, full_name }],
    });

    return res.status(201).json({
      id: created.id,
      status: created.status,
      created_at: created.created_at,
      already_pending: false,
      fpkt_lookup: fpktHint,
    });
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
              r.claimed_belt, r.fpkt_number_claimed, r.resolved_practitioner_id,
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

module.exports = router;
