// ============================================================
// AURA KARATÊ — Portal Público do Dojô (Canal B / off-app)
//
// Rotas públicas para o fluxo OTP do responsável do dojô.
// Montado em /public/karate (via index.js).
//
// Endpoints efetivos:
//   POST /public/karate/:slug/dojo/portal/request-otp
//   POST /public/karate/:slug/dojo/portal/verify-otp
//
// O slug é resolvido para federation_id internamente.
// Anti-enumeração U2: request-otp sempre retorna 200 genérico.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requestOtp, verifyOtp } = require('../services/karateDojoPortalAuthService');

/** Resolve slug → federation_id. Retorna null se não encontrar. */
async function resolveFederationBySlug(slug) {
  const r = await db.query(
    `SELECT id FROM companies
      WHERE (slug = $1 OR LOWER(trade_name) = LOWER($1))
        AND vertical = 'karate_federation'
        AND is_active = true
      LIMIT 1`,
    [slug]
  );
  return r.rows[0]?.id || null;
}

// POST /public/karate/:slug/dojo/portal/request-otp
// Body: { identifier: "email@exemplo.com" | "11999990000" }
router.post('/:slug/dojo/portal/request-otp', async (req, res) => {
  try {
    const { identifier } = req.body || {};
    if (!identifier || typeof identifier !== 'string') {
      return res.status(400).json({ error: 'identifier é obrigatório (e-mail ou telefone)' });
    }

    const federationId = await resolveFederationBySlug(req.params.slug);
    if (!federationId) {
      // Genérico: não revelar se slug existe
      return res.json({
        ok: true,
        message: 'Se houver um dojô cadastrado com este contato, enviaremos um código de acesso.',
      });
    }

    const result = await requestOtp({ federationId, identifier: identifier.trim() });
    res.json(result);
  } catch (err) {
    console.error('[karateDojoPublic] request-otp error:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// POST /public/karate/:slug/dojo/portal/verify-otp
// Body: { identifier, code }
router.post('/:slug/dojo/portal/verify-otp', async (req, res) => {
  try {
    const { identifier, code } = req.body || {};
    if (!identifier || !code) {
      return res.status(400).json({ error: 'identifier e code são obrigatórios' });
    }

    const federationId = await resolveFederationBySlug(req.params.slug);
    if (!federationId) {
      return res.status(401).json({ ok: false, error: 'Código inválido ou expirado' });
    }

    const result = await verifyOtp({ federationId, identifier: identifier.trim(), code: String(code).trim() });
    if (!result.ok) return res.status(401).json(result);
    res.json(result);
  } catch (err) {
    console.error('[karateDojoPublic] verify-otp error:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
