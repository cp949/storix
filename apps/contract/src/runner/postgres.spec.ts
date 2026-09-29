import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPostgresEnv, postgresDatabaseName } from './postgres.ts';

describe('Postgres database 이름(postgresDatabaseName)', () => {
  it('실행 ID와 프로필을 붙이고 하이픈을 밑줄로 바꾼다', () => {
    assert.equal(postgresDatabaseName('a1b2c3d4', 'small-limits'), 'storix_a1b2c3d4_small_limits');
  });

  it('식별자에 쓸 수 없는 문자는 밑줄로 바꾼다', () => {
    assert.equal(postgresDatabaseName('run', 'Weird Name!'), 'storix_run_weird_name_');
  });
});

describe('Postgres 접속 env 구성(buildPostgresEnv)', () => {
  it('드라이버·접속 정보·database 이름을 STORIX_DB_*로 준다', () => {
    assert.deepEqual(buildPostgresEnv(54321, 'storix_run_default'), {
      STORIX_DB_DRIVER: 'postgres',
      STORIX_DB_HOST: '127.0.0.1',
      STORIX_DB_PORT: '54321',
      STORIX_DB_USERNAME: 'storix',
      STORIX_DB_PASSWORD: 'storix',
      STORIX_DB_NAME: 'storix_run_default',
    });
  });
});
