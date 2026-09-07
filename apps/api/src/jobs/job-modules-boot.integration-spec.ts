import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Module, type INestApplicationContext, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { BackupJobModule } from './backup-job.module.js';
import { BackupJob } from './backup.job.js';
import { GcJobModule } from './gc-job.module.js';
import { GcJob } from './gc.job.js';
import { RestoreJobModule } from './restore-job.module.js';
import { RestoreJob } from './restore.job.js';
import { ObservabilityModule } from '../observability/observability.module.js';

// 세 진입점(gc-main/backup-main/restore-main)의 루트 모듈 구성을 그대로 복제한다.
// 진입점 파일은 import만 해도 bootstrap()이 실행돼 테스트에서 재사용할 수 없다.
// ignoreEnvFile: true는 진입점과의 유일한 차이다 — 컨테이너에는 .env 파일이
// 없으므로, 개발자 로컬의 .env가 "누락된 env var"를 가려 버그를 숨기면 안 된다.
const configModule = ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true });

@Module({ imports: [configModule, ObservabilityModule, GcJobModule] })
class GcAppModuleFixture {}

@Module({ imports: [configModule, ObservabilityModule, BackupJobModule] })
class BackupAppModuleFixture {}

@Module({ imports: [configModule, ObservabilityModule, RestoreJobModule] })
class RestoreAppModuleFixture {}

describe('job 진입점 모듈 부팅 통합', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let workDir: string;
  let savedEnv: NodeJS.ProcessEnv;

  // docker-compose.yml의 gc/backup/restore 서비스가 실제로 넘기는 env var 전체
  // 집합. 어떤 서비스든 이 중 자기 몫만 설정하므로, 부팅 검증 전에 이 키들을
  // 전부 지운 뒤 대상 서비스 몫만 다시 채운다(개발자 셸의 값이 새어들어와
  // "다른 job의 env var가 있어서 우연히 통과"하는 상황을 막는다).
  const ALL_JOB_ENV_KEYS = [
    'DB_HOST',
    'DB_PORT',
    'DB_USERNAME',
    'DB_PASSWORD',
    'DB_NAME',
    'MINIO_ENDPOINT',
    'MINIO_PORT',
    'MINIO_USE_SSL',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
    'MINIO_BUCKET',
    'MINIO_PATH_STYLE',
    'MINIO_REGION',
    'ORPHAN_GRACE_PERIOD',
    'BACKUP_DIR',
    'RESTORE_SOURCE_DIR',
    'RESTORE_FORCE',
  ];

  // 세 서비스에 공통으로 들어가는 부분(docker-compose.yml의 gc/backup/restore
  // environment 블록 중 job 전용 변수를 뺀 나머지).
  function sharedComposeEnv(): Record<string, string> {
    return {
      DB_HOST: pgContainer.getHost(),
      DB_PORT: String(pgContainer.getPort()),
      DB_USERNAME: pgContainer.getUsername(),
      DB_PASSWORD: pgContainer.getPassword(),
      DB_NAME: pgContainer.getDatabase(),
      MINIO_ENDPOINT: minioContainer.getHost(),
      MINIO_PORT: String(minioContainer.getPort()),
      MINIO_USE_SSL: 'false',
      MINIO_ACCESS_KEY: minioContainer.getUsername(),
      MINIO_SECRET_KEY: minioContainer.getPassword(),
      MINIO_BUCKET: 'storix-job-boot-test',
      // compose가 `${VAR:-}`로 넘기는 값은 미설정이 아니라 빈 문자열로 도착한다.
      MINIO_PATH_STYLE: '',
      MINIO_REGION: '',
    };
  }

  async function bootWith(
    env: Record<string, string>,
    moduleClass: Type<unknown>,
  ): Promise<INestApplicationContext> {
    for (const key of ALL_JOB_ENV_KEYS) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    return NestFactory.createApplicationContext(moduleClass, { abortOnError: false, logger: false });
  }

  beforeAll(async () => {
    [pgContainer, minioContainer] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start(),
    ]);
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-job-boot-test-'));
    savedEnv = { ...process.env };
  }, 180000);

  afterAll(async () => {
    for (const key of ALL_JOB_ENV_KEYS) {
      delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    await Promise.all([pgContainer.stop(), minioContainer.stop()]);
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('gc 서비스 env var만으로 GcJobModule이 부팅되고 BackupJob/RestoreJob은 생성되지 않는다', async () => {
    const context = await bootWith(
      { ...sharedComposeEnv(), ORPHAN_GRACE_PERIOD: '86400' },
      GcAppModuleFixture,
    );

    try {
      expect(context.get(GcJob)).toBeInstanceOf(GcJob);
      // 다른 job이 이 컨텍스트에 섞여 들어오지 않았음을 확인한다 — 섞이면 그쪽
      // 생성자의 getOrThrow가 gc 컨테이너 부팅을 통째로 깨뜨린다.
      expect(() => context.get(BackupJob)).toThrow();
      expect(() => context.get(RestoreJob)).toThrow();
    } finally {
      await context.close();
    }
  }, 60000);

  it('backup 서비스 env var만으로 BackupJobModule이 부팅되고 GcJob/RestoreJob은 생성되지 않는다', async () => {
    const context = await bootWith(
      { ...sharedComposeEnv(), BACKUP_DIR: workDir },
      BackupAppModuleFixture,
    );

    try {
      expect(context.get(BackupJob)).toBeInstanceOf(BackupJob);
      expect(() => context.get(GcJob)).toThrow();
      expect(() => context.get(RestoreJob)).toThrow();
    } finally {
      await context.close();
    }
  }, 60000);

  it('restore 서비스 env var만으로 RestoreJobModule이 부팅되고 GcJob/BackupJob은 생성되지 않는다', async () => {
    const context = await bootWith(
      { ...sharedComposeEnv(), RESTORE_SOURCE_DIR: path.join(workDir, '2026-09-08T12-00-00-000Z'), RESTORE_FORCE: 'false' },
      RestoreAppModuleFixture,
    );

    try {
      expect(context.get(RestoreJob)).toBeInstanceOf(RestoreJob);
      expect(() => context.get(GcJob)).toThrow();
      expect(() => context.get(BackupJob)).toThrow();
    } finally {
      await context.close();
    }
  }, 60000);

  it('RESTORE_SOURCE_DIR가 빈 문자열이면(compose 기본값) 부팅 단계에서 명확히 실패한다', async () => {
    // compose는 `${RESTORE_SOURCE_DIR:-}`로 넘기므로 미설정 시 빈 문자열이
    // 도착하고, ConfigService.getOrThrow는 빈 문자열을 통과시킨다. 이 경우
    // sourceDir가 ''가 되어 상대경로 'postgres.dump'를 보게 되므로 RestoreJob이
    // 직접 막는다.
    await expect(
      bootWith({ ...sharedComposeEnv(), RESTORE_SOURCE_DIR: '', RESTORE_FORCE: 'false' }, RestoreAppModuleFixture),
    ).rejects.toThrow('RESTORE_SOURCE_DIR가 비어 있음');
  }, 60000);
});
