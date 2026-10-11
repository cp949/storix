// archive service의 receipt 순서와 ZIP FILE 생성 흐름을 단위 테스트한다.
import { jest } from '@jest/globals';
import { ArchiveService } from '../../src/vfs/archive.service.js';
import type { CapabilityService } from '../../src/capability/capability.service.js';
import type { ArchiveSourceRepository } from '../../src/persistence/archive-source.repository.js';
import type { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import type { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { hashParts } from '../../src/vfs/mutation.service.js';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ArchiveGate } from '../../src/vfs/archive-gate.js';

describe('ArchiveService', () => {
  it('capability 비활성 신규 요청은 receipt claim을 해제한다', async () => {
    const identity = {
      namespaceId: '11111111-1111-4111-8111-111111111111',
      scope: 'scope',
      key: '00000000-0000-4000-8000-000000000001',
    };
    const receipts = {
      claim: async () => ({ kind: 'owner' as const, generation: 1 }),
      release: jest.fn(async () => undefined),
    } as unknown as VfsMutationReceiptRepository;
    const nodes = {
      getRootWithLimits: jest.fn(async () => ({
        root: { id: 'root' },
        limits: { maxFileSizeBytes: null, encryptionPolicy: 'PLAIN' },
      })),
    } as unknown as VfsNodeRepository;
    const capabilities = {
      requireEnabled: jest.fn(() => {
        throw Object.assign(new Error('disabled'), { code: 'VFS_FEATURE_DISABLED' });
      }),
    } as unknown as CapabilityService;
    const service = new ArchiveService(
      nodes,
      receipts,
      {} as ArchiveSourceRepository,
      capabilities,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      {
        maxConcurrency: 1,
        maxEntries: 10,
        maxSourceBytes: 100n,
        maxResultBytes: 1000n,
        maxSeconds: 60,
        orphanGraceSeconds: 86400,
        assumedOrphanGrace: false,
        retryAfterSeconds: 10,
        compressionLevel: 1,
      },
      null,
      {} as never,
    );
    await expect(
      service.execute(
        identity.namespaceId,
        'scope',
        identity.key,
        Buffer.from(
          JSON.stringify({
            target: '/result.zip',
            entries: [{ id: '00000000-0000-4000-8000-000000000002', name: 'file.txt' }],
          }),
        ),
        undefined,
        'request',
      ),
    ).rejects.toMatchObject({ code: 'VFS_FEATURE_DISABLED' });
    expect(receipts.release).toHaveBeenCalledWith(identity, 1);
  });

  it('완료 receipt는 capability 상태와 원본을 다시 확인하지 않고 재생한다', async () => {
    const namespaceId = '11111111-1111-4111-8111-111111111111';
    const key = '00000000-0000-4000-8000-000000000001';
    const body = Buffer.from(
      JSON.stringify({
        target: '/result.zip',
        entries: [{ id: '00000000-0000-4000-8000-000000000002', name: 'file.txt' }],
      }),
    );
    const fingerprint = hashParts([
      'POST',
      'fs/archive',
      JSON.stringify({
        target: ['result.zip'],
        entries: [{ id: '00000000-0000-4000-8000-000000000002', name: 'file.txt' }],
      }),
      createHash('sha256').update(body).digest('hex'),
      '',
    ]);
    const receipts = {
      claim: async () => ({
        kind: 'complete' as const,
        receipt: {
          method: 'POST',
          fingerprint,
          responseStatus: 201,
          responseBody: JSON.stringify({ resource: { id: 'saved' } }),
          responseHeaders: JSON.stringify({ 'x-request-id': 'original' }),
        },
      }),
    } as unknown as VfsMutationReceiptRepository;
    const nodes = {
      getRootWithLimits: async () => ({
        root: { id: 'root' },
        limits: { maxFileSizeBytes: null, encryptionPolicy: 'PLAIN' },
      }),
    } as unknown as VfsNodeRepository;
    const capabilities = {
      requireEnabled: jest.fn(() => {
        throw new Error('재생 요청에서는 capability를 검사하면 안 된다');
      }),
    } as unknown as CapabilityService;
    const sources = { capture: jest.fn() } as unknown as ArchiveSourceRepository;
    const gate = { tryAcquire: jest.fn(() => null) } as unknown as ArchiveGate;
    const service = new ArchiveService(
      nodes,
      receipts,
      sources,
      capabilities,
      gate,
      {} as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      {
        maxConcurrency: 1,
        maxEntries: 10,
        maxSourceBytes: 100n,
        maxResultBytes: 1000n,
        maxSeconds: 60,
        orphanGraceSeconds: 86400,
        assumedOrphanGrace: false,
        retryAfterSeconds: 10,
        compressionLevel: 1,
      },
      null,
      {} as never,
    );
    await expect(service.execute(namespaceId, 'scope', key, body, undefined, 'retry')).resolves.toMatchObject(
      { status: 201, body: { resource: { id: 'saved' } } },
    );
    expect(capabilities.requireEnabled).not.toHaveBeenCalled();
    expect(gate.tryAcquire).not.toHaveBeenCalled();
    expect(sources.capture).not.toHaveBeenCalled();
  });

  it('원본 검증 후 ZIP FILE을 만들고 같은 transaction에서 receipt를 완료한다', async () => {
    const namespaceId = '11111111-1111-4111-8111-111111111111';
    const key = '00000000-0000-4000-8000-000000000001';
    const body = Buffer.from(
      JSON.stringify({
        target: '/result.zip',
        entries: [{ id: '00000000-0000-4000-8000-000000000002', name: 'file.txt' }],
      }),
    );
    let uploaded = Buffer.alloc(0);
    const receipts = {
      claim: async () => ({ kind: 'owner' as const, generation: 1 }),
      renew: async () => true,
      complete: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
    } as unknown as VfsMutationReceiptRepository;
    const entry = {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'file.txt',
      revision: 'revision',
      blobId: 'blob',
      storageKey: 'source',
      plaintextBytes: 4n,
      sha256: createHash('sha256').update('data').digest('hex'),
      encryptionIv: null,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const sources = {
      capture: async () => ({
        namespaceId,
        rootId: 'root',
        deadlineAt: new Date(Date.now() + 60_000),
        sourceBytes: 4n,
        entries: [entry],
      }),
      assertDeadline: async () => undefined,
    } as unknown as ArchiveSourceRepository;
    const applied = { status: 201, resource: { id: 'result' } };
    const nodes = {
      getRootWithLimits: async () => ({
        root: { id: 'root' },
        limits: { maxFileSizeBytes: null, encryptionPolicy: 'PLAIN' },
      }),
      withMutation: async (
        _ns: string,
        _root: string,
        work: (tx: object) => Promise<unknown>,
        afterBump: (tx: object, result: object) => Promise<void>,
      ) => {
        const value = await work({});
        await afterBump({}, { value, affectedRevisions: [] });
        return { value: applied, affectedRevisions: [] };
      },
      putConditionalContent: async () => applied,
    } as unknown as VfsNodeRepository;
    const service = new ArchiveService(
      nodes,
      receipts,
      sources,
      { requireEnabled: () => undefined } as unknown as CapabilityService,
      new ArchiveGate(1),
      { generate: () => 'result-key' } as never,
      { get: async () => Readable.from([Buffer.from('data')]) } as never,
      {
        upload: async (_key: string, stream: Readable) => {
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
          uploaded = Buffer.concat(chunks);
          return {
            size: uploaded.length,
            sha256: createHash('sha256').update(uploaded).digest('hex'),
            encryptionIv: null,
          };
        },
      } as never,
      { get: () => undefined } as never,
      {
        maxConcurrency: 1,
        maxEntries: 10,
        maxSourceBytes: 100n,
        maxResultBytes: 1000n,
        maxSeconds: 60,
        orphanGraceSeconds: 86400,
        assumedOrphanGrace: false,
        retryAfterSeconds: 10,
        compressionLevel: 1,
      },
      null,
      {} as never,
    );
    await expect(
      service.execute(namespaceId, 'scope', key, body, undefined, 'request'),
    ).resolves.toMatchObject({ status: 201, body: { entryCount: 1 } });
    expect(uploaded.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(receipts.complete).toHaveBeenCalledTimes(1);
  });
});
