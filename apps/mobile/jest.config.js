/**
 * Unit tests for the app's framework-free TypeScript (auth core, API client,
 * config parsing, error presentation). Same Jest + ts-jest toolchain and
 * versions as apps/api; no React Native renderer is involved, so tests must
 * only import pure modules (never react-native, expo or firebase).
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.test\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        isolatedModules: true,
        tsconfig: { module: 'commonjs', target: 'ES2022', strict: true, esModuleInterop: true },
      },
    ],
  },
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  clearMocks: true,
};
