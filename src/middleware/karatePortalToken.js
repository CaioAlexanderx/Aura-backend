// ============================================================
// AURA KARATÊ — Middleware de auth do portal do praticante (Track D)
// O praticante não é company_member: usa JWT type:'portal' emitido via OTP.
// Seta req.practitioner = { practitioner_id, federation_id }.
// ============================================================
'use strict';

const { verifyPortalToken } = require('../services/karatePortalAuthService');

function requirePractitionerToken(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de portal não fornecido', code: 'PORTAL_NO_TOKEN' });
  }
  try {
    const decoded = verifyPortalToken(header.split(' ')[1]);
    req.practitioner = {
      practitioner_id: decoded.practitioner_id,
      federation_id: decoded.federation_id,
    };
    next();
  } catch (err) {
    const expired = err && err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Sessão do portal expirada' : 'Token de portal inválido',
      code: expired ? 'PORTAL_TOKEN_EXPIRED' : 'PORTAL_TOKEN_INVALID',
    });
  }
}

module.exports = { requirePractitionerToken };
