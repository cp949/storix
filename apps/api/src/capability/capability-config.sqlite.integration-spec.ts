import { runCapabilityConfigBootTests } from './capability-config.shared-tests.js';

// STORIX_DB_DRIVER=sqlite를 얹은 test:integration:sqlite 실행에서만 돈다.
describe('AppModule capability 설정 부팅 (SQLite)', () => {
  runCapabilityConfigBootTests('sqlite');
});
