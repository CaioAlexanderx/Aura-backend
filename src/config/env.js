// ============================================================
// AURA. -- Variaveis de ambiente
// A-02: CORS falha em producao se ALLOWED_ORIGINS nao definido
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

// Versão que o /health, o log de boot e o Sentry mostram (t1-01, 14/10/2026).
// Primeiro o RAILWAY_GIT_COMMIT_SHA, que a Railway injeta em todo deploy
// vindo da integração com o GitHub (e nos redeploys e rollbacks dele): é o
// commit que está de fato rodando. Antes o workflow Deploy gravava GIT_SHA
// com `railway variables set`, e isso reiniciava o serviço a cada merge
// (3,1 deploys por merge em 13/10). GIT_SHA continua valendo como reserva
// para deploy pela CLI (`railway up`), que não traz o commit.
// 8 caracteres, o mesmo tamanho que o `git rev-parse --short` dava.
function shaDaVersao(vars = process.env) {
  const railway = String(vars.RAILWAY_GIT_COMMIT_SHA || '').trim();
  if (railway) return railway.slice(0, 8);
  const reserva = vars.GIT_SHA;
  return reserva === undefined || reserva === null ? '' : String(reserva);
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

  const allowedOrigins = getOptionalEnv('ALLOWED_ORIGINS', '');
  if (nodeEnv === 'production' && !allowedOrigins) {
    throw new Error(
      'ALLOWED_ORIGINS obrigatorio em producao. ' +
      'Defina no Railway: https://getaura.com.br,https://app.getaura.com.br'
    );
  }

  // NFC-e emissao propria (SEFAZ-SP): chave-mestra AES-256-GCM dos segredos
  // fiscais (certificado A1, senha do .pfx, CSC token). Opcional enquanto
  // nenhuma empresa usa provider 'sefaz_sp', mas se definida tem que ser
  // valida (64 hex = 32 bytes). Falha no boot > falha silenciosa no caixa.
  // Gerar: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  const certMasterKey = getOptionalEnv('CERT_MASTER_KEY', '');
  if (certMasterKey && !/^[0-9a-fA-F]{64}$/.test(certMasterKey)) {
    throw new Error('CERT_MASTER_KEY invalida: esperado 64 caracteres hex (32 bytes).');
  }

  return {
    NODE_ENV:        nodeEnv,
    PORT:            getOptionalEnv('PORT', '3000'),
    JWT_SECRET:      nodeEnv === 'test'
                       ? getOptionalEnv('JWT_SECRET', 'aura-test-secret-2026')
                       : requireEnv('JWT_SECRET'),
    SUPABASE_DB_URL: nodeEnv === 'test'
                       ? getOptionalEnv('SUPABASE_DB_URL', 'postgresql://aura_test:aura_test@localhost:5432/aura_test')
                       : requireEnv('SUPABASE_DB_URL'),
    REDIS_URL:       getOptionalEnv('REDIS_URL', ''),
    SENTRY_DSN:      getOptionalEnv('SENTRY_DSN', ''),
    GIT_SHA:         shaDaVersao(),
    // FIX: APP_URL deve apontar pro app/Expo (login, reset-password, verify-email).
    // Nao confundir com STOREFRONT_BASE_URL, que e o dominio publico das vitrines
    // do Canal Digital (loja.getaura.com.br/<slug>).
    APP_URL:             getOptionalEnv('APP_URL', 'https://app.getaura.com.br'),
    STOREFRONT_BASE_URL: getOptionalEnv('STOREFRONT_BASE_URL', 'https://loja.getaura.com.br'),
    API_URL:             getOptionalEnv('API_URL', 'https://aura-backend-production-f805.up.railway.app/api/v1'),
    HEALTH_SECRET:   getOptionalEnv('HEALTH_SECRET', ''),
    ALLOWED_ORIGINS: allowedOrigins || '*',
    JWT_EXPIRES_IN:  getOptionalEnv('JWT_EXPIRES_IN', '7d'),
    // Token compartilhado com o Cloudflare Worker do site (getaura.com.br)
    // para o endpoint publico POST /api/v1/public/leads. Definir no Railway.
    SITE_LEADS_TOKEN: getOptionalEnv('SITE_LEADS_TOKEN', ''),
    CERT_MASTER_KEY:  certMasterKey,
  };
}

module.exports = { requireEnv, getOptionalEnv, validateRuntimeEnv, shaDaVersao };
