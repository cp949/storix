import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { VfsNodeRepository } from '../persistence/vfs-node.repository.js';
import { VfsMutationReceiptRepository } from '../persistence/vfs-mutation-receipt.repository.js';
import { StorageKeyGenerator } from '../storage/storage-key-generator.js';
import type { BlobStorage } from '../storage/blob-storage.js';
import { ConditionalContentService } from './conditional-content.service.js';
import { PathResolver } from './path-resolver.js';
import { VfsInvalidPathError } from './vfs.errors.js';

describe('ConditionalContentService path parsing', () => {
  const namespaceId = randomUUID();
  const rootId = randomUUID();
  const withMutation = jest.fn<VfsNodeRepository['withMutation']>();
  const nodes = {
    getRootWithLimits: async () => ({
      root: { id: rootId },
      limits: { maxFileSizeBytes: null, encryptionPolicy: 'PLAINTEXT' },
    }),
    withMutation,
  } as unknown as VfsNodeRepository;
  const receipts = {
    claim: async () => ({ kind: 'owner', generation: 1 }),
    complete: async () => undefined,
    release: async () => undefined,
  } as unknown as VfsMutationReceiptRepository;
  const service = new ConditionalContentService(
    new PathResolver(),
    nodes,
    receipts,
    {
      generate: () => {
        throw new Error('unexpected upload');
      },
    } as StorageKeyGenerator,
    {} as BlobStorage,
    null,
    { get: () => undefined } as unknown as ConfigService,
  );

  beforeEach(() => withMutation.mockClear());

  it('NFD raw path를 업로드 전에 400 응답으로 확정한다', async () => {
    withMutation.mockImplementation(async (_ns, _root, work, afterBump) => {
      const tx = {} as Parameters<NonNullable<typeof afterBump>>[0];
      const value = await work(tx);
      if (afterBump) await afterBump(tx, { value, affectedRevisions: [] });
      return { value, affectedRevisions: [] };
    });
    const result = await service.put(
      namespaceId,
      'scope',
      randomUUID(),
      '/e\u0301',
      'true',
      undefined,
      Readable.from([Buffer.from('body')]),
      'application/octet-stream',
      undefined,
      'req-1',
    );
    expect(result).toMatchObject({ status: 400, body: { code: 'VFS_INVALID_PATH', requestId: 'req-1' } });
  });

  it('NFD path의 body를 소진하고 claim을 해제하며 완료 receipt와 업로드를 남기지 않는다', async () => {
    const complete = jest.fn(async () => undefined);
    const release = jest.fn(async () => undefined);
    const put = jest.fn<BlobStorage['put']>();
    const deleteObject = jest.fn<BlobStorage['delete']>();
    const localService = new ConditionalContentService(
      new PathResolver(),
      nodes,
      {
        claim: async () => ({ kind: 'owner', generation: 1 }),
        complete,
        release,
      } as unknown as VfsMutationReceiptRepository,
      { generate: () => 'object-key' } as StorageKeyGenerator,
      { put, delete: deleteObject } as unknown as BlobStorage,
      null,
      { get: () => undefined } as unknown as ConfigService,
    );
    const source = Readable.from([Buffer.from('body')]);
    const result = await localService.put(
      namespaceId,
      'scope',
      randomUUID(),
      '/e\u0301',
      'true',
      undefined,
      source,
      'application/octet-stream',
      undefined,
      'req-2',
    );
    expect(result).toMatchObject({ status: 400, body: { code: 'VFS_INVALID_PATH' } });
    expect(source.readableEnded).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(withMutation).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('업로드 뒤 path 거부 시 object 삭제를 시도하고 claim을 해제한다', async () => {
    const release = jest.fn(async () => undefined);
    const complete = jest.fn(async () => undefined);
    const deleteObject = jest
      .fn<BlobStorage['delete']>()
      .mockRejectedValue(new Error('object cleanup failed'));
    const put = jest.fn<BlobStorage['put']>().mockImplementation(async (_key, stream) => {
      for await (const chunk of stream) {
        void chunk;
      }
    });
    const localNodes = {
      getRootWithLimits: nodes.getRootWithLimits,
      withMutation: async (_ns: string, _root: string, work: (tx: unknown) => Promise<unknown>) => work({}),
      putConditionalContent: async () => {
        throw new VfsInvalidPathError('/rejected');
      },
    } as unknown as VfsNodeRepository;
    const localService = new ConditionalContentService(
      new PathResolver(),
      localNodes,
      {
        claim: async () => ({ kind: 'owner', generation: 1 }),
        renew: async () => true,
        complete,
        release,
      } as unknown as VfsMutationReceiptRepository,
      { generate: () => 'object-key' } as StorageKeyGenerator,
      { put, delete: deleteObject } as unknown as BlobStorage,
      null,
      { get: () => undefined } as unknown as ConfigService,
    );
    await expect(
      localService.put(
        namespaceId,
        'scope',
        randomUUID(),
        '/valid',
        'true',
        undefined,
        Readable.from([Buffer.from('body')]),
        'application/octet-stream',
        undefined,
        'req-3',
      ),
    ).rejects.toBeInstanceOf(VfsInvalidPathError);
    expect(put).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith('object-key');
    expect(release).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });
});
