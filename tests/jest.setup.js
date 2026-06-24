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
