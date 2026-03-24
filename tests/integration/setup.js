// ============================================================
// AURA. — Setup de Testes de Integração (QA-02)
// ============================================================

jest.mock('../../src/config/database', () => {
  const mockQuery = jest.fn();
  const mockConnect = jest.fn(() => ({
    query: jest.fn(),
    release: jest.fn(),
  }));
  return { query: mockQuery, connect: mockConnect };
});

jest.mock('../../src/config/redis', () => ({
  get: jest.fn(), set: jest.fn(), del: jest.fn(),
}));

jest.mock('../../src/config/sentry', () => ({
  Sentry: {
    Handlers: {
      requestHandler: () => (req, res, next) => next(),
      tracingHandler:  () => (req, res, next) => next(),
      errorHandler:   () => (err, req, res, next) => next(err),
    },
    init: jest.fn(),
  },
  initSentry: jest.fn(),
}));

jest.mock('../../src/services/dentalWs', () => ({
  setupDentalWebSocket: jest.fn(),
  getSessionStatus: jest.fn(() => ({ status: 'waiting', connected: false })),
}));

process.env.JWT_SECRET = 'aura-test-secret-2026';
process.env.NODE_ENV   = 'test';
