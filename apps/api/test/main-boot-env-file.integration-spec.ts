import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp, runMigrations, runProcess } from './boot-env-file-harness.js';

// main.ts는 실제 배포 진입점(`node dist/main.js`)을 별도 프로세스로 띄워야
// 검증할 수 있다 — job-modules-boot.integration-spec.ts처럼 같은 jest 워커
// 안에서 모듈 구성을 복제해 NestFactory로 띄우는 방식은 쓸 수 없다. ES 모듈은
// 프로세스당 한 번만 평가되므로, "AppModule을 정적 import하면 .env 로딩보다
// 먼저 엔티티의 드라이버 상수가 얼어붙는다"는 이번 버그의 타이밍 자체가
// 같은 프로세스에서는 재현되지 않는다. ts-node/esm 로더는 main.ts가 거치는
// @nestjs/config 경로에서 별도의 해석 오류(.js.js 이중 확장자)를 일으켜
// 사용할 수 없어, dist 빌드가 유일하게 안정적인 실행 경로다.
describe('main.ts 부팅 순서 (.env 파일 전용 드라이버 설정)', () => {
  let workDir: string;

  beforeAll(() => {
    buildApp();
  }, 60000);

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'storix-boot-env-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('STORIX_DB_DRIVER를 쉘에 export하지 않고 .env 파일에만 설정해도 정상 부팅된다', async () => {
    const sqlitePath = path.join(workDir, 'storix.sqlite');
    runMigrations(sqlitePath);

    writeFileSync(
      path.join(workDir, '.env'),
      [
        'STORIX_DB_DRIVER=sqlite',
        `STORIX_DB_SQLITE_PATH=${sqlitePath}`,
        'STORIX_API_KEY=test-key-0123456789',
        'STORIX_STORAGE_ENDPOINT=127.0.0.1',
        'STORIX_STORAGE_ACCESS_KEY=test-access',
        'STORIX_STORAGE_SECRET_KEY=test-secret',
        'STORIX_STORAGE_BUCKET=test-bucket',
        'STORIX_PORT=0',
        '',
      ].join('\n'),
    );

    // 버그 재현 조건: STORIX_DB_DRIVER는 .env 파일에만 있고 쉘 환경에는 없다.
    const { output } = await runProcess({
      cwd: workDir,
      distFile: 'main.js',
      env: { ...process.env, STORIX_DB_DRIVER: undefined },
      timeoutMs: 20000,
      untilOutputIncludes: 'Nest application successfully started',
    });

    expect(output).not.toContain('DataTypeNotSupportedError');
    expect(output).toContain('Nest application successfully started');
  }, 30000);
});
