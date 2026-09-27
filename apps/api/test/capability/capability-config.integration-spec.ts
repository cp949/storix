import { runCapabilityConfigBootTests } from './capability-config.shared-tests.js';

describe('AppModule capability 설정 부팅 (PostgreSQL)', () => {
  runCapabilityConfigBootTests('postgres');
});
