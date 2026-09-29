import { jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { DbDumpTool } from '../../src/jobs/db-dump.tool.js';
import { RestoreJob } from '../../src/jobs/restore.job.js';
import { RestoreUnsupportedBackupError } from '../../src/jobs/restore.errors.js';
import type { BackupRepository } from '../../src/persistence/backup.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';

describe('RestoreJob 백업 구조 검사', () => {
  let sourceDir: string;
  let storage: {
    list: jest.Mock;
    delete: jest.Mock<BlobStorage['delete']>;
    put: jest.Mock<BlobStorage['put']>;
  };
  let backupRepository: { hasExistingNamespaces: jest.Mock<() => Promise<boolean>> };
  let dumpTool: DbDumpTool & { restore: jest.Mock<DbDumpTool['restore']> };

  function createJob(force = false): RestoreJob {
    const values: Record<string, string> = {
      STORIX_RESTORE_SOURCE_DIR: sourceDir,
      STORIX_RESTORE_FORCE: String(force),
    };
    const config = {
      get: (key: string) => values[key],
      getOrThrow: (key: string) => values[key],
    } as unknown as ConfigService;
    return new RestoreJob(
      storage as unknown as BlobStorage,
      backupRepository as unknown as BackupRepository,
      dumpTool,
      config,
    );
  }

  beforeEach(async () => {
    sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-restore-layout-'));
    await fs.writeFile(path.join(sourceDir, 'test.dump'), 'dump');
    storage = {
      list: jest.fn(() => (async function* () {})()),
      delete: jest.fn<BlobStorage['delete']>().mockResolvedValue(undefined),
      put: jest.fn<BlobStorage['put']>().mockResolvedValue(undefined),
    };
    backupRepository = { hasExistingNamespaces: jest.fn<() => Promise<boolean>>().mockResolvedValue(false) };
    dumpTool = {
      dumpFileName: 'test.dump',
      dump: jest.fn<DbDumpTool['dump']>().mockResolvedValue(undefined),
      restore: jest.fn<DbDumpTool['restore']>().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await fs.rm(sourceDir, { recursive: true, force: true });
  });

  it('blobs/ 외의 하위 디렉터리가 있으면 기존 object 삭제와 DB 복구 전에 실패한다', async () => {
    await fs.mkdir(path.join(sourceDir, 'legacy-mirror'));

    await expect(createJob(true).run()).rejects.toBeInstanceOf(RestoreUnsupportedBackupError);

    expect(storage.list).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
    expect(dumpTool.restore).not.toHaveBeenCalled();
  });

  it('오류 메시지는 알 수 없는 디렉터리 이름을 포함한다', async () => {
    await fs.mkdir(path.join(sourceDir, 'legacy-mirror'));

    await expect(createJob().run()).rejects.toThrow('legacy-mirror');
  });

  it('blobs/만 있는 백업은 object를 복구한다', async () => {
    await fs.mkdir(path.join(sourceDir, 'blobs', 'ab'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'blobs', 'ab', 'one'), 'x');

    await expect(createJob().run()).resolves.toMatchObject({ restoredObjectCount: 1 });

    expect(storage.put).toHaveBeenCalledWith('ab/one', expect.anything());
  });

  it('dump 파일만 있는 백업(object 0건)은 성공한다', async () => {
    await expect(createJob().run()).resolves.toMatchObject({ restoredObjectCount: 0 });
  });
});
