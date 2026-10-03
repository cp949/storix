import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp, runMigrations, runProcess, stripSecretEnv } from './boot-env-file-harness.js';

// main.ts의 실제 배포 진입점에서 비밀값 해석 순서를 확인한다.
// 해석은 루트 모듈 import 전에 끝나야 하므로 별도 프로세스(dist)로 띄운다(main-boot-env-file.integration-spec.ts와 같은 이유).
describe('main.ts 비밀값 파일 소스', () => {
  let workDir: string;
  let sqlitePath: string;

  beforeAll(() => {
    buildApp();
  }, 60000);

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'storix-secret-boot-'));
    sqlitePath = path.join(workDir, 'storix.sqlite');
    runMigrations(sqlitePath);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // .env.example을 복사한 배포처럼 STORIX_API_KEY= 빈 줄을 둔다.
  function writeEnv(lines: string[]): void {
    writeFileSync(
      path.join(workDir, '.env'),
      [
        'STORIX_DB_DRIVER=sqlite',
        `STORIX_DB_SQLITE_PATH=${sqlitePath}`,
        'STORIX_STORAGE_ENDPOINT=127.0.0.1',
        'STORIX_STORAGE_ACCESS_KEY=test-access',
        'STORIX_STORAGE_SECRET_KEY=test-secret',
        'STORIX_STORAGE_BUCKET=test-bucket',
        'STORIX_PORT=0',
        ...lines,
        '',
      ].join('\n'),
    );
  }

  // 호스트 셸의 비밀값 변수와 STORIX_DB_DRIVER를 모두 비운다.
  const shellEnv = (): NodeJS.ProcessEnv => ({ ...stripSecretEnv(process.env), STORIX_DB_DRIVER: undefined });

  it('빈 STORIX_API_KEY와 STORIX_API_KEY_FILE을 함께 두면 파일 키로 부팅한다', async () => {
    const keyFile = path.join(workDir, 'api_key');
    writeFileSync(keyFile, 'file-key-0123456789\r\n');
    writeEnv(['STORIX_API_KEY=', `STORIX_API_KEY_FILE=${keyFile}`]);

    const { output } = await runProcess({
      cwd: workDir,
      distFile: 'main.js',
      env: shellEnv(),
      timeoutMs: 20000,
      untilOutputIncludes: 'Nest application successfully started',
    });

    expect(output).toContain('Nest application successfully started');
  }, 30000);

  it('STORIX_API_KEY_FILE 경로가 없으면 변수명과 실패 종류를 출력하고 종료 코드 1로 끝난다', async () => {
    writeEnv([`STORIX_API_KEY_FILE=${path.join(workDir, 'missing')}`]);

    const { output, exitCode } = await runProcess({ cwd: workDir, distFile: 'main.js', env: shellEnv() });

    expect(exitCode).toBe(1);
    expect(output).toContain('STORIX_API_KEY(file): not-found');
  }, 30000);

  it('STORIX_API_KEY를 어떤 방식으로도 주지 않으면 부팅이 실패한다', async () => {
    writeEnv([]);

    const { output, exitCode } = await runProcess({ cwd: workDir, distFile: 'main.js', env: shellEnv() });

    expect(exitCode).toBe(1);
    expect(output).toContain('STORIX_API_KEY');
  }, 30000);
});
