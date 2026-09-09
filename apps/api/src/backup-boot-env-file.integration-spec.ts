import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildApp, runMigrations, runProcess } from './boot-env-file-harness.js';

// backup-main.ts는 main.ts와 같은 이유로 별도 프로세스(`node dist/backup-main.js`)를
// 띄워야 검증할 수 있다 — main-boot-env-file.integration-spec.ts 참고. gc-main.ts와
// 같은 CLI형 진입점이라 특정 로그 문구를 기다리지 않고 프로세스가 스스로 종료할
// 때까지 기다린다.
describe('backup-main.ts 부팅 순서 (.env 파일 전용 드라이버 설정)', () => {
  let workDir: string;

  beforeAll(() => {
    buildApp();
  }, 60000);

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'storix-backup-boot-env-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('STORIX_DB_DRIVER를 쉘에 export하지 않고 .env 파일에만 설정해도 DataSource가 정상 초기화된다', async () => {
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
        `STORIX_BACKUP_DIR=${path.join(workDir, 'backup-out')}`,
        '',
      ].join('\n'),
    );

    // 버그 재현 조건: STORIX_DB_DRIVER는 .env 파일에만 있고 쉘 환경에는 없다.
    // MinIO는 실제로 떠 있지 않아 BackupJob.run()은 ECONNREFUSED로 실패하지만,
    // 그건 DB 계층을 통과했다는 증거다 — DataTypeNotSupportedError만 없으면 된다.
    const { output } = await runProcess({
      cwd: workDir,
      distFile: 'backup-main.js',
      env: { ...process.env, STORIX_DB_DRIVER: undefined },
      timeoutMs: 15000,
    });

    expect(output).not.toContain('DataTypeNotSupportedError');
    expect(output).toContain('TypeOrmModule dependencies initialized');
  }, 30000);
});
