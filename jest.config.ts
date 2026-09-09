import type { Config } from 'jest';

const tsPreset = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  testEnvironment: 'node',
};

const config: Config = {
  rootDir: '.',
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    // Wiring and framework-only files carry no branching logic to test.
    '!src/main.ts',
    '!src/health.controller.ts',
    '!src/**/*.module.ts',
    '!src/**/dto/**',
    '!src/**/*.types.ts',
    '!src/common/request-context.ts',
    '!src/common/redis/redis.constants.ts',
  ],
  coverageDirectory: './coverage',
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 },
  },
  projects: [
    {
      ...tsPreset,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
    },
    {
      ...tsPreset,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
      globalSetup: '<rootDir>/test/jest-e2e.setup.ts',
    },
  ],
};

export default config;
