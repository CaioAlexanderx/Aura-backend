// ============================================================
// AURA KARATÊ — Guard B: auth do portal do dojô (Canal B / link fixo)
//
// O dojô SEM Aura não é company_member nem tem JWT: entra por um LINK FIXO
// não-expirável. O token vem no header (Authorization: Bearer <t> ou
// X-Dojo-Token) ou na query (?t=). Resolvemos o token → { dojo_id,
// federation_id } e setamos req.dojo. Reforçamos que o dojô pertence à
// federação da rota (:id) — escopo sempre derivado do servidor, nunca do
// corpo/query do cliente.
//
// Espelha requirePractitionerToken (Canal praticante), mas o token do dojô é
// opaco (hash em karate_dojo_portal_access), não um JWT.
// ============================================================
'use strict';

const { resolveDojoByToken } = require('../services/karateDojoPortalService');

function extractToken(req) {
  const header = req.headers['authorization'];
  if (header && header.startsWith('Bearer ')) return header.split(' ')[1];
  if (req.headers['x-dojo-token']) return String(req.headers['x-dojo-token']);
  if (req.query && req.query.t) return String(req.query.t);
  return null;
}

// Resolve o token e seta req.dojo. NÃO valida a federação aqui (o mount pode
// não ter :id) — use requireDojoOfFederation logo após, nas rotas /federation/:id/dojo.
async function requireDojoPortal(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Link de acesso do dojô não fornecido', code: 'DOJO_NO_TOKEN' });
  }
  try {
    const ctx = await resolveDojoByToken(token);
    if (!ctx) {
      return res.status(401).json({ error: 'Link de acesso inválido ou revogado', code: 'DOJO_TOKEN_INVALID' });
    }
    req.dojo = { dojo_id: ctx.dojo_id, federation_id: ctx.federation_id };
    next();
  } catch (err) {
    console.error('[karateDojoPortalToken] resolve error:', err.message);
    return res.status(500).json({ error: 'Erro ao validar acesso do dojô' });
  }
}

// Reforça que o dojô do token pertence à federação da rota (:id). Monte após
// requireDojoPortal nas rotas /federation/:id/dojo/*.
function requireDojoOfFederation(req, res, next) {
  const federationId = req.params.id;
  if (!req.dojo || !req.dojo.federation_id) {
    return res.status(401).json({ error: 'Contexto do dojô ausente', code: 'DOJO_NO_CONTEXT' });
  }
  if (federationId && req.dojo.federation_id !== federationId) {
    return res.status(403).json({ error: 'Dojô não pertence a esta federação', code: 'DOJO_WRONG_FEDERATION' });
  }
  next();
}

module.exports = { requireDojoPortal, requireDojoOfFederation };
