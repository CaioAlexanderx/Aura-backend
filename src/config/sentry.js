// ============================================================
// AURA. — INF-03: Sentry Monitoring
// SDK: @sentry/node v7 (ja instalado)
// Features: error tracking, performance tracing, release tracking,
//           filtro de ruido (404, health), contexto por request
// ============================================================
const Sentry = require('@sentry/node');

const IS_PROD    = process.env.NODE_ENV === 'production';
const IS_STAGING = process.env.NODE_ENV === 'staging';
const IS_ACTIVE  = IS_PROD || IS_STAGING;

function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    if (IS_PROD) console.warn('[Sentry] SENTRY_DSN nao configurado em producao!');
    return;
  }

  // Versao da release: GIT_SHA injetado pelo CI, fallback para package version
  const pkg     = require('../../package.json');
  const gitSha  = process.env.GIT_SHA;
  const release = gitSha
    ? `aura-backend@${gitSha}`
    : `aura-backend@${pkg.version}`;

  Sentry.init({
    dsn,
    release,
    environment: process.env.NODE_ENV || 'development',

    integrations: [
      new Sentry.Integrations.Http({ tracing: true }),
      new Sentry.Integrations.Express({ tracing: true }),
      new Sentry.Integrations.Postgres(),
      new Sentry.Integrations.Console(),
    ],

    // Performance: 100% em dev, 10% em producao
    tracesSampleRate: IS_PROD ? 0.1 : 1.0,

    // Contexto de servidor
    serverName: `aura-api-${process.env.NODE_ENV || 'dev'}`,

    // Filtra ruido antes de enviar ao Sentry
    beforeSend(event, hint) {
      const err = hint && hint.originalException;
      if (!err) return event;
      // Erros esperados de negocio — nao precisam ir ao Sentry
      if (err.status === 404)                           return null;
      if (err.statusCode === 404)                       return null;
      if (err.message && err.message.includes('jwt expired'))    return null;
      if (err.message && err.message.includes('Token invalido')) return null;
      if (err.message && err.message.includes('Not Found'))      return null;
      // Health checks
      const url = (event.request && event.request.url) || '';
      if (url.includes('/health')) return null;
      return event;
    },

    // Nao rastreia health checks e rota raiz
    tracesSampler(samplingContext) {
      const name = (samplingContext.transactionContext && samplingContext.transactionContext.name) || '';
      if (name.includes('GET /health')) return 0;
      if (name === 'GET /')             return 0.02;
      return IS_PROD ? 0.1 : 1.0;
    },
  });

  console.log('[Sentry] Inicializado | release: ' + release + ' | env: ' + process.env.NODE_ENV);
}

/**
 * captureError — captura erro com contexto extra
 * Uso: captureError(err, { userId, companyId, extra })
 */
function captureError(err, context) {
  const ctx = context || {};
  Sentry.withScope(function(scope) {
    if (ctx.userId)    scope.setUser({ id: ctx.userId });
    if (ctx.companyId) scope.setTag('company_id', ctx.companyId);
    if (ctx.extra)     scope.setExtras(ctx.extra);
    Sentry.captureException(err);
  });
}

module.exports = { Sentry, initSentry, captureError };
