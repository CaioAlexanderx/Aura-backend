// ============================================================
// AURA KARATÊ — F0 Canal B: gestão do LINK FIXO do portal do dojô
// Montado em /federation/:id/dojos (ver index.js).
//
//   POST   /federation/:id/dojos/:dojoId/portal-link  (staffWrite)
//     Gera/ROTACIONA o link (o anterior é revogado). Devolve { url, token,
//     created_at } — o token em claro sai AQUI uma única vez.
//   DELETE /federation/:id/dojos/:dojoId/portal-link  (staffWrite)
//     Revoga o link ativo (o dojô perde acesso na hora).
//   GET    /federation/:id/dojos/:dojoId/portal-link  (read)
//     { active, created_at, revoked_at } — NUNCA devolve o token.
//
// URL do link: https://{slug}.getaura.com.br/karate/{slug}/dojo?t={token}
// (slug = companies.slug da federação — mesmo campo que o mailer usa para o
// remetente por federação). Sem slug cadastrado, cai no APP_URL com o
// federationId no segmento [slug] do front — a página do portal
// (app/karate/[slug]/dojo/index.tsx) não usa o slug para chamar a API
// (token-only), só para a rota.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const portalLinkService = require('../services/karateDojoPortalLinkService');

const APP_URL = process.env.APP_URL || 'https://app.getaura.com.br';
const KARATE_PORTAL_DOMAIN = process.env.KARATE_PORTAL_DOMAIN || 'getaura.com.br';

function dojoPortalUrl(slug, federationId, token) {
  if (slug) {
    return `https://${slug}.${KARATE_PORTAL_DOMAIN}/karate/${slug}/dojo?t=${token}`;
  }
  return `${APP_URL}/karate/${federationId}/dojo?t=${token}`;
}

// Confere existência + escopo do dojô (federação + vertical karate_dojo) —
// mesmo predicado de karateRosterValidation.js.
async function dojoBelongs(dojoId, federationId) {
  const { rows } = await db.query(
    `SELECT id FROM companies
      WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo'
      LIMIT 1`,
    [dojoId, federationId]
  );
  return rows.length > 0;
}

// ── POST /:dojoId/portal-link — gera/rotaciona ──────────────
router.post('/:dojoId/portal-link', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const actorId = (req.user && req.user.id) || null;

  try {
    if (!(await dojoBelongs(dojoId, federationId))) {
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'DOJO_NOT_FOUND' });
    }

    // Slug do microsite da federação — best-effort (sem slug, cai no APP_URL).
    let slug = null;
    try {
      const fed = await db.query(`SELECT slug FROM companies WHERE id = $1 LIMIT 1`, [federationId]);
      slug = (fed.rows[0] && fed.rows[0].slug) || null;
    } catch (_) { /* slug opcional */ }

    const { token, created_at } = await portalLinkService.createLink({
      dojoId,
      federationId,
      createdBy: actorId,
    });

    res.status(201).json({
      url: dojoPortalUrl(slug, federationId, token),
      token, // única vez — não é recuperável depois (só o hash é persistido)
      created_at,
    });
  } catch (err) {
    if (err.code === 'SCHEMA_PENDING') {
      return res.status(503).json({ error: err.message, code: 'SCHEMA_PENDING' });
    }
    console.error('[karateDojoPortalLink] POST portal-link error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar o link do portal do dojô' });
  }
});

// ── DELETE /:dojoId/portal-link — revoga ────────────────────
router.delete('/:dojoId/portal-link', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;

  try {
    const revoked = await portalLinkService.revokeLink({ dojoId, federationId });
    if (!revoked) {
      return res.status(404).json({ error: 'Nenhum link ativo para este dojô', code: 'NOT_FOUND' });
    }
    res.json({ revoked: true });
  } catch (err) {
    if (err.code === 'SCHEMA_PENDING') {
      return res.status(503).json({ error: err.message, code: 'SCHEMA_PENDING' });
    }
    console.error('[karateDojoPortalLink] DELETE portal-link error:', err.message);
    res.status(500).json({ error: 'Erro ao revogar o link do portal do dojô' });
  }
});

// ── GET /:dojoId/portal-link — status (sem token) ───────────
router.get('/:dojoId/portal-link', ...guards.read(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;

  try {
    const status = await portalLinkService.getLinkStatus({ dojoId, federationId });
    res.json(status);
  } catch (err) {
    if (err.code === 'SCHEMA_PENDING') {
      // Antes da migration 239: sem link, sem erro (padrão degradação graceful).
      return res.json({ active: false, created_at: null, revoked_at: null });
    }
    console.error('[karateDojoPortalLink] GET portal-link error:', err.message);
    res.status(500).json({ error: 'Erro ao consultar o link do portal do dojô' });
  }
});

module.exports = router;
