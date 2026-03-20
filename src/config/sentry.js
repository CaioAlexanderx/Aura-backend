const Sentry = require('@sentry/node');

function initSentry() {
  if (process.env.NODE_ENV !== 'production') return;

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 0.2,
    environment: process.env.NODE_ENV,
    release: 'aura-backend@1.0.0',
  });

  console.log('Sentry inicializado');
}

module.exports = { Sentry, initSentry };
