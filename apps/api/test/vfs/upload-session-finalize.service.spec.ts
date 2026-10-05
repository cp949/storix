import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { jest } from '@jest/globals';
import type { BlobRepository } from '../../src/persistence/blob.repository.js';
import type { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import type { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import type { StorageKeyGenerator } from '../../src/storage/storage-key-generator.js';
import { PathResolver } from '../../src/vfs/path-resolver.js';
import { UploadSessionFinalizeService } from '../../src/vfs/upload-session-finalize.service.js';
import { ContentIngressService } from '../../src/vfs/content-ingress.service.js';
import { VfsChecksumMismatchError } from '../../src/vfs/vfs.errors.js';

describe('UploadSessionFinalizeService', () => {
  it('rejects missing parts before publishing a final object', async () => {
    const namespaceId = randomUUID();
    const sessionId = randomUUID();
    let puts = 0;
    const sessions = {
      claimFinalize: async () => ({ kind: 'incomplete' }),
    } as unknown as VfsUploadSessionRepository;
    const storage = {
      put: async () => {
        puts++;
      },
    } as unknown as BlobStorage;
    const service = new UploadSessionFinalizeService(
      new PathResolver(),
      { getRoot: async () => ({ id: 'root' }) } as unknown as VfsNodeRepository,
      sessions,
      { generate: () => 'blobs/test' } as StorageKeyGenerator,
      storage,
      null,
      new ContentIngressService(storage, null),
      { findKnownStorageKeys: async () => new Set<string>() } as unknown as BlobRepository,
    );
    await expect(service.complete(namespaceId, sessionId, 'request')).rejects.toMatchObject({
      code: 'VFS_UPLOAD_PARTS_INCOMPLETE',
      status: 409,
    });
    expect(puts).toBe(0);
  });

  it('streams stored parts in order and replays the committed response', async () => {
    const namespaceId = randomUUID();
    const sessionId = randomUUID();
    const token = randomUUID();
    const session = {
      id: sessionId,
      namespaceId,
      state: 'OPEN',
      partCount: 2,
      sizeBytes: '8',
      targetPath: '/file',
      mimeType: 'text/plain',
      conditionType: 'ABSENT',
      conditionRevision: null,
      responseStatus: null as number | null,
      responseBody: null as string | null,
      requestId: null as string | null,
    };
    const parts = [
      {
        partIndex: 0,
        sizeBytes: '4',
        stagingKey: 'part-a',
        state: 'STORED',
        digest: createHash('sha256').update('abcd').digest('hex'),
        encryptionIv: null,
      },
      {
        partIndex: 1,
        sizeBytes: '4',
        stagingKey: 'part-b',
        state: 'STORED',
        digest: createHash('sha256').update('efgh').digest('hex'),
        encryptionIv: null,
      },
    ];
    let final = '';
    const storage = {
      get: async (key: string) => Readable.from([key === 'part-a' ? 'abcd' : 'efgh']),
      put: async (_key: string, source: Readable) => {
        for await (const chunk of source) final += chunk.toString();
      },
      delete: async () => undefined,
    } as unknown as BlobStorage;
    const sessions = {
      findForStatus: async () => ({ session, parts }),
      claimFinalize: async () =>
        session.state === 'COMPLETED'
          ? { kind: 'complete', session }
          : ((session.state = 'FINALIZING'), { kind: 'claimed', token, session, parts }),
      fenceFinalize: async () => undefined,
      renewFinalize: async () => true,
      completeFinalize: async (
        _tx: unknown,
        _ns: string,
        _id: string,
        _token: string,
        status: number,
        body: string,
        requestId: string,
      ) => {
        session.state = 'COMPLETED';
        session.responseStatus = status;
        session.responseBody = body;
        session.requestId = requestId;
      },
      releaseFinalize: async () => true,
    } as unknown as VfsUploadSessionRepository;
    const nodes = {
      getRoot: async () => ({ id: 'root' }),
      getRootWithLimits: async () => ({ root: { id: 'root' }, limits: { encryptionPolicy: 'NONE' } }),
      withMutation: async (
        _ns: string,
        _root: string,
        work: (tx: unknown) => Promise<unknown>,
        after: (tx: unknown, result: unknown) => Promise<void>,
      ) => {
        const tx = {};
        const value = await work(tx);
        const result = { value, affectedRevisions: [{ path: '/file', revision: 'r1.test' }] };
        await after(tx, result);
        return result;
      },
      putConditionalContent: async () => ({ status: 201, resource: { path: '/file' } }),
    } as unknown as VfsNodeRepository;
    const service = new UploadSessionFinalizeService(
      new PathResolver(),
      nodes,
      sessions,
      { generate: () => 'blobs/test' } as StorageKeyGenerator,
      storage,
      null,
      new ContentIngressService(storage, null),
      { findKnownStorageKeys: async () => new Set<string>() } as unknown as BlobRepository,
    );
    const first = await service.complete(namespaceId, sessionId, 'first-request');
    expect(final).toBe('abcdefgh');
    expect(first).toMatchObject({ status: 201, headers: { 'x-request-id': 'first-request' } });
    expect((first.body as { affectedRevisions: unknown[] }).affectedRevisions).toHaveLength(1);
    const replay = await service.complete(namespaceId, sessionId, 'second-request');
    expect(replay).toEqual(first);
  });

  it.each([
    { renewal: 'success', publishes: true },
    { renewal: 'lost', publishes: false },
    { renewal: 'error', publishes: false },
  ])('keeps the claim while final put waits; renewal=$renewal', async ({ renewal, publishes }) => {
    jest.useFakeTimers();
    const namespaceId = randomUUID();
    const sessionId = randomUUID();
    let resume!: () => void;
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let renewals = 0;
    let mutations = 0;
    const sessions = {
      claimFinalize: async () => ({
        kind: 'claimed',
        token: randomUUID(),
        parts: [],
        session: {
          mimeType: 'application/octet-stream',
          sizeBytes: '0',
          targetPath: '/empty',
          conditionType: 'ABSENT',
        },
      }),
      renewFinalize: async () => {
        renewals++;
        if (renewal === 'error') throw new Error('renewal unavailable');
        return renewal === 'success';
      },
      fenceFinalize: async () => undefined,
      completeFinalize: async () => undefined,
      releaseFinalize: async () => true,
    } as unknown as VfsUploadSessionRepository;
    const storage = {
      put: async () => {
        entered();
        await released;
      },
      delete: async () => undefined,
    } as unknown as BlobStorage;
    const nodes = {
      getRoot: async () => ({ id: 'root' }),
      getRootWithLimits: async () => ({ root: { id: 'root' }, limits: { encryptionPolicy: 'NONE' } }),
      withMutation: async (
        _ns: string,
        _root: string,
        work: (tx: { manager: object }) => Promise<unknown>,
        after: (tx: { manager: object }, result: unknown) => Promise<void>,
      ) => {
        mutations++;
        const tx = { manager: {} };
        const value = await work(tx);
        const result = { value, affectedRevisions: [] };
        await after(tx, result);
        return result;
      },
      putConditionalContent: async () => ({ status: 201, resource: { path: '/empty' } }),
    } as unknown as VfsNodeRepository;
    const service = new UploadSessionFinalizeService(
      new PathResolver(),
      nodes,
      sessions,
      { generate: () => 'blobs/test' } as StorageKeyGenerator,
      storage,
      null,
      new ContentIngressService(storage, null),
      { findKnownStorageKeys: async () => new Set<string>() } as unknown as BlobRepository,
    );
    try {
      const pending = service.complete(namespaceId, sessionId, 'request');
      await started;
      await jest.advanceTimersByTimeAsync((publishes ? 61 : 21) * 60 * 1000);
      expect(renewals).toBeGreaterThanOrEqual(publishes ? 3 : 1);
      resume();
      if (publishes) expect((await pending).status).toBe(201);
      else await expect(pending).rejects.toThrow('claim lost');
      expect(mutations).toBe(publishes ? 1 : 0);
    } finally {
      resume();
      jest.useRealTimers();
    }
  });

  describe('complete 실패 시 최종 object 정리', () => {
    const finalKey = 'blobs/final';

    // withMutation이 mutationError를 던지는 서비스를 만든다. lookup은 Blob 참조 조회 결과다.
    function setup(mutationError: unknown, lookup: () => Promise<Set<string>>) {
      const deleted: string[] = [];
      const storage = {
        // 본문을 끝까지 소비한다.
        put: async (_key: string, source: Readable) => finished(source.resume()),
        delete: async (key: string) => {
          deleted.push(key);
        },
      } as unknown as BlobStorage;
      const sessions = {
        claimFinalize: async () => ({
          kind: 'claimed',
          token: randomUUID(),
          parts: [],
          session: {
            mimeType: 'application/octet-stream',
            sizeBytes: '0',
            targetPath: '/empty',
            conditionType: 'ABSENT',
          },
        }),
        renewFinalize: async () => true,
        releaseFinalize: async () => true,
      } as unknown as VfsUploadSessionRepository;
      const nodes = {
        getRoot: async () => ({ id: 'root' }),
        getRootWithLimits: async () => ({ root: { id: 'root' }, limits: { encryptionPolicy: 'NONE' } }),
        withMutation: async () => {
          throw mutationError;
        },
      } as unknown as VfsNodeRepository;
      const blobs = { findKnownStorageKeys: lookup } as unknown as BlobRepository;
      const service = new UploadSessionFinalizeService(
        new PathResolver(),
        nodes,
        sessions,
        { generate: () => finalKey } as StorageKeyGenerator,
        storage,
        null,
        new ContentIngressService(storage, null),
        blobs,
      );
      return { service, deleted };
    }

    it('commit 결과가 불명확한 5xx 오류면 참조가 보이지 않아도 최종 object를 보존한다', async () => {
      const error = new Error('Connection terminated unexpectedly');
      const { service, deleted } = setup(error, async () => new Set());
      await expect(service.complete(randomUUID(), randomUUID(), 'request')).rejects.toBe(error);
      expect(deleted).not.toContain(finalKey);
    });

    it('롤백이 확정된 4xx 도메인 오류이고 참조가 없으면 최종 object를 삭제한다', async () => {
      const error = new VfsChecksumMismatchError();
      const { service, deleted } = setup(error, async () => new Set());
      await expect(service.complete(randomUUID(), randomUUID(), 'request')).rejects.toBe(error);
      expect(deleted).toContain(finalKey);
    });

    it('참조 조회가 실패하면 4xx 도메인 오류여도 최종 object를 보존한다', async () => {
      const error = new VfsChecksumMismatchError();
      const { service, deleted } = setup(error, async () => {
        throw new Error('lookup unavailable');
      });
      await expect(service.complete(randomUUID(), randomUUID(), 'request')).rejects.toBe(error);
      expect(deleted).not.toContain(finalKey);
    });
  });
});
