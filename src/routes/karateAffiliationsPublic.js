// ============================================================
// AURA KARATÊ — Solicitação de filiação (PÚBLICA / self-service).
// Montado em /public/karate (microsite {slug}.getaura.com.br). Sem auth: um
// dojô candidato se filia sozinho. Cria a linha em karate_affiliation_requests
// com status='requested'; a federação avalia depois (karateAffiliations.js).
//
//   POST /public/karate/:slug/affiliation-request
//
// Router separado (mantém karatePublic.js intacto), no mesmo molde do
// karatePublicRanking.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

// Resolve a federação pelo slug do microsite (mesmo padrão de karatePublic).
async function resolveFederationId(slugOrId) {
  const r = await db.query(
    `SELECT company_id FROM digital_channel_config WHERE slug = $1 LIMIT 1`,
    [slugOrId]
  );
  if (r.rows.length) return r.rows[0].company_id;
  if (/^[0-9a-fA-F-]{36}$/.test(slugOrId)) return slugOrId;
  return null;
}

// ── POST /:slug/affiliation-request ─────────────────────────
router.post('/:slug/affiliation-request', async (req, res) => {
  const { slug } = req.params;
  const {
    dojo_name, cnpj, sensei_name, sensei_cpf,
    contact_email, contact_phone, region, affiliation_model,
  } = req.body || {};

  if (!dojo_name || !String(dojo_name).trim()) {
    return res.status(422).json({ error: 'dojo_name é obrigatório', code: 'VALIDATION_ERROR' });
  }
  if (affiliation_model && !['annual', 'biannual', 'quarterly'].includes(affiliation_model)) {
    return res.status(422).json({ error: 'affiliation_model inválido', code: 'VALIDATION_ERROR' });
  }

  try {
    const federationId = await resolveFederationId(slug);
    if (!federationId) {
      return res.status(404).json({ error: 'Federação não encontrada', code: 'NOT_FOUND' });
    }

    // Dedupe leve: evita reenvio enquanto há uma solicitação em aberto do
    // mesmo CNPJ/e-mail nesta federação.
    if (cnpj || contact_email) {
      const dup = await db.query(
        `SELECT id FROM karate_affiliation_requests
          WHERE federation_id = $1
            AND status IN ('requested','under_review','awaiting_payment')
            AND ( ($2::text IS NOT NULL AND cnpj = $2)
               OR ($3::text IS NOT NULL AND contact_email = $3) )
          LIMIT 1`,
        [federationId, cnpj || null, contact_email || null]
      );
      if (dup.rows.length) {
        return res.status(409).json({
          error: 'Já existe uma solicitação em andamento para este dojô',
          code: 'CONFLICT',
        });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO karate_affiliation_requests
         (federation_id, dojo_name, cnpj, sensei_name, sensei_cpf,
          contact_email, contact_phone, region, affiliation_model, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'requested', NOW(), NOW())
       RETURNING id, status, created_at`,
      [
        federationId, String(dojo_name).trim(), cnpj || null, sensei_name || null,
        sensei_cpf || null, contact_email || null, contact_phone || null,
        region || null, affiliation_model || null,
      ]
    );

    res.status(201).json({
      id: rows[0].id,
      status: rows[0].status,
      created_at: rows[0].created_at,
      _note: 'Solicitação recebida. A federação irá avaliar e retornar com os próximos passos.',
    });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(503).json({ error: 'Filiação indisponível no momento', code: 'NOT_READY' });
    }
    console.error('[karateAffiliationsPublic] create error:', err.message);
    res.status(500).json({ error: 'Erro ao enviar solicitação' });
  }
});

module.exports = router;
