import { jest } from '@jest/globals';
import { createCipheriv, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import type { BlobStorage } from '../storage/blob-storage.js';
import { StorageKeyGenerator } from '../storage/storage-key-generator.js';
import { VfsFileTooLargeError } from '../storage/storage.errors.js';
import { NamespaceResourceLimits, VfsNodeRecord, VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { ContentService } from './content.service.js';
import { PathResolver } from './path-resolver.js';
import { VfsIsDirectoryError, VfsNodeNotFoundError } from './vfs.errors.js';

const NAMESPACE_ID = '11111111-1111-1111-1111-111111111111';
const NONE_LIMITS = {
  maxFileSizeBytes: null,
  maxSyncDeleteNodes: null,
  maxSyncCopyNodes: null,
  encryptionPolicy: 'NONE',
} as const;

function makeNode(overrides: Partial<VfsNodeRecord> = {}): VfsNodeRecord {
  return {
    id: 'node-1',
    name: 'a.txt',
    type: 'FILE',
    blobId: 'blob-1',
    size: '5',
    mimeType: 'text/plain',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    version: 1,
    ...overrides,
  };
}

function makeRoot(): VfsNodeRecord {
  return makeNode({ id: 'root', name: '', type: 'DIRECTORY', blobId: null, size: null, mimeType: null });
}

describe('ContentService', () => {
  let repo: {
    getRootWithLimits: jest.Mock<() => Promise<{ root: VfsNodeRecord; limits: NamespaceResourceLimits } | null>>;
    resolvePath: jest.Mock<() => Promise<VfsNodeRecord | null>>;
    touchFile: jest.Mock<() => Promise<{ kind: string; node: VfsNodeRecord }>>;
    putFileContent: jest.Mock<() => Promise<{ kind: string; node: VfsNodeRecord }>>;
    getBlobStorageInfo: jest.Mock<() => Promise<{ storageKey: string; encryptionIv: Buffer | null } | null>>;
  };
  let blobStorage: {
    put: jest.Mock<() => Promise<void>>;
    get: jest.Mock<() => Promise<Readable>>;
    delete: jest.Mock<() => Promise<void>>;
    list: jest.Mock;
  };
  let config: { get: jest.Mock<(key: string) => string | undefined> };
  let masterKey: Buffer | null;
  let service: ContentService;

  function createService(): ContentService {
    return new ContentService(
      new PathResolver(),
      repo as unknown as VfsNodeRepository,
      new StorageKeyGenerator(),
      blobStorage as unknown as BlobStorage,
      masterKey,
      config as unknown as ConfigService,
    );
  }

  beforeEach(() => {
    repo = {
      getRootWithLimits: jest.fn(),
      resolvePath: jest.fn(),
      touchFile: jest.fn(),
      putFileContent: jest.fn(),
      getBlobStorageInfo: jest.fn(),
    };
    blobStorage = {
      put: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      get: jest.fn(),
      delete: jest.fn(),
      list: jest.fn(),
    };
    config = {
      // 기존 getOrThrow 스텁이 모든 키에 '1000'을 돌려주던 것과 같은 조건을 유지한다.
      get: jest
        .fn<(key: string) => string | undefined>()
        .mockImplementation((key) => (key === 'STORIX_MAX_FILE_SIZE_BYTES' ? '1000' : undefined)),
    };
    masterKey = null;
    service = createService();
  });

  describe('touch', () => {
    it('root 경로(/)는 VfsIsDirectoryError를 던진다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });

      await expect(service.touch(NAMESPACE_ID, '/', false)).rejects.toThrow(VfsIsDirectoryError);
      expect(blobStorage.put).not.toHaveBeenCalled();
    });

    it('0-byte Blob을 업로드하고 repository에 위임한다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.touchFile.mockResolvedValue({ kind: 'created', node: makeNode() });

      const result = await service.touch(NAMESPACE_ID, '/a.txt', false);

      expect(blobStorage.put).toHaveBeenCalledTimes(1);
      expect(repo.touchFile).toHaveBeenCalledWith(
        NAMESPACE_ID,
        'root',
        ['a.txt'],
        false,
        expect.objectContaining({ size: '0', mimeType: 'application/octet-stream', encryptionIv: null }),
      );
      expect(result.status).toBe(201);
    });

    it('기존 file을 touch하면 200을 반환한다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.touchFile.mockResolvedValue({ kind: 'replaced', node: makeNode() });

      const result = await service.touch(NAMESPACE_ID, '/a.txt', false);

      expect(result.status).toBe(200);
    });

    it('ENCRYPTED namespace에서 touch하면 IV를 생성해 repository에 전달한다', async () => {
      masterKey = randomBytes(32);
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({
        root: makeRoot(),
        limits: { ...NONE_LIMITS, encryptionPolicy: 'ENCRYPTED' },
      });
      repo.touchFile.mockResolvedValue({ kind: 'created', node: makeNode() });

      await service.touch(NAMESPACE_ID, '/a.txt', false);

      expect(repo.touchFile).toHaveBeenCalledWith(
        NAMESPACE_ID,
        'root',
        ['a.txt'],
        false,
        expect.objectContaining({ encryptionIv: expect.any(Buffer) }),
      );
    });
  });

  describe('putContent', () => {
    const noOptions = {
      contentType: undefined,
      contentLength: undefined,
      ifMatch: undefined,
      force: false,
      parents: false,
    };

    it('root 경로(/)는 VfsIsDirectoryError를 던진다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });

      await expect(
        service.putContent(NAMESPACE_ID, '/', Readable.from(Buffer.from('x')), noOptions),
      ).rejects.toThrow(VfsIsDirectoryError);
    });

    it('대상이 directory면 VfsIsDirectoryError를 던진다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.resolvePath.mockResolvedValue(
        makeNode({ type: 'DIRECTORY', blobId: null, size: null, mimeType: null }),
      );

      await expect(
        service.putContent(NAMESPACE_ID, '/a', Readable.from(Buffer.from('x')), noOptions),
      ).rejects.toThrow(VfsIsDirectoryError);
    });

    it('Content-Length가 상한을 넘으면 stream을 읽지 않고 VfsFileTooLargeError를 던진다', async () => {
      config.get.mockImplementation((key) => (key === 'STORIX_MAX_FILE_SIZE_BYTES' ? '10' : undefined));
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.resolvePath.mockResolvedValue(null);

      await expect(
        service.putContent(NAMESPACE_ID, '/a', Readable.from(Buffer.from('x')), {
          ...noOptions,
          contentLength: '11',
        }),
      ).rejects.toThrow(VfsFileTooLargeError);
      expect(blobStorage.put).not.toHaveBeenCalled();
    });

    it('Content-Type을 정규화해 blob mimeType으로 저장한다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.resolvePath.mockResolvedValue(null);
      repo.putFileContent.mockResolvedValue({ kind: 'created', node: makeNode() });

      await service.putContent(NAMESPACE_ID, '/a.txt', Readable.from(Buffer.from('hello')), {
        ...noOptions,
        contentType: 'TEXT/PLAIN; charset=utf-8',
      });

      expect(repo.putFileContent).toHaveBeenCalledWith(
        NAMESPACE_ID,
        'root',
        ['a.txt'],
        false,
        expect.objectContaining({ mimeType: 'text/plain', size: '5', encryptionIv: null }),
        null,
        false,
      );
    });

    it('If-Match 헤더를 정수 version으로 변환해 전달한다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.resolvePath.mockResolvedValue(makeNode({ type: 'FILE' }));
      repo.putFileContent.mockResolvedValue({ kind: 'replaced', node: makeNode() });

      await service.putContent(NAMESPACE_ID, '/a.txt', Readable.from(Buffer.from('hi')), {
        ...noOptions,
        ifMatch: '"3"',
      });

      expect(repo.putFileContent).toHaveBeenCalledWith(
        NAMESPACE_ID,
        'root',
        ['a.txt'],
        false,
        expect.anything(),
        3,
        false,
      );
    });

    it('If-Match 헤더가 빈 문자열이면 version 체크 없이 null로 전달한다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.resolvePath.mockResolvedValue(makeNode({ type: 'FILE' }));
      repo.putFileContent.mockResolvedValue({ kind: 'replaced', node: makeNode() });

      await service.putContent(NAMESPACE_ID, '/a.txt', Readable.from(Buffer.from('hi')), {
        ...noOptions,
        ifMatch: '""',
      });

      expect(repo.putFileContent).toHaveBeenCalledWith(
        NAMESPACE_ID,
        'root',
        ['a.txt'],
        false,
        expect.anything(),
        null,
        false,
      );
    });

    it('namespace 상한이 전역보다 작으면 namespace 상한을 적용해 거부한다', async () => {
      config.get.mockImplementation((key) => (key === 'STORIX_MAX_FILE_SIZE_BYTES' ? '1000' : undefined));
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({
        root: makeRoot(),
        limits: { ...NONE_LIMITS, maxFileSizeBytes: '10' },
      });
      repo.resolvePath.mockResolvedValue(null);

      await expect(
        service.putContent(NAMESPACE_ID, '/a', Readable.from(Buffer.from('x')), {
          ...noOptions,
          contentLength: '11',
        }),
      ).rejects.toThrow(VfsFileTooLargeError);
    });

    it('namespace 상한이 전역보다 크면 전역값을 상한으로 적용한다', async () => {
      config.get.mockImplementation((key) => (key === 'STORIX_MAX_FILE_SIZE_BYTES' ? '10' : undefined));
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({
        root: makeRoot(),
        limits: { ...NONE_LIMITS, maxFileSizeBytes: '1000' },
      });
      repo.resolvePath.mockResolvedValue(null);

      await expect(
        service.putContent(NAMESPACE_ID, '/a', Readable.from(Buffer.from('x')), {
          ...noOptions,
          contentLength: '11',
        }),
      ).rejects.toThrow(VfsFileTooLargeError);
    });

    it('namespace 상한이 없으면(null) 전역값을 그대로 적용한다', async () => {
      config.get.mockImplementation((key) => (key === 'STORIX_MAX_FILE_SIZE_BYTES' ? '10' : undefined));
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.resolvePath.mockResolvedValue(null);

      await expect(
        service.putContent(NAMESPACE_ID, '/a', Readable.from(Buffer.from('x')), {
          ...noOptions,
          contentLength: '11',
        }),
      ).rejects.toThrow(VfsFileTooLargeError);
    });

    it('ENCRYPTED namespace면 암호화해서 저장하고 repository에 IV를 전달한다', async () => {
      masterKey = randomBytes(32);
      service = createService();
      repo.getRootWithLimits.mockResolvedValue({
        root: makeRoot(),
        limits: { ...NONE_LIMITS, encryptionPolicy: 'ENCRYPTED' },
      });
      repo.resolvePath.mockResolvedValue(null);
      repo.putFileContent.mockResolvedValue({ kind: 'created', node: makeNode() });

      const writtenChunks: Buffer[] = [];
      blobStorage.put.mockImplementationOnce(async (...args: unknown[]) => {
        for await (const chunk of args[1] as Readable) {
          writtenChunks.push(chunk as Buffer);
        }
      });

      await service.putContent(NAMESPACE_ID, '/a.txt', Readable.from(Buffer.from('hello')), noOptions);

      expect(repo.putFileContent).toHaveBeenCalledWith(
        NAMESPACE_ID,
        'root',
        ['a.txt'],
        false,
        expect.objectContaining({ encryptionIv: expect.any(Buffer) }),
        null,
        false,
      );
      const written = Buffer.concat(writtenChunks);
      expect(written).not.toEqual(Buffer.from('hello'));
      expect(written.length).toBe(5);
    });
  });

  describe('getContent', () => {
    it('대상이 없으면 VfsNodeNotFoundError를 던진다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.resolvePath.mockResolvedValue(null);

      await expect(service.getContent(NAMESPACE_ID, '/missing', undefined)).rejects.toThrow(
        VfsNodeNotFoundError,
      );
    });

    it('대상이 directory면 VfsIsDirectoryError를 던진다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.resolvePath.mockResolvedValue(
        makeNode({ type: 'DIRECTORY', blobId: null, size: null, mimeType: null }),
      );

      await expect(service.getContent(NAMESPACE_ID, '/a', undefined)).rejects.toThrow(VfsIsDirectoryError);
    });

    it('range 없이 조회하면 200과 전체 size를 반환한다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.resolvePath.mockResolvedValue(makeNode({ size: '10', mimeType: 'text/plain', blobId: 'blob-1' }));
      repo.getBlobStorageInfo.mockResolvedValue({ storageKey: 'blobs/00/key', encryptionIv: null });
      blobStorage.get.mockResolvedValue(Readable.from(Buffer.from('0123456789')));

      const result = await service.getContent(NAMESPACE_ID, '/a.txt', undefined);

      expect(result).toMatchObject({ status: 200, contentLength: 10, mimeType: 'text/plain', name: 'a.txt' });
      expect(blobStorage.get).toHaveBeenCalledWith('blobs/00/key');
    });

    it('유효한 range는 206과 Content-Range 정보를 반환한다', async () => {
      repo.getRootWithLimits.mockResolvedValue({ root: makeRoot(), limits: NONE_LIMITS });
      repo.resolvePath.mockResolvedValue(makeNode({ size: '10', mimeType: 'text/plain', blobId: 'blob-1' }));
      repo.getBlobStorageInfo.mockResolvedValue({ storageKey: 'blobs/00/key', encryptionIv: null });
      blobStorage.get.mockResolvedValue(Readable.from(Buffer.from('234')));

      const result = await service.getContent(NAMESPACE_ID, '/a.txt', 'bytes=2-4');

      expect(result).toMatchObject({ status: 206, contentLength: 3, contentRange: 'bytes 2-4/10' });
      expect(blobStorage.get).toHaveBeenCalledWith('blobs/00/key', { start: 2, end: 4 });
    });

    it('ENCRYPTED namespace면 저장된 IV로 복호화한 스트림을 반환한다', async () => {
      masterKey = randomBytes(32);
      service = createService();
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-ctr', masterKey, iv);
      const ciphertext = Buffer.concat([cipher.update(Buffer.from('hello')), cipher.final()]);

      repo.getRootWithLimits.mockResolvedValue({
        root: makeRoot(),
        limits: { ...NONE_LIMITS, encryptionPolicy: 'ENCRYPTED' },
      });
      repo.resolvePath.mockResolvedValue(makeNode({ size: '5', mimeType: 'text/plain', blobId: 'blob-1' }));
      repo.getBlobStorageInfo.mockResolvedValue({ storageKey: 'blobs/00/key', encryptionIv: iv });
      blobStorage.get.mockResolvedValue(Readable.from(ciphertext));

      const result = await service.getContent(NAMESPACE_ID, '/a.txt', undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream) {
        chunks.push(chunk as Buffer);
      }

      expect(Buffer.concat(chunks).toString()).toBe('hello');
    });
  });
});
