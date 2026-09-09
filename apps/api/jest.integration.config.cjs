// *.sqlite.integration-spec.ts는 STORIX_DB_DRIVER=sqlite를 얹은 별도 실행
// 전용이다(각 파일 자신의 beforeAll 가드가 그 외 실행을 즉시 에러로 막는다)
// — STORIX_DB_DRIVER가 sqlite가 아닌 일반 test:integration 실행에서는 이
// 패턴에 매치되는 파일 전부를 후보 목록에서 뺀다. STORIX_DB_DRIVER=sqlite일
// 때는 빼지 않으므로 test:integration:sqlite가 이 패턴으로 전부 골라 돈다.
const testPathIgnorePatterns =
  process.env.STORIX_DB_DRIVER === 'sqlite'
    ? ['/node_modules/']
    : ['/node_modules/', 'src/.*\\.sqlite\\.integration-spec\\.ts$'];

/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }],
  },
  testRegex: 'src/.*\\.integration-spec\\.ts$',
  testPathIgnorePatterns,
  moduleFileExtensions: ['js', 'json', 'ts'],
  testTimeout: 120000,
  setupFiles: ['<rootDir>/test/testcontainers-env.cjs'],
};
