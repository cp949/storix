import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMigrationEnv } from '../../src/runner/database.ts';

const databaseEnv = { STORIX_DB_DRIVER: 'sqlite', STORIX_DB_SQLITE_PATH: '/tmp/x.sqlite' };

describe('migration env 구성(buildMigrationEnv)', () => {
  it('부모 프로세스의 STORIX_* 값을 상속하지 않는다', () => {
    const env = buildMigrationEnv(databaseEnv, {
      PATH: '/bin',
      HOME: '/home/u',
      STORIX_DB_SQLITE_PATH: '/local/dev.sqlite',
      STORIX_API_KEY: 'local-key',
    });
    assert.equal(env.STORIX_DB_SQLITE_PATH, '/tmp/x.sqlite');
    assert.equal(env.STORIX_API_KEY, undefined);
  });

  it('pnpm 실행에 필요한 PATH와 HOME만 부모에서 가져온다', () => {
    const env = buildMigrationEnv(databaseEnv, { PATH: '/bin', HOME: '/home/u', OTHER: 'x' });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.HOME, '/home/u');
    assert.equal(env.OTHER, undefined);
  });
});
