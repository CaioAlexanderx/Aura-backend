// ============================================================
// AURA. — Variáveis de ambiente
// A-02: CORS falha em produção se ALLOWED_ORIGINS não definido
// ============================================================
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
    requireEnv('SUPABASE_DB_URL');
  }

  // A-02: CORS — em produção ALLOWED_ORIGINS é obrigatório.
  // Em dev/test aceita '*' como fallback seguro.
  const allowedOrigins = getOptionalEnv('ALLOWED_ORIGINS', '');
  if (nodeEnv === 'production' && !allowedOrigins) {
    throw new Error(
      'ALLOWED_ORIGINS obrigatório em produção. ' +
      'Defina no Railway: https://getaura.com.br,https://app.getaura.com.br'
    );
  }

  return {
    NODE_ENV:        nodeEnv,
    PORT:            getOptionalEnv('PORT', '3000'),
    JWT_SECRET:      nodeEnv === 'test'
                       ? getOptionalEnv('JWT_SECRET', 'ci-test-secret-aura-2026')
                       : requireEnv('JWT_SECRET'),
    SUPABASE_DB_URL: nodeEnv === 'test'
                       ? getOptionalEnv('SUPABASE_DB_URL', 'postgresql://aura_test:aura_test@localhost:5432/aura_test')
                       : requireEnv('SUPABASE_DB_URL'),
    REDIS_URL:       getOptionalEnv('REDIS_URL', ''),
    SENTRY_DSN:      getOptionalEnv('SENTRY_DSN', ''),
    GIT_SHA:         getOptionalEnv('GIT_SHA', ''),
    APP_URL:         getOptionalEnv('APP_URL', 'https://getaura.com.br'),
    HEALTH_SECRET:   getOptionalEnv('HEALTH_SECRET', ''),
    // Em produção: lista separada por vírgula. Em dev/test: '*'
    ALLOWED_ORIGINS: allowedOrigins || '*',
    JWT_EXPIRES_IN:  getOptionalEnv('JWT_EXPIRES_IN', '7d'),
  };
}

module.exports = { requireEnv, getOptionalEnv, validateRuntimeEnv };
