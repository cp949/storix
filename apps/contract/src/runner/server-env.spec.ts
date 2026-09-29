import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { buildServerEnv } from './server-env.ts';

const base = {
  port: 4123,
  apiKey: 'api-key',
  adminKey: 'admin-key',
  profileEnv: {},
  databaseEnv: { STORIX_DB_DRIVER: 'sqlite', STORIX_DB_SQLITE_PATH: '/tmp/x.sqlite' },
  storageEnv: { STORIX_STORAGE_ENDPOINT: '127.0.0.1' },
};

describe('서버 env 구성(buildServerEnv)', () => {
  afterEach(() => {
    delete process.env.STORIX_MAX_FILE_SIZE_BYTES;
  });

  it('포트와 두 API key를 문자열로 넣는다', () => {
    const env = buildServerEnv(base);
    assert.equal(env.STORIX_PORT, '4123');
    assert.equal(env.STORIX_API_KEY, 'api-key');
    assert.equal(env.STORIX_ADMIN_API_KEY, 'admin-key');
  });

  it('DB와 저장소 env를 그대로 전달한다', () => {
    const env = buildServerEnv(base);
    assert.equal(env.STORIX_DB_DRIVER, 'sqlite');
    assert.equal(env.STORIX_STORAGE_ENDPOINT, '127.0.0.1');
  });

  it('부모 프로세스의 STORIX_* 값을 상속하지 않는다', () => {
    process.env.STORIX_MAX_FILE_SIZE_BYTES = '1';
    assert.equal(buildServerEnv(base).STORIX_MAX_FILE_SIZE_BYTES, undefined);
  });

  it('프로필 env가 다른 값을 덮어쓴다', () => {
    const env = buildServerEnv({ ...base, profileEnv: { STORIX_MAX_FILE_SIZE_BYTES: '1024' } });
    assert.equal(env.STORIX_MAX_FILE_SIZE_BYTES, '1024');
  });
});
