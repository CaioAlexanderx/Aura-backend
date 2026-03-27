function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value;
}

function getOptionalEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

function validateRuntimeEnv() {
  const nodeEnv = getOptionalEnv('NODE_ENV', 'development');

  if (!['development', 'test', 'staging', 'production'].includes(nodeEnv)) {
    throw new Error(`NODE_ENV invalido: ${nodeEnv}`);
  }

  if (nodeEnv !== 'test') {
    requireEnv('JWT_SECRET');
  }

  requireEnv('SUPABASE_DB_URL');

  return {
    NODE_ENV: nodeEnv,
    PORT: getOptionalEnv('PORT', '3000'),
    JWT_SECRET: nodeEnv === 'test'
      ? getOptionalEnv('JWT_SECRET', 'ci-test-secret-aura-2026')
      : requireEnv('JWT_SECRET'),
    SUPABASE_DB_URL: requireEnv('SUPABASE_DB_URL'),
    REDIS_URL: getOptionalEnv('REDIS_URL', ''),
    SENTRY_DSN: getOptionalEnv('SENTRY_DSN', ''),
    GIT_SHA: getOptionalEnv('GIT_SHA', ''),
    APP_URL: getOptionalEnv('APP_URL', 'https://getaura.com.br'),
    HEALTH_SECRET: getOptionalEnv('HEALTH_SECRET', ''),
    ALLOWED_ORIGINS: getOptionalEnv('ALLOWED_ORIGINS', '*'),
  };
}

module.exports = {
  requireEnv,
  getOptionalEnv,
  validateRuntimeEnv,
};
