import { jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DbDumpTool } from '../../src/jobs/db-dump.tool.js';
import { RestoreJob } from '../../src/jobs/restore.job.js';
import {
  RestoreIncompleteBackupError,
  RestoreUnsupportedBackupError,
} from '../../src/jobs/restore.errors.js';
import type { BackupRepository } from '../../src/persistence/backup.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';

describe('RestoreJob 백업 구조 검사', () => {
  let sourceDir: string;
  let storage: {
    list: jest.Mock<(prefix?: string) => AsyncIterable<{ key: string }>>;
    delete: jest.Mock<BlobStorage['delete']>;
    put: jest.Mock<BlobStorage['put']>;
  };
  let backupRepository: { hasExistingNamespaces: jest.Mock<() => Promise<boolean>> };
  let dumpTool: DbDumpTool & { restore: jest.Mock<DbDumpTool['restore']> };

  function createJob(force: boolean | string = false, source: string = sourceDir): RestoreJob {
    const values: Record<string, string> = {
      STORIX_RESTORE_SOURCE_DIR: source,
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
    await fs.mkdir(path.join(sourceDir, 'blobs', 'blobs', 'ab'), { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'blobs', 'blobs', 'ab', 'one'), 'x');

    await expect(createJob().run()).resolves.toMatchObject({ restoredObjectCount: 1 });

    expect(storage.put).toHaveBeenCalledWith('blobs/ab/one', expect.anything());
  });

  it('dump 파일만 있는 백업(object 0건)은 성공한다', async () => {
    await expect(createJob().run()).resolves.toMatchObject({ restoredObjectCount: 0 });
  });

  it.each(['1', 'yes', 'ture'])(
    'STORIX_RESTORE_FORCE=%s는 true·false가 아니므로 생성을 거부한다',
    (value) => {
      expect(() => createJob(value)).toThrow(`STORIX_RESTORE_FORCE=${value}`);
    },
  );

  describe('완료되지 않은 백업(.partial)', () => {
    let partialDir: string;

    beforeEach(async () => {
      partialDir = `${sourceDir}.partial`;
      await fs.mkdir(path.join(partialDir, 'blobs', 'ab'), { recursive: true });
      await fs.writeFile(path.join(partialDir, 'test.dump'), 'dump');
      await fs.writeFile(path.join(partialDir, 'blobs', 'ab', 'one'), 'x');
    });

    afterEach(async () => {
      await fs.rm(partialDir, { recursive: true, force: true });
    });

    it('.partial 디렉터리는 DB 복구와 스토리지 호출 전에 거부한다', async () => {
      await expect(createJob(true, partialDir).run()).rejects.toBeInstanceOf(RestoreIncompleteBackupError);

      expect(backupRepository.hasExistingNamespaces).not.toHaveBeenCalled();
      expect(dumpTool.restore).not.toHaveBeenCalled();
      expect(storage.list).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('끝 슬래시가 붙은 경로도 거부한다', async () => {
      await expect(createJob(false, `${partialDir}${path.sep}`).run()).rejects.toBeInstanceOf(
        RestoreIncompleteBackupError,
      );
    });

    it('상대경로로 가리킨 .partial 디렉터리도 거부한다', async () => {
      const relative = path.relative(process.cwd(), partialDir);

      await expect(createJob(false, relative).run()).rejects.toBeInstanceOf(RestoreIncompleteBackupError);
    });

    it('중간 이름에만 .partial이 들어간 디렉터리는 거부하지 않는다', async () => {
      const named = path.join(sourceDir, 'a.partial.d');
      await fs.mkdir(named);
      await fs.writeFile(path.join(named, 'test.dump'), 'dump');

      await expect(createJob(false, named).run()).resolves.toMatchObject({ restoredObjectCount: 0 });
    });
  });

  describe('prefix 밖 key가 섞인 이전 백업', () => {
    async function writeMirrored(key: string): Promise<void> {
      const filePath = path.join(sourceDir, 'blobs', ...key.split('/'));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'x');
    }

    it('prefix 밖 key는 put하지 않고 건너뛴 건수와 key를 경고로 남긴다', async () => {
      await writeMirrored('blobs/ab/one');
      await writeMirrored('upload-staging/part');
      await writeMirrored('logs/app.log');
      await writeMirrored('other.txt');
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        await expect(createJob().run()).resolves.toMatchObject({ restoredObjectCount: 2 });

        expect(storage.put.mock.calls.map(([key]) => key).sort()).toEqual([
          'blobs/ab/one',
          'upload-staging/part',
        ]);
        const message = String(warn.mock.calls[0]?.[0]);
        expect(message).toContain('2건');
        expect(message).toContain('logs/app.log');
      } finally {
        warn.mockRestore();
      }
    });

    it('force 복구에서 prefix 밖 key는 백업 key 집합에도 들어가지 않는다', async () => {
      await writeMirrored('blobs/ab/one');
      await writeMirrored('logs/app.log');
      backupRepositoryHasData();
      storage.list.mockImplementation(() =>
        (async function* () {
          yield { key: 'blobs/ab/one' };
        })(),
      );

      await expect(createJob(true).run()).resolves.toMatchObject({ restoredObjectCount: 1 });

      expect(storage.delete).not.toHaveBeenCalled();
    });

    function backupRepositoryHasData(): void {
      backupRepository.hasExistingNamespaces.mockResolvedValue(true);
    }
  });

  describe('force 복구 순서', () => {
    function listsExisting(...keys: string[]): void {
      storage.list.mockImplementation((prefix?: string) =>
        (async function* () {
          for (const key of keys) {
            if (prefix === undefined || key.startsWith(prefix)) {
              yield { key };
            }
          }
        })(),
      );
    }

    async function writeBackupBlob(key: string): Promise<void> {
      const filePath = path.join(sourceDir, 'blobs', ...key.split('/'));
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'x');
    }

    beforeEach(() => {
      backupRepository.hasExistingNamespaces.mockResolvedValue(true);
    });

    it('DB 복구가 실패하면 스토리지 object를 조회·삭제·복원하지 않고 같은 오류를 던진다', async () => {
      await writeBackupBlob('blobs/ab/one');
      listsExisting('blobs/live/a', 'blobs/live/b');
      dumpTool.restore.mockRejectedValue(new Error('pg_restore 종료 코드 1'));

      await expect(createJob(true).run()).rejects.toThrow('pg_restore 종료 코드 1');

      expect(storage.list).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('DB 복구 → object put → 백업에 없는 object 삭제 순서로 실행한다', async () => {
      await writeBackupBlob('blobs/ab/one');
      listsExisting('blobs/ab/one', 'blobs/stray/x');
      const calls: string[] = [];
      dumpTool.restore.mockImplementation(async () => {
        calls.push('restore');
      });
      storage.put.mockImplementation(async (key) => {
        calls.push(`put:${key}`);
      });
      storage.delete.mockImplementation(async (key) => {
        calls.push(`delete:${key}`);
      });

      await createJob(true).run();

      expect(calls).toEqual(['restore', 'put:blobs/ab/one', 'delete:blobs/stray/x']);
    });

    it('백업에 있는 key는 지우지 않고 없는 key만 지운다', async () => {
      await writeBackupBlob('blobs/ab/one');
      await writeBackupBlob('blobs/cd/two');
      listsExisting('blobs/ab/one', 'blobs/cd/two', 'blobs/ef/stray', 'blobs/gh/stray');

      await expect(createJob(true).run()).resolves.toMatchObject({ restoredObjectCount: 2 });

      expect(storage.delete.mock.calls.map(([key]) => key)).toEqual(['blobs/ef/stray', 'blobs/gh/stray']);
    });

    it('object put가 실패하면 기존 object를 삭제하지 않는다', async () => {
      await writeBackupBlob('blobs/ab/one');
      listsExisting('blobs/stray/x');
      storage.put.mockRejectedValue(new Error('put 실패'));

      await expect(createJob(true).run()).rejects.toThrow('put 실패');

      expect(storage.delete).not.toHaveBeenCalled();
    });

    it('백업에 없는 object 삭제가 실패하면 복구를 실패로 끝낸다', async () => {
      await writeBackupBlob('blobs/ab/one');
      listsExisting('blobs/stray/x');
      storage.delete.mockRejectedValue(new Error('delete 실패'));

      await expect(createJob(true).run()).rejects.toThrow('delete 실패');
    });

    it('blobs/가 없는 0건 백업은 force에서 Storix prefix의 기존 object를 전부 삭제한다', async () => {
      listsExisting('blobs/live/a', 'blobs/live/b');

      await expect(createJob(true).run()).resolves.toMatchObject({ restoredObjectCount: 0 });

      expect(storage.delete.mock.calls.map(([key]) => key)).toEqual(['blobs/live/a', 'blobs/live/b']);
    });

    it('force 복구는 Storix prefix 밖의 object를 조회 대상에서 제외해 지우지 않는다', async () => {
      await writeBackupBlob('blobs/ab/one');
      listsExisting('blobs/ab/one', 'blobs/stray/x', 'upload-staging/old', 'logs/app.log', 'other.txt');

      await createJob(true).run();

      expect(storage.list.mock.calls.map(([prefix]) => prefix)).toEqual(['blobs/', 'upload-staging/']);
      expect(storage.delete.mock.calls.map(([key]) => key)).toEqual(['blobs/stray/x', 'upload-staging/old']);
    });

    it('force가 아니면 기존 object를 지우지 않는다', async () => {
      await writeBackupBlob('blobs/ab/one');
      backupRepository.hasExistingNamespaces.mockResolvedValue(false);
      listsExisting('blobs/live/a');

      await createJob(false).run();

      expect(storage.list).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });
});
