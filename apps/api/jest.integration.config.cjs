// migrations.sqlite.integration-spec.ts는 STORIX_DB_DRIVER=sqlite를 얹은 별도
// 실행 전용이다(자기 자신의 beforeAll 가드가 그 외 실행을 즉시 에러로
// 막는다) — STORIX_DB_DRIVER가 sqlite가 아닌 일반 test:integration 실행에서는
// 파일 자체를 후보 목록에서 뺀다. STORIX_DB_DRIVER=sqlite일 때는 빼지 않으므로
// `--runInBand <경로>`로 명시적으로 지정해 단독 실행할 수 있다.
const testPathIgnorePatterns =
  process.env.STORIX_DB_DRIVER === 'sqlite'
    ? ['/node_modules/']
    : ['/node_modules/', 'src/persistence/migrations\\.sqlite\\.integration-spec\\.ts$'];

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
