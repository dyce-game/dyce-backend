/** @type {import('jest').Config} */
const transform = {
  '^.+\.(t|j)sx?$': [
    '@swc/jest',
    {
      jsc: { target: 'es2022', parser: { syntax: 'typescript' } },
      module: { type: 'commonjs' },
    },
  ],
};

const shared = {
  testEnvironment: 'node',
  transform,
  // The workspace packages are ESM with a dist build; in tests we run their TypeScript source directly.
  moduleNameMapper: {
    '^@dyce/shared$': '<rootDir>/../../packages/shared/src/index.ts',
    '^@dyce/games$': '<rootDir>/../../packages/games/src/index.ts',
  },
  // jose v6 is ESM-only: transpile it so the CommonJS test runtime can load it.
  transformIgnorePatterns: ['/node_modules/(?!(jose)/)'],
};

module.exports = {
  testTimeout: 60000,
  projects: [
    { displayName: 'unit', ...shared, testMatch: ['<rootDir>/src/**/*.test.ts'] },
    {
      // Real Colyseus + real PostgreSQL: run via `pnpm test:db` (starts an embedded PostgreSQL if none is configured).
      displayName: 'db',
      ...shared,
      testMatch: ['<rootDir>/test/**/*.test.ts'],
    },
  ],
};
