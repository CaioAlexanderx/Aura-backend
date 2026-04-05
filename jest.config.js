// ============================================================
// AURA. — Jest Configuration
// Run: npm test (all) | npm run test:uat | npm run test:coverage
// ============================================================

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/**/*.test.js',
    '**/__tests__/**/*.test.js',
  ],
  testPathIgnorePatterns: ['/node_modules/'],
  verbose: true,

  // Coverage (run with npm run test:coverage)
  collectCoverage: false,
  collectCoverageFrom: [
    'src/routes/**/*.js',
    'src/middleware/**/*.js',
    'src/services/**/*.js',
    'src/utils/**/*.js',
    '!src/routes/index.js',
    '!src/routes/private.js',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 60,
      lines: 70,
      statements: 70,
    },
  },
};
