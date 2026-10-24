// ============================================================
// AURA. — Global Test Setup
// Mocks applied to ALL test files automatically via jest.config.js setupFiles
// Individual test files can override with their own jest.mock() calls
// ============================================================

// Force JWT_SECRET to match what test files hardcode in their token creation
// This ensures requireAuth middleware and test tokens use the same secret
process.env.JWT_SECRET = 'aura-test-secret-2026';
process.env.NODE_ENV = 'test';

// O modulo real (src/config/database.js) exporta o pool + helpers
// queryRetry (retry curto em erro transitorio de conexao) e isTransientConnError.
// O mock precisa espelhar essa API: requireCompanyAccess usa db.queryRetry.
// queryRetry DELEGA ao MESMO jest.fn de query -> preserva a ordem e a contagem
// dos mockResolvedValueOnce que os testes ja configuram em db.query.
jest.mock('../src/config/database', () => {
  const query = jest.fn();
  return {
    query,
    queryRetry: (...args) => query(...args),
    isTransientConnError: () => false,
    connect: jest.fn(() => ({
      query: jest.fn(),
      release: jest.fn(),
    })),
  };
});

jest.mock('../src/config/sentry', () => ({
  Sentry: {
    Handlers: {
      requestHandler: () => (req, res, next) => next(),
      tracingHandler: () => (req, res, next) => next(),
      errorHandler: () => (err, req, res, next) => next(err),
    },
  },
  initSentry: jest.fn(),
}));

jest.mock('../src/config/redis', () => ({}));

jest.mock('../src/services/dentalWs', () => ({
  setupDentalWebSocket: jest.fn(),
  getSessionStatus: jest.fn(),
}));

// W2-04: novo handler WS para TCLE (separado do dentalWs)
jest.mock('../src/services/dentalConsentWs', () => ({
  setupConsentWebSocket: jest.fn(),
  getConsentSessionStatus: jest.fn(() => ({ status: 'waiting', connected: false })),
  validateConsentToken: jest.fn(),
}));

// 12/10/2026: sinais do funil do trial (last_active_at em requireCompanyAccess,
// checkout.viewed no GET /billing/status) sao fire-and-forget e fariam uma
// query extra em todo request — consumindo os mockResolvedValueOnce que os
// testes de rota enfileiram em db.query. Aqui viram no-op; os testes do funil
// usam jest.unmock('../src/services/trialFunnel') para exercitar o real.
jest.mock('../src/services/trialFunnel', () => ({
  ...jest.requireActual('../src/services/trialFunnel'),
  touchCompanyActivity: jest.fn(() => false),
  recordCheckoutViewed: jest.fn(async () => false),
}));

// 13/10/2026: trial contado da primeira venda. O gancho da venda (POST
// /pdv/sale) e o "virou fixo" (cupom de dias gratis, estender trial) fazem um
// UPDATE a mais em db.query — mesmo problema acima. No-op aqui; os testes da
// regra usam jest.unmock('../src/services/trialRegra').
jest.mock('../src/services/trialRegra', () => ({
  ...jest.requireActual('../src/services/trialRegra'),
  iniciarTrialPelaPrimeiraVenda: jest.fn(async () => ({ iniciou: false })),
  marcarTrialFixo: jest.fn(async () => false),
}));

// 17/10/2026 (t2-04): os ganchos que avançam companies.onboarding_step (venda,
// produto, check-in) disparam um UPDATE a mais em db.query — mesmo problema
// acima. No-op aqui; os testes do passo usam
// jest.unmock('../src/services/onboardingProgress').
jest.mock('../src/services/onboardingProgress', () => ({
  ...jest.requireActual('../src/services/onboardingProgress'),
  avancarPasso: jest.fn(async () => false),
  avancarSemEsperar: jest.fn(),
}));

// 15/10/2026 (t2-09): o cadastro (POST /auth/register) consulta o CNPJ em
// segundo plano para gravar a cidade. Nos testes a rede fica desligada: o
// lookup falha de imediato (o cadastro ignora) e nao ha chamada externa nem
// db.query extra roubando os mockResolvedValueOnce das rotas. Os testes da
// cidade (tests/routes/signupOrigem.test.js) trocam o lookup por um valor.
jest.mock('../src/services/cnpj', () => ({
  ...jest.requireActual('../src/services/cnpj'),
  lookupCNPJ: jest.fn(async () => { throw new Error('rede desligada nos testes'); }),
}));

// 24/10/2026 (tq-73, tq-79, tq-80): a marca "quem pediu o encerramento"
// (antes do DELETE da assinatura em /billing/subscribe, /billing/cancel e na
// troca do Pix Automático) e a boas-vindas na confirmação do e-mail fazem
// uma query a mais em db.query — mesmo problema acima. No-op aqui; os
// testes delas usam jest.unmock('../src/services/assinaturasAsaas') e
// jest.unmock('../src/services/relacionamento').
jest.mock('../src/services/assinaturasAsaas', () => ({
  ...jest.requireActual('../src/services/assinaturasAsaas'),
  marcarEncerramentoPedido: jest.fn(async () => false),
}));
jest.mock('../src/services/relacionamento', () => ({
  ...jest.requireActual('../src/services/relacionamento'),
  aoConfirmarEmail: jest.fn(async () => 'mock'),
}));
