import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apiRoot, buildApp, stripSecretEnv } from './boot-env-file-harness.js';

// compose migrate 서비스와 같은 명령(typeorm CLI + dist data-source)으로 비밀값 해석을 확인한다.
// typeorm CLI는 bootstrapWithEnv()를 거치지 않으므로 data-source.ts의 최상위 await가 유일한 해석 지점이다.
function runProdMigration(env: NodeJS.ProcessEnv): { status: number | null; output: string } {
  const result = spawnSync(
    'pnpm',
    ['exec', 'typeorm', 'migration:run', '-d', 'dist/persistence/data-source.js'],
    {
      cwd: apiRoot,
      env,
      encoding: 'utf-8',
    },
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('typeorm CLI 경로의 비밀값 해석', () => {
  let workDir: string;

  beforeAll(() => {
    buildApp();
  }, 60000);

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'storix-secret-migrate-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // 호스트 환경에 남은 X·X_FILE·X_REF가 결과를 바꾸지 않도록 모두 비운다.
  const sqliteEnv = (): NodeJS.ProcessEnv => ({
    ...stripSecretEnv(process.env),
    STORIX_DB_DRIVER: 'sqlite',
    STORIX_DB_SQLITE_PATH: path.join(workDir, 'storix.sqlite'),
  });

  it('_FILE로 지정한 비밀값이 있어도 마이그레이션을 적용하고 0으로 끝난다', () => {
    const passwordFile = path.join(workDir, 'db_password');
    writeFileSync(passwordFile, 'db-password\n');

    const { status, output } = runProdMigration({ ...sqliteEnv(), STORIX_DB_PASSWORD_FILE: passwordFile });

    expect(output).not.toContain('비밀값 해석 실패');
    expect(status).toBe(0);
  }, 60000);

  it('_FILE 경로가 없으면 변수명과 실패 종류만 출력하고 0이 아닌 코드로 끝난다', () => {
    const { status, output } = runProdMigration({
      ...sqliteEnv(),
      STORIX_DB_PASSWORD_FILE: path.join(workDir, 'missing'),
    });

    expect(status).not.toBe(0);
    expect(output).toContain('STORIX_DB_PASSWORD(file): not-found');
  }, 60000);

  it('값과 _FILE을 함께 주면 값 없이 충돌로 실패한다', () => {
    const keyFile = path.join(workDir, 'api_key');
    writeFileSync(keyFile, 'file-value');

    const { status, output } = runProdMigration({
      ...sqliteEnv(),
      STORIX_API_KEY: 'env-secret-value-321',
      STORIX_API_KEY_FILE: keyFile,
    });

    expect(status).not.toBe(0);
    expect(output).toContain('STORIX_API_KEY(env+file): conflict');
    expect(output).not.toContain('env-secret-value-321');
  }, 60000);
});
