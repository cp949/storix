import { buildPgChildEnv } from '../../src/jobs/pg-dump-cli.tool.js';

describe('buildPgChildEnv', () => {
  it('허용 목록 변수와 PGPASSWORD만 넘긴다', () => {
    const env = buildPgChildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/root',
        TZ: 'Asia/Seoul',
        LANG: 'C.UTF-8',
        LC_ALL: 'C',
        PGSSLMODE: 'require',
        PGSSLROOTCERT: '/certs/root.crt',
        STORIX_DB_PASSWORD: 'db-secret',
        STORIX_API_KEY: 'api-secret',
        STORIX_ENCRYPTION_MASTER_KEY: 'master',
        ADAPTER_TOKEN: 'adapter-credential',
        NODE_OPTIONS: '--max-old-space-size=512',
      },
      'pw',
    );

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/root',
      TZ: 'Asia/Seoul',
      LANG: 'C.UTF-8',
      LC_ALL: 'C',
      PGSSLMODE: 'require',
      PGSSLROOTCERT: '/certs/root.crt',
      PGPASSWORD: 'pw',
    });
  });

  it('기존 PGPASSWORD는 인자로 받은 비밀번호로 덮어쓴다', () => {
    expect(buildPgChildEnv({ PGPASSWORD: 'old' }, 'new')).toEqual({ PGPASSWORD: 'new' });
  });

  it('값이 undefined인 변수는 넘기지 않는다', () => {
    expect(buildPgChildEnv({ PATH: undefined, PGHOST: undefined }, 'pw')).toEqual({ PGPASSWORD: 'pw' });
  });
});
