// ============================================================
// AURA KARATÊ — Solicitar atualização cadastral (independente) + estado
// (10/07/2026 — cascata de status dojô→praticantes + validação de quadro)
//
// POST /federation/:id/dojos/:dojoId/request-roster-update  (staffWrite/adminOnly)
//   Abre (ou reabre) uma solicitação de validação de quadro para o dojô,
//   SEM alterar is_active — independente da cascata do PATCH is_active
//   (ver karateDojos.js). Gera token opaco de 30 dias para o portal
//   público do sensei (karateRosterPortalPublic.js).
//
// GET /federation/:id/dojos/:dojoId/roster-validation  (read)
//   Estado atual da validação de quadro do dojô (para a UI mostrar banner
//   "quadro pendente de confirmação"). Defensivo 42P01 → { status: null }.
//
// Montado direto em index.js (não em private.js) — mesmo padrão dos
// demais mounts /federation/:id/dojos/... deste Track.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const crypto = require('crypto');
const db = require('../config/database');
const { guards } = require('../config/karateRoles');

// Mesmo padrão de base pública usado em dentalPortal.js/passwordReset.js:
// process.env.APP_URL (default https://app.getaura.com.br). PUBLIC_APP_URL
// não existe no repo — assumindo APP_URL como a env correta (documentado
// no relatório de entrega).
const APP_URL = process.env.APP_URL || 'https://app.getaura.com.br';

function rosterUpdateUrl(token) {
  return `${APP_URL}/karate/roster-update/${token}`;
}

// ── POST /federation/:id/dojos/:dojoId/request-roster-update ───────────
router.post('/:dojoId/request-roster-update', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const actorId = (req.user && req.user.id) || null;

  try {
    // Confere existência + escopo (federação + vertical karate_dojo).
    const dojoRes = await db.query(
      `SELECT id FROM companies
       WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
       LIMIT 1`,
      [dojoId, federationId]
    );
    if (!dojoRes.rows.length) {
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }

    const token = crypto.randomBytes(24).toString('hex');

    let row = null;
    try {
      const upsertRes = await db.query(
        `INSERT INTO karate_dojo_roster_validation
           (dojo_id, federation_id, status, requested_at, validated_at, validated_by,
            token, token_expires_at, updated_at)
         VALUES ($1, $2, 'pending', NOW(), NULL, NULL, $3, NOW() + INTERVAL '30 days', NOW())
         ON CONFLICT (dojo_id) DO UPDATE SET
           federation_id    = EXCLUDED.federation_id,
           status           = 'pending',
           requested_at     = NOW(),
           validated_at     = NULL,
           validated_by     = NULL,
           token            = EXCLUDED.token,
           token_expires_at = EXCLUDED.token_expires_at,
           updated_at       = NOW()
         RETURNING status, requested_at, token, token_expires_at`,
        [dojoId, federationId, token]
      );
      row = upsertRes.rows[0];
    } catch (e) {
      if (e.code === '42P01') {
        console.warn('[karateRosterValidation] karate_dojo_roster_validation ausente (schema pendente):', e.message);
        return res.status(503).json({
          error: 'Validação de quadro ainda não disponível (migration pendente)',
          code: 'SCHEMA_PENDING',
        });
      }
      throw e;
    }

    // Evento de auditoria — best-effort (não derruba o request se a tabela
    // de eventos não existir; a validação em si já foi persistida acima).
    try {
      await db.query(
        `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
         VALUES ($1, $2, 'validation_requested', '[]'::jsonb, $3)`,
        [dojoId, federationId, actorId]
      );
    } catch (e) {
      if (e.code !== '42P01') throw e;
      console.warn('[karateRosterValidation] karate_dojo_roster_events ausente (schema pendente):', e.message);
    }

    res.json({
      status: row.status,
      requested_at: row.requested_at,
      token: row.token,
      url: rosterUpdateUrl(row.token),
    });
  } catch (err) {
    console.error('[karateRosterValidation] request-roster-update error:', err.message);
    res.status(500).json({ error: 'Erro ao solicitar atualização cadastral' });
  }
});

// ── GET /federation/:id/dojos/:dojoId/roster-validation ────────────────
router.get('/:dojoId/roster-validation', ...guards.read(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;

  try {
    const { rows } = await db.query(
      `SELECT status, requested_at, validated_at, validated_by, token, token_expires_at
       FROM karate_dojo_roster_validation
       WHERE dojo_id = $1 AND federation_id = $2
       LIMIT 1`,
      [dojoId, federationId]
    );

    if (!rows.length) {
      return res.json({ status: null, requested_at: null, validated_at: null, validated_by: null, token: null, url: null });
    }

    const r = rows[0];
    const tokenActive = !!r.token && r.token_expires_at && new Date(r.token_expires_at) > new Date();

    res.json({
      status: r.status || null,
      requested_at: r.requested_at || null,
      validated_at: r.validated_at || null,
      validated_by: r.validated_by || null,
      token: tokenActive ? r.token : null,
      url: tokenActive ? rosterUpdateUrl(r.token) : null,
    });
  } catch (err) {
    if (err.code === '42P01') {
      console.warn('[karateRosterValidation] karate_dojo_roster_validation ausente (schema pendente):', err.message);
      return res.json({ status: null, requested_at: null, validated_at: null, validated_by: null, token: null, url: null });
    }
    console.error('[karateRosterValidation] roster-validation GET error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar validação de quadro' });
  }
});

module.exports = router;
