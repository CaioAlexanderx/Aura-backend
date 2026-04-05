// ============================================================
// AURA. — BE-01: Jest Coverage Configuration
// Enforces minimum 70% coverage on core routes
// Run: npm run test:coverage
// ============================================================

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  setupFilesAfterSetup: ['./jest.setup.js'],
  verbose: true,

  // Coverage
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
  coverageThresholds: {
    global: {
      branches: 50,
      functions: 60,
      lines: 70,
      statements: 70,
    },
    // Core routes must have higher coverage
    './src/routes/auth.js': {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    './src/middleware/auth.js': {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
