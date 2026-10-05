import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { buildPgChildEnv, PgDumpCliTool } from '../../src/jobs/pg-dump-cli.tool.js';

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

describe('PgDumpCliTool.restore', () => {
  const originalPath = process.env.PATH;
  let binDir: string;
  let logFile: string;

  // PATH 앞에 실행 인자를 기록하는 가짜 psql·pg_restore를 둔다. 기록은 인자마다 NUL, 실행마다 RS로 구분한다.
  async function installFakeClient(name: string, exitCode = 0): Promise<void> {
    const file = path.join(binDir, name);
    await writeFile(
      file,
      `#!/bin/sh\n{ printf '%s\\0' "$(basename "$0")" "$@"; printf '\\036'; } >> '${logFile}'\nexit ${exitCode}\n`,
    );
    await chmod(file, 0o755);
  }

  async function invocations(): Promise<string[][]> {
    const log = await readFile(logFile, 'utf8').catch(() => '');
    return log
      .split('\x1e')
      .filter((record) => record.length > 0)
      .map((record) => record.split('\0').slice(0, -1));
  }

  function makeTool(): PgDumpCliTool {
    const values: Record<string, string> = {
      STORIX_DB_HOST: 'db.internal',
      STORIX_DB_PORT: '5433',
      STORIX_DB_USERNAME: 'restorer',
      STORIX_DB_PASSWORD: 'pw',
      STORIX_DB_NAME: 'storix',
    };
    return new PgDumpCliTool({
      get: (key: string) => values[key],
      getOrThrow: (key: string) => values[key],
    } as unknown as ConfigService);
  }

  beforeEach(async () => {
    binDir = await mkdtemp(path.join(tmpdir(), 'storix-fake-pg-'));
    logFile = path.join(binDir, 'invocations.log');
    process.env.PATH = `${binDir}:${originalPath}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await rm(binDir, { recursive: true, force: true });
  });

  it('접속 사용자 소유 테이블을 지운 뒤 소유자·권한 없이 한 트랜잭션으로 pg_restore를 실행한다', async () => {
    await installFakeClient('psql');
    await installFakeClient('pg_restore');

    await makeTool().restore('/backups/b/postgres.dump');

    const connection = ['-h', 'db.internal', '-p', '5433', '-U', 'restorer', '-d', 'storix'];
    const [psql, pgRestore, ...rest] = await invocations();
    expect(rest).toEqual([]);
    expect(psql.slice(0, 9)).toEqual(['psql', ...connection]);
    expect(psql).toEqual(expect.arrayContaining(['-X', '-v', 'ON_ERROR_STOP=1', '-c']));
    expect(psql.at(-1)).toContain('tableowner = current_user');
    expect(psql.at(-1)).toContain('DROP TABLE IF EXISTS public.%I CASCADE');
    expect(pgRestore).toEqual([
      'pg_restore',
      ...connection,
      '--no-owner',
      '--no-privileges',
      '--single-transaction',
      '--exit-on-error',
      '/backups/b/postgres.dump',
    ]);
  });

  it('테이블 삭제가 실패하면 pg_restore를 실행하지 않는다', async () => {
    await installFakeClient('psql', 2);
    await installFakeClient('pg_restore');

    await expect(makeTool().restore('/backups/b/postgres.dump')).rejects.toThrow('psql 종료 코드 2');
    expect((await invocations()).map((args) => args[0])).toEqual(['psql']);
  });
});
