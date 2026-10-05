import { jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import { BackupJob } from '../../src/jobs/backup.job.js';
import type { DbDumpTool } from '../../src/jobs/db-dump.tool.js';
import type { BackupRepository } from '../../src/persistence/backup.repository.js';
import type { BlobObjectInfo, BlobStorage } from '../../src/storage/blob-storage.js';

describe('BackupJob 스토리지 미러 범위', () => {
  let backupRoot: string;
  let objects: Map<string, string>;
  let storage: {
    list: jest.Mock<(prefix?: string) => AsyncIterable<BlobObjectInfo>>;
    get: jest.Mock<BlobStorage['get']>;
  };
  let dumpTool: DbDumpTool;

  function createJob(): BackupJob {
    const config = { getOrThrow: () => backupRoot } as unknown as ConfigService;
    const backupRepository = {
      countEncryptedNamespaces: async () => 0,
    } as unknown as BackupRepository;
    return new BackupJob(storage as unknown as BlobStorage, backupRepository, dumpTool, config);
  }

  beforeEach(async () => {
    backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'storix-backup-scope-'));
    objects = new Map();
    storage = {
      list: jest.fn((prefix?: string) =>
        (async function* () {
          for (const key of [...objects.keys()].sort()) {
            if (prefix === undefined || key.startsWith(prefix)) {
              yield { key, lastModified: new Date(0) };
            }
          }
        })(),
      ),
      get: jest.fn<BlobStorage['get']>(async (key) => Readable.from(objects.get(key) ?? '')),
    };
    dumpTool = {
      dumpFileName: 'test.dump',
      dump: jest.fn<DbDumpTool['dump']>(async (target) => fs.writeFile(target, 'dump')),
      restore: jest.fn<DbDumpTool['restore']>().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    await fs.rm(backupRoot, { recursive: true, force: true });
  });

  it('Storix prefix(blobs/·upload-staging/)의 object만 복사하고 같은 버킷의 다른 object는 건드리지 않는다', async () => {
    objects.set('blobs/ab/one', 'blob');
    objects.set('upload-staging/part-1', 'part');
    objects.set('logs/app.log', 'foreign');
    objects.set('logs/', '');
    objects.set('other.txt', 'foreign');

    const result = await createJob().run();

    expect(result.copiedObjectCount).toBe(2);
    expect(storage.list.mock.calls.map(([prefix]) => prefix)).toEqual(['blobs/', 'upload-staging/']);
    expect(await fs.readFile(path.join(result.backupDir, 'blobs', 'blobs', 'ab', 'one'), 'utf8')).toBe(
      'blob',
    );
    expect(await fs.readFile(path.join(result.backupDir, 'blobs', 'upload-staging', 'part-1'), 'utf8')).toBe(
      'part',
    );
    await expect(fs.access(path.join(result.backupDir, 'blobs', 'logs'))).rejects.toThrow();
    await expect(fs.access(path.join(result.backupDir, 'blobs', 'other.txt'))).rejects.toThrow();
  });

  it.each([
    ['중복 구분자', 'blobs/ab//one'],
    ['끝 슬래시(디렉터리 marker)', 'blobs/ab/'],
    ['현재 디렉터리 segment', 'blobs/./one'],
  ])(
    'prefix 안에서 경로 정규화로 key가 달라지면(%s) 백업을 실패시키고 key를 오류에 담는다',
    async (_name, key) => {
      objects.set(key, 'x');

      await expect(createJob().run()).rejects.toThrow(key);

      const entries = await fs.readdir(backupRoot);
      expect(entries.every((entry) => entry.endsWith('.partial'))).toBe(true);
    },
  );

  it('object가 하나도 없으면 blobs/ 디렉터리를 만들지 않고 성공한다', async () => {
    objects.set('logs/app.log', 'foreign');

    const result = await createJob().run();

    expect(result.copiedObjectCount).toBe(0);
    await expect(fs.access(path.join(result.backupDir, 'blobs'))).rejects.toThrow();
  });
});
