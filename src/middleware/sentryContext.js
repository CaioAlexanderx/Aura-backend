// ============================================================
// AURA. — Contexto Sentry
// A-05: mascara PII e tokens antes de enviar ao Sentry
// ============================================================
const { Sentry } = require('../config/sentry');

// Campos que nunca devem aparecer em logs/telemetria
const SENSITIVE_KEYS = [
  'password', 'password_hash', 'token', 'secret', 'api_key', 'apikey',
  'cpf', 'cnpj', 'card', 'credit_card', 'cvv', 'authorization',
  'invite_token', 'reset_token', 'access_token', 'refresh_token',
];

function maskSensitive(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      const lower = k.toLowerCase();
      if (SENSITIVE_KEYS.some(s => lower.includes(s))) return [k, '***'];
      if (v && typeof v === 'object') return [k, maskSensitive(v)];
      return [k, v];
    })
  );
}

function sentryContext(req, res, next) {
  if (req.user) {
    Sentry.setUser({
      id:    req.user.id,
      role:  req.user.role,
      plan:  req.user.plan,
      // email propositalmente omitido — só id para correlação
    });
  }
  next();
}

function sentryError(err, req, res, next) {
  const status = err.statusCode || err.status || 500;
  if (status >= 500) {
    Sentry.withScope(scope => {
      // A-05: body/query/params mascarados antes do envio
      scope.setExtra('body',   maskSensitive(req.body));
      scope.setExtra('query',  maskSensitive(req.query));
      scope.setExtra('params', maskSensitive(req.params));
      scope.setExtra('path',   req.path);
      scope.setExtra('method', req.method);
      Sentry.captureException(err);
    });
  }
  next(err);
}

module.exports = { sentryContext, sentryError, maskSensitive };
