// ============================================================
// AURA. — Global Test Setup
// Mocks applied to ALL test files automatically via jest.config.js setupFiles
// Individual test files can override with their own jest.mock() calls
// ============================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(() => ({
    query: jest.fn(),
    release: jest.fn(),
  })),
}));

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
