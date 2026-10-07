import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp, runMigrations, runProcess, stripSecretEnv } from './boot-env-file-harness.js';

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

  function preparePolicyBoot(policy: unknown): {
    readonly env: NodeJS.ProcessEnv;
    readonly policyPath: string;
  } {
    const sqlitePath = path.join(workDir, 'storix.sqlite');
    const policyPath = path.join(workDir, 'upload-sessions.json');
    runMigrations(sqlitePath);
    writeFileSync(policyPath, JSON.stringify(policy));
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
        `STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH=${policyPath}`,
        'STORIX_PORT=0',
        '',
      ].join('\n'),
    );
    const env = {
      ...stripSecretEnv(process.env),
      STORIX_DB_DRIVER: undefined,
      STORIX_DB_SQLITE_PATH: undefined,
      STORIX_PORT: undefined,
      STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH: undefined,
      STORIX_VFS_CAPABILITIES_CONFIG_PATH: undefined,
    };
    return { env, policyPath };
  }

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
      env: { ...stripSecretEnv(process.env), STORIX_DB_DRIVER: undefined },
      timeoutMs: 20000,
      untilOutputIncludes: 'Nest application successfully started',
    });

    expect(output).not.toContain('DataTypeNotSupportedError');
    expect(output).toContain('Nest application successfully started');
  }, 30000);

  it('STORIX_PORT가 정수 표기가 아니면 부팅을 거부하고 같은 이름의 socket 파일을 만들지 않는다', async () => {
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
        'STORIX_PORT=3000abc',
        '',
      ].join('\n'),
    );

    const { output, exitCode } = await runProcess({
      cwd: workDir,
      distFile: 'main.js',
      env: { ...stripSecretEnv(process.env), STORIX_DB_DRIVER: undefined },
      timeoutMs: 20000,
      untilOutputIncludes: 'Nest application successfully started',
    });

    expect(output).not.toContain('Nest application successfully started');
    expect(output).toContain('잘못된 정수 환경변수 값: 3000abc');
    expect(exitCode).toBe(1);
    expect(existsSync(path.join(workDir, '3000abc'))).toBe(false);
  }, 30000);

  it('전역 조각 크기가 staging 한도를 넘으면 실제 main 시작을 거부한다', async () => {
    const { env, policyPath } = preparePolicyBoot({
      global: { maxStagedBytes: '1048576', maxActiveSessions: 10, partSizeBytes: 16777216 },
      namespaces: {},
    });
    const { output, exitCode } = await runProcess({
      cwd: workDir,
      distFile: 'main.js',
      env,
      timeoutMs: 20000,
      untilOutputIncludes: 'Nest application successfully started',
    });
    expect(exitCode).toBe(1);
    expect(output).not.toContain('Nest application successfully started');
    expect(output).toContain(policyPath);
    expect(output).toContain('global.partSizeBytes=16777216');
    expect(output).toContain('global.maxStagedBytes=1048576');
  }, 30000);

  it('capability가 비활성인 namespace의 상속 조각 크기가 한도를 넘으면 시작을 거부한다', async () => {
    const namespaceId = '123e4567-e89b-42d3-a456-426614174000';
    const { env, policyPath } = preparePolicyBoot({
      global: { maxStagedBytes: '100', maxActiveSessions: 10, partSizeBytes: 16 },
      namespaces: { [namespaceId]: { maxStagedBytes: '10', maxActiveSessions: 2 } },
    });
    const { output, exitCode } = await runProcess({
      cwd: workDir,
      distFile: 'main.js',
      env,
      timeoutMs: 20000,
      untilOutputIncludes: 'Nest application successfully started',
    });
    expect(exitCode).toBe(1);
    expect(output).not.toContain('Nest application successfully started');
    expect(output).toContain(policyPath);
    expect(output).toContain(`namespaces.${namespaceId}.partSizeBytes=16`);
    expect(output).toContain('global.partSizeBytes');
    expect(output).toContain(`namespaces.${namespaceId}.maxStagedBytes=10`);
  }, 30000);

  it('전역보다 큰 namespace 조각 크기가 자체 한도 이하이면 실제 main이 시작된다', async () => {
    const namespaceId = '123e4567-e89b-42d3-a456-426614174000';
    const { env } = preparePolicyBoot({
      global: { maxStagedBytes: '100', maxActiveSessions: 10, partSizeBytes: 4 },
      namespaces: { [namespaceId]: { maxStagedBytes: '64', maxActiveSessions: 2, partSizeBytes: 64 } },
    });
    const { output } = await runProcess({
      cwd: workDir,
      distFile: 'main.js',
      env,
      timeoutMs: 20000,
      untilOutputIncludes: 'Nest application successfully started',
    });
    expect(output).toContain('Nest application successfully started');
    expect(output).not.toContain('Upload session part size exceeds staging limit');
  }, 30000);
});
