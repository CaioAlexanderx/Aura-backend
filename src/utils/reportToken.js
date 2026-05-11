// ============================================================
// AURA. — Weekly Report Token
// JWT assinado (HS256) para acesso publico ao relatorio semanal
// via link no email. Reutiliza JWT_SECRET, isolando por audience
// para que estes tokens NAO funcionem como tokens de sessao.
//
// Payload single-company (legacy):
//   sub          = company_id
//   period_start = 'YYYY-MM-DD'
//   period_end   = 'YYYY-MM-DD'
//   aud          = 'weekly-report'
//   iss          = 'aura.'
//   exp          = +30 dias
//
// Payload consolidado multi-CNPJ:
//   sub  = company_id da primary (usado para idempotency)
//   cids = ['uuid1','uuid2',...]   <- array de ids do grupo
//   ...demais claims iguais
// ============================================================

const jwt = require('jsonwebtoken');

const AUDIENCE = 'weekly-report';
const ISSUER   = 'aura.';
const TTL_SECS = 30 * 24 * 60 * 60; // 30 dias

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET nao configurado — necessario para weekly report token');
  return s;
}

function signWeeklyReportToken({ company_id, company_ids, period_start, period_end }) {
  if (!period_start || !period_end) {
    throw new Error('signWeeklyReportToken: period_start e period_end obrigatorios');
  }

  const ids = Array.isArray(company_ids) ? company_ids.filter(Boolean).map(String) : null;
  const primary = company_id || (ids && ids[0]);

  if (!primary) throw new Error('signWeeklyReportToken: company_id ou company_ids obrigatorio');

  const payload = {
    sub: String(primary),
    period_start,
    period_end,
  };

  if (ids && ids.length > 1) {
    payload.cids = ids;
  }

  return jwt.sign(payload, getSecret(), {
    algorithm: 'HS256',
    expiresIn: TTL_SECS,
    audience: AUDIENCE,
    issuer: ISSUER,
  });
}

function verifyWeeklyReportToken(token) {
  try {
    const payload = jwt.verify(token, getSecret(), {
      algorithms: ['HS256'],
      audience:   AUDIENCE,
      issuer:     ISSUER,
    });

    const company_ids = Array.isArray(payload.cids) && payload.cids.length > 0
      ? payload.cids.map(String)
      : [String(payload.sub)];

    return {
      valid:         true,
      company_id:    payload.sub,
      company_ids,
      consolidated:  company_ids.length > 1,
      period_start:  payload.period_start,
      period_end:    payload.period_end,
      exp:           payload.exp,
    };
  } catch (err) {
    return {
      valid:   false,
      error:   err.name === 'TokenExpiredError' ? 'expired' : 'invalid',
      message: err.message,
    };
  }
}

module.exports = { signWeeklyReportToken, verifyWeeklyReportToken, AUDIENCE };
