// ============================================================
// AURA KARATÊ — Solicitar atualização cadastral (independente) + estado
// (10/07/2026 — cascata de status dojô→praticantes + validação de quadro)
// (12/07/2026 — G1: portal em escala. Além do token do sensei, gera um
//   self_service_token SEPARADO para o link de auto-atendimento do
//   praticante (ver karateRosterSelfServicePublic.js) — chaves diferentes
//   de propósito (ver migration 225): vazar o link do grupo do dojô nunca
//   dá poder de sensei. Também expõe GET /roster-progress (painel da
//   federação — status por dojô, item 7 do G1).
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

function rosterSelfServiceUrl(token) {
  return `${APP_URL}/karate/roster-self/${token}`;
}

// ── GET /federation/:id/dojos/roster-progress ───────────────
// Painel da federação (item 7 do G1): status do pedido por dojô, quantos
// praticantes ainda sem contato, quantos essenciais faltam, último acesso.
// Reusa karate_member_standing (fonte única de financeiro/faixa-preta) —
// não reimplementa a regra de status.
//
// status por dojô:
//   'nao_aberto'   — sem solicitação, OU solicitado mas o sensei nunca
//                     abriu o link (last_accessed_at IS NULL)
//   'em_andamento' — solicitado, já acessado, ainda não confirmado
//   'validado'     — sensei confirmou o quadro (POST /:token de fechamento)
//
// essenciais_faltando = praticantes ativos com (a) faixa-preta ATIVA com
//   anuidade em aberto na temporada OU (b) nenhum contato (nem telefone
//   nem e-mail) — o mesmo critério de "grupo essencial" do portal
//   (GET /public/roster-update/:token). praticantes_sem_contato é só o
//   subconjunto (b), para a federação ver o tamanho do buraco de contato.
router.get('/roster-progress', ...guards.read(), async (req, res) => {
  const federationId = req.params.id;

  try {
    const { rows } = await db.query(
      `WITH dojos AS (
         SELECT id AS dojo_id, COALESCE(name, trade_name, legal_name) AS dojo_nome
         FROM companies
         WHERE federation_id = $1 AND vertical = 'karate_dojo'
       ),
       practicantes AS (
         SELECT c.dojo_id,
                COUNT(*) FILTER (
                  WHERE COALESCE(c.is_active, true)
                    AND (c.phone IS NULL OR btrim(c.phone) = '')
                    AND (c.email IS NULL OR btrim(c.email) = '')
                ) AS sem_contato,
                COUNT(*) FILTER (
                  WHERE COALESCE(c.is_active, true) AND (
                    ((c.phone IS NULL OR btrim(c.phone) = '') AND (c.email IS NULL OR btrim(c.email) = ''))
                    OR (COALESCE(kms.is_black_belt, false) AND kms.financeiro = 'atrasado')
                  )
                ) AS essenciais_faltando,
                COUNT(*) FILTER (WHERE COALESCE(c.is_active, true)) AS total_ativos
         FROM customers c
         LEFT JOIN karate_member_standing kms ON kms.student_id = c.id
         WHERE c.dojo_id IN (SELECT dojo_id FROM dojos)
           AND c.is_student = true AND c.is_guest = false
         GROUP BY c.dojo_id
       )
       SELECT d.dojo_id, d.dojo_nome,
              v.status, v.last_accessed_at, v.requested_at, v.validated_at,
              COALESCE(p.sem_contato, 0)::int          AS praticantes_sem_contato,
              COALESCE(p.essenciais_faltando, 0)::int  AS essenciais_faltando,
              COALESCE(p.total_ativos, 0)::int          AS total_praticantes
       FROM dojos d
       LEFT JOIN karate_dojo_roster_validation v ON v.dojo_id = d.dojo_id
       LEFT JOIN practicantes p ON p.dojo_id = d.dojo_id
       ORDER BY d.dojo_nome ASC`,
      [federationId]
    );

    const data = rows.map((r) => {
      let status;
      if (!r.status) status = 'nao_aberto';
      else if (r.status === 'validated') status = 'validado';
      else if (!r.last_accessed_at) status = 'nao_aberto';
      else status = 'em_andamento';

      return {
        dojo_id: r.dojo_id,
        dojo_nome: r.dojo_nome,
        status,
        requested_at: r.requested_at || null,
        validated_at: r.validated_at || null,
        last_accessed_at: r.last_accessed_at || null,
        praticantes_sem_contato: r.praticantes_sem_contato,
        essenciais_faltando: r.essenciais_faltando,
        total_praticantes: r.total_praticantes,
      };
    });

    res.json({ data });
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterValidation] roster-progress schema pendente:', err.message);
      return res.json({ data: [] });
    }
    console.error('[karateRosterValidation] roster-progress error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar progresso de quadro dos dojôs' });
  }
});

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
    // Segredo SEPARADO do token do sensei (ver comentário de topo do arquivo
    // e migration 225) — o self-service nunca usa o mesmo token de escrita
    // plena.
    const selfServiceToken = crypto.randomBytes(24).toString('hex');

    let row = null;
    try {
      const upsertRes = await db.query(
        `INSERT INTO karate_dojo_roster_validation
           (dojo_id, federation_id, status, requested_at, validated_at, validated_by,
            token, token_expires_at,
            self_service_token, self_service_token_expires_at,
            updated_at)
         VALUES ($1, $2, 'pending', NOW(), NULL, NULL, $3, NOW() + INTERVAL '30 days',
                 $4, NOW() + INTERVAL '30 days', NOW())
         ON CONFLICT (dojo_id) DO UPDATE SET
           federation_id                 = EXCLUDED.federation_id,
           status                        = 'pending',
           requested_at                  = NOW(),
           validated_at                  = NULL,
           validated_by                  = NULL,
           token                         = EXCLUDED.token,
           token_expires_at              = EXCLUDED.token_expires_at,
           self_service_token            = EXCLUDED.self_service_token,
           self_service_token_expires_at = EXCLUDED.self_service_token_expires_at,
           last_accessed_at              = NULL,
           updated_at                    = NOW()
         RETURNING status, requested_at, token, token_expires_at,
                   self_service_token, self_service_token_expires_at`,
        [dojoId, federationId, token, selfServiceToken]
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
      if (e.code === '42703') {
        // Migration 225 (self_service_token) ainda não aplicada — cai para
        // o INSERT antigo (só token do sensei), sem quebrar o request.
        console.warn('[karateRosterValidation] colunas self_service ausentes (schema pendente):', e.message);
        const fallbackRes = await db.query(
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
        row = { ...fallbackRes.rows[0], self_service_token: null, self_service_token_expires_at: null };
      } else {
        throw e;
      }
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
      self_service_token: row.self_service_token || null,
      self_service_url: row.self_service_token ? rosterSelfServiceUrl(row.self_service_token) : null,
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
      `SELECT status, requested_at, validated_at, validated_by, token, token_expires_at,
              self_service_token, self_service_token_expires_at, last_accessed_at
       FROM karate_dojo_roster_validation
       WHERE dojo_id = $1 AND federation_id = $2
       LIMIT 1`,
      [dojoId, federationId]
    );

    if (!rows.length) {
      return res.json({
        status: null, requested_at: null, validated_at: null, validated_by: null,
        token: null, url: null, self_service_token: null, self_service_url: null,
        last_accessed_at: null,
      });
    }

    const r = rows[0];
    const tokenActive = !!r.token && r.token_expires_at && new Date(r.token_expires_at) > new Date();
    const selfServiceActive = !!r.self_service_token && r.self_service_token_expires_at
      && new Date(r.self_service_token_expires_at) > new Date();

    res.json({
      status: r.status || null,
      requested_at: r.requested_at || null,
      validated_at: r.validated_at || null,
      validated_by: r.validated_by || null,
      token: tokenActive ? r.token : null,
      url: tokenActive ? rosterUpdateUrl(r.token) : null,
      self_service_token: selfServiceActive ? r.self_service_token : null,
      self_service_url: selfServiceActive ? rosterSelfServiceUrl(r.self_service_token) : null,
      last_accessed_at: r.last_accessed_at || null,
    });
  } catch (err) {
    if (err.code === '42P01') {
      console.warn('[karateRosterValidation] karate_dojo_roster_validation ausente (schema pendente):', err.message);
      return res.json({
        status: null, requested_at: null, validated_at: null, validated_by: null,
        token: null, url: null, self_service_token: null, self_service_url: null,
        last_accessed_at: null,
      });
    }
    if (err.code === '42703') {
      // Migration 225 pendente: colunas self_service_* ausentes. Degrada
      // silenciosamente para o formato antigo em vez de 500.
      console.warn('[karateRosterValidation] colunas self_service ausentes (schema pendente):', err.message);
      try {
        const { rows } = await db.query(
          `SELECT status, requested_at, validated_at, validated_by, token, token_expires_at
           FROM karate_dojo_roster_validation
           WHERE dojo_id = $1 AND federation_id = $2
           LIMIT 1`,
          [dojoId, federationId]
        );
        if (!rows.length) {
          return res.json({
            status: null, requested_at: null, validated_at: null, validated_by: null,
            token: null, url: null, self_service_token: null, self_service_url: null,
            last_accessed_at: null,
          });
        }
        const r = rows[0];
        const tokenActive = !!r.token && r.token_expires_at && new Date(r.token_expires_at) > new Date();
        return res.json({
          status: r.status || null,
          requested_at: r.requested_at || null,
          validated_at: r.validated_at || null,
          validated_by: r.validated_by || null,
          token: tokenActive ? r.token : null,
          url: tokenActive ? rosterUpdateUrl(r.token) : null,
          self_service_token: null,
          self_service_url: null,
          last_accessed_at: null,
        });
      } catch (e2) {
        console.error('[karateRosterValidation] roster-validation fallback error:', e2.message);
        return res.status(500).json({ error: 'Erro ao carregar validação de quadro' });
      }
    }
    console.error('[karateRosterValidation] roster-validation GET error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar validação de quadro' });
  }
});

module.exports = router;
