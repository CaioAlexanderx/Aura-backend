// ============================================================
// AURA. — Weekly Report Token
// JWT assinado (HS256) para acesso publico ao relatorio semanal
// via link no email. Reutiliza JWT_SECRET, isolando por audience
// para que estes tokens NAO funcionem como tokens de sessao.
//
// Payload:
//   sub          = company_id
//   period_start = 'YYYY-MM-DD' (segunda, inclusivo)
//   period_end   = 'YYYY-MM-DD' (sabado, inclusivo)
//   aud          = 'weekly-report'
//   iss          = 'aura.'
//   exp          = +30 dias
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

function signWeeklyReportToken({ company_id, period_start, period_end }) {
  if (!company_id) throw new Error('signWeeklyReportToken: company_id obrigatorio');
  if (!period_start || !period_end) throw new Error('signWeeklyReportToken: period_start e period_end obrigatorios');
  return jwt.sign(
    { sub: String(company_id), period_start, period_end },
    getSecret(),
    { algorithm: 'HS256', expiresIn: TTL_SECS, audience: AUDIENCE, issuer: ISSUER }
  );
}

function verifyWeeklyReportToken(token) {
  try {
    const payload = jwt.verify(token, getSecret(), {
      algorithms: ['HS256'],
      audience:   AUDIENCE,
      issuer:     ISSUER,
    });
    return {
      valid:        true,
      company_id:   payload.sub,
      period_start: payload.period_start,
      period_end:   payload.period_end,
      exp:          payload.exp,
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
