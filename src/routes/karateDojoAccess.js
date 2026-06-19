// ============================================================
// AURA KARATÊ — Gestão do link de acesso do dojô (Canal B), lado federação.
// Montado em /federation/:id/dojos (ao lado de karateDojos). A federação
// emite/rotaciona/revoga o LINK FIXO não-expirável do dojô SEM Aura.
//
//   GET    /federation/:id/dojos/:dojoId/portal-access  — status (mascarado) (read)
//   POST   /federation/:id/dojos/:dojoId/portal-access  — emite/rotaciona (adminOnly)
//                                                          → token CLARO 1x
//   DELETE /federation/:id/dojos/:dojoId/portal-access  — revoga (adminOnly)
//
// O token só aparece em claro na resposta do POST (a federação cola no link
// {slug}.getaura.com.br/dojo?t=<token> e envia por WhatsApp/e-mail).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { issuePortalToken, revokePortalToken, getPortalAccess } = require('../services/karateDojoPortalService');

// Garante que o dojô existe e pertence à federação da rota.
async function assertDojo(federationId, dojoId) {
  const { rows } = await db.query(
    `SELECT id FROM companies
      WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
    [dojoId, federationId]
  );
  return rows.length > 0;
}

// ── GET /dojos/:dojoId/portal-access — status (mascarado) ───
router.get('/:dojoId/portal-access', ...guards.read(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  try {
    if (!(await assertDojo(federationId, dojoId))) {
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }
    const access = await getPortalAccess(federationId, dojoId);
    res.json(access || { status: 'none', token_masked: null });
  } catch (err) {
    console.error('[karateDojoAccess] get error:', err.message);
    res.status(500).json({ error: 'Erro ao consultar acesso do dojô' });
  }
});

// ── POST /dojos/:dojoId/portal-access — emite/rotaciona ─────
router.post('/:dojoId/portal-access', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  try {
    if (!(await assertDojo(federationId, dojoId))) {
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }
    const { token, masked, access } = await issuePortalToken(federationId, dojoId, req.user?.id);
    res.status(201).json({
      token,            // CLARO — exibido uma única vez
      token_masked: masked,
      status: access.status,
      rotated_at: access.rotated_at,
      _note: 'Guarde/cole o link agora — o token não será exibido novamente.',
    });
  } catch (err) {
    console.error('[karateDojoAccess] issue error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar acesso do dojô', detail: err.message });
  }
});

// ── DELETE /dojos/:dojoId/portal-access — revoga ───────────
router.delete('/:dojoId/portal-access', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  try {
    const revoked = await revokePortalToken(federationId, dojoId);
    if (!revoked) {
      return res.status(404).json({ error: 'Nenhum acesso ativo para revogar', code: 'NOT_FOUND' });
    }
    res.json({ status: 'revoked' });
  } catch (err) {
    console.error('[karateDojoAccess] revoke error:', err.message);
    res.status(500).json({ error: 'Erro ao revogar acesso do dojô' });
  }
});

module.exports = router;
