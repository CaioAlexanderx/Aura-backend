// ============================================================
// AURA KARATÊ — Middleware de acesso ao dojô (Fase 0 / Canais A + B)
//
// Canal A — JWT de acesso padrão (Aura Dojô, company karate_dojo):
//   O JWT de acesso emitido no login já carrega dojo_id + federation_id
//   (propagados por resolveKarateContext via shapeCompany). Este middleware
//   verifica o JWT, garante que dojo_id existe e que federation_id bate
//   com :id na rota.
//
// Canal B — JWT de portal dojô (off-app, OTP do responsável):
//   Emitido por karateDojoPortalAuthService.signDojoPortalToken.
//   Tipo: { type:'portal', scope:'dojo_portal', dojo_id, federation_id }.
//
// Ambos os canais resultam em req.dojoId + req.federationId + req.dojoAuthChannel.
// O handler NUNCA confia em dojo_id do corpo/query — sempre usa req.dojoId.
// ============================================================
'use strict';

const jwt = require('jsonwebtoken');
const { validateRuntimeEnv } = require('../config/env');

const env = validateRuntimeEnv();
const JWT_SECRET = env.JWT_SECRET;

function requireDojoAccess(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de dojô não fornecido', code: 'DOJO_NO_TOKEN' });
  }
  const raw = header.split(' ')[1];
  const federationParam = req.params.id; // pode ser undefined em rotas sem :id

  let decoded;
  try {
    decoded = jwt.verify(raw, JWT_SECRET);
  } catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Sessão expirada' : 'Token inválido',
      code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    });
  }

  // ── Canal B: dojo portal token ────────────────────────────
  if (decoded.type === 'portal' && decoded.scope === 'dojo_portal') {
    if (!decoded.dojo_id || !decoded.federation_id) {
      return res.status(401).json({ error: 'Token de dojô malformado', code: 'DOJO_TOKEN_MALFORMED' });
    }
    if (federationParam && decoded.federation_id !== federationParam) {
      return res.status(403).json({
        error: 'Token não pertence a esta federação',
        code: 'DOJO_FEDERATION_MISMATCH',
      });
    }
    req.dojoId = decoded.dojo_id;
    req.federationId = decoded.federation_id;
    req.dojoAuthChannel = 'B';
    return next();
  }

  // ── Canal A: acesso JWT padrão com dojo_id ────────────────
  if (decoded.type === 'access' && decoded.dojo_id) {
    // type 'refresh' já é descartado pelo check acima ('access')
    if (federationParam && decoded.federation_id !== federationParam) {
      return res.status(403).json({
        error: 'Dojô não pertence a esta federação',
        code: 'DOJO_FEDERATION_MISMATCH',
      });
    }
    req.user = decoded; // compat com middlewares que esperam req.user
    req.dojoId = decoded.dojo_id;
    req.federationId = decoded.federation_id;
    req.dojoAuthChannel = 'A';
    return next();
  }

  // Token válido mas sem acesso de dojô (ex: federação logada, token de refresh)
  return res.status(403).json({
    error: 'Token sem acesso de dojô. Use conta de dojô ou portal do responsável.',
    code: 'NOT_DOJO_TOKEN',
  });
}

module.exports = { requireDojoAccess };
