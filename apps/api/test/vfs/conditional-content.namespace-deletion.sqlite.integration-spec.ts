/**
 * 실제 SQLite와 가짜 storage에서 namespace 삭제 중 conditional content의 claim 소실을 검증한다.
 * 규칙은 docs/design/13-namespace-deletion.md "접근과 이름 재사용", "영속 상태와 잠금". 결정은 api ADR-0032.
 */
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DataSource } from 'typeorm';
import { NamespaceDeletionCleanup } from '../../src/jobs/namespace-deletion.cleanup.js';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceDeletionEntity } from '../../src/persistence/entities/namespace-deletion.entity.js';
import { NamespaceDeletionReceiptEntity } from '../../src/persistence/entities/namespace-deletion-receipt.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsChangeFeedStateEntity } from '../../src/persistence/entities/vfs-change-feed-state.entity.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsUploadPartEntity } from '../../src/persistence/entities/vfs-upload-part.entity.js';
import { VfsUploadSessionEntity } from '../../src/persistence/entities/vfs-upload-session.entity.js';
import { VfsUploadUsageEntity } from '../../src/persistence/entities/vfs-upload-usage.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { NamespaceDeletionCleanupRepository } from '../../src/persistence/namespace-deletion-cleanup.repository.js';
import { NamespaceDeletionRepository } from '../../src/persistence/namespace-deletion.repository.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { installSqliteGate } from '../../src/persistence/sqlite-gate.js';
import { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { StorageKeyGenerator } from '../../src/storage/storage-key-generator.js';
import { ConditionalContentService } from '../../src/vfs/conditional-content.service.js';
import { ContentIngressService } from '../../src/vfs/content-ingress.service.js';
import { storeErrorReceipt } from '../../src/vfs/mutation-receipt.js';
import { PathResolver } from '../../src/vfs/path-resolver.js';
import { VfsNodeNotFoundError } from '../../src/vfs/vfs.errors.js';

/** 테스트에서 외부 I/O의 진입과 재개 시점을 직접 제어한다. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// DB의 receipt 상태와 storage gate를 직접 확인해 타이머·sleep 없이 삭제 순서를 고정한다.
describe('conditional content 삭제 중 claim 소실 (SQLite)', () => {
  let db: DataSource;
  let receipts: VfsMutationReceiptRepository;
  let nodes: VfsNodeRepository;
  let uploads: VfsUploadSessionRepository;
  let blobs: BlobRepository;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('SQLite driver required');
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        NamespaceEntity,
        NamespaceDeletionEntity,
        NamespaceDeletionReceiptEntity,
        VfsNodeEntity,
        BlobEntity,
        VfsMutationReceiptEntity,
        VfsUploadUsageEntity,
        VfsUploadSessionEntity,
        VfsUploadPartEntity,
        VfsChangeFeedStateEntity,
      ],
      migrations: ALL_MIGRATIONS,
      migrationsTransactionMode: 'each',
    }).initialize();
    await db.runMigrations();
    installSqliteGate(db);
    receipts = new VfsMutationReceiptRepository(db);
    blobs = new BlobRepository(db);
    uploads = new VfsUploadSessionRepository(db);
    nodes = new VfsNodeRepository(
      db.getRepository(NamespaceEntity),
      db.getRepository(VfsNodeEntity),
      db.getRepository(BlobEntity),
      db,
      blobs,
      new ConfigService(),
    );
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });

  it.each(['DELETING', 'DELETED'] as const)(
    '%s tombstone에서 raw claim 소실과 오류 receipt fencing을 모두 404로 변환한다',
    async (status) => {
      const ns = await new NamespaceProvisioningRepository(db).createWithRoot(`receipt-${randomUUID()}`);
      const identity = { namespaceId: ns.id, scope: 'scope', key: randomUUID() };
      expect(await receipts.claim(identity, new Date())).toEqual({ kind: 'owner', generation: 1 });
      await db.getRepository(NamespaceEntity).update(ns.id, { status });
      await db.getRepository(VfsMutationReceiptEntity).delete({ namespaceId: ns.id });
      const owner = { identity, generation: 1, fingerprint: 'f'.repeat(64), method: 'POST' };

      for (const error of [new Error('VFS mutation claim lost'), new VfsNodeNotFoundError('/missing')]) {
        await expect(storeErrorReceipt(receipts, owner, error, 'req-1')).rejects.toMatchObject({
          code: 'NAMESPACE_NOT_FOUND',
          status: 404,
        });
      }
      expect(await db.getRepository(NamespaceEntity).findOneByOrFail({ id: ns.id })).toMatchObject({
        status,
      });
      expect(await db.getRepository(VfsMutationReceiptEntity).countBy({ namespaceId: ns.id })).toBe(0);
    },
  );

  it('업로드가 정지한 동안 삭제 GC가 receipt를 제거하면 재개 뒤 404이고 live 반영은 없다', async () => {
    const ns = await new NamespaceProvisioningRepository(db).createWithRoot(`ingress-${randomUUID()}`);
    const key = randomUUID();
    const entered = deferred();
    const resume = deferred();
    const deleteObject = jest.fn<BlobStorage['delete']>().mockResolvedValue(undefined);
    const put = jest.fn<BlobStorage['put']>().mockImplementation(async (_key, stream) => {
      for await (const chunk of stream) void chunk;
      entered.resolve();
      await resume.promise;
    });
    const storage = { put, delete: deleteObject } as unknown as BlobStorage;
    const service = new ConditionalContentService(
      new PathResolver(),
      nodes,
      receipts,
      { generate: () => 'blocked-object' } as StorageKeyGenerator,
      storage,
      new ContentIngressService(storage, null),
      new ConfigService(),
    );
    const pending = service.put(
      ns.id,
      'scope',
      key,
      '/blocked',
      'true',
      undefined,
      Readable.from([Buffer.from('body')]),
      'application/octet-stream',
      '4',
      'req-blocked',
    );
    const outcome = pending.then(
      (response) => ({ response, error: undefined }),
      (error: unknown) => ({ response: undefined, error }),
    );
    try {
      await entered.promise;
      expect(
        await db
          .getRepository(VfsMutationReceiptEntity)
          .findOneByOrFail({ namespaceId: ns.id, idempotencyKey: key }),
      ).toMatchObject({ state: 'RESERVED', generation: 1 });
      expect(
        await new NamespaceDeletionRepository(db, uploads).accept(ns.id, randomUUID(), new Date()),
      ).toMatchObject({
        status: 202,
      });
      const cleanup = new NamespaceDeletionCleanup(
        new NamespaceDeletionCleanupRepository(db, nodes, blobs, uploads),
        uploads,
      );
      expect(await cleanup.advance(new Date())).toEqual({ advanced: 1, completed: 0, failed: 0 });
      expect(
        await db.getRepository(NamespaceDeletionEntity).findOneByOrFail({ namespaceId: ns.id }),
      ).toMatchObject({
        phase: 'OBJECTS',
      });
      expect(await db.getRepository(VfsMutationReceiptEntity).countBy({ namespaceId: ns.id })).toBe(0);
      resume.resolve();
      expect(await outcome).toMatchObject({
        response: undefined,
        error: { code: 'NAMESPACE_NOT_FOUND', status: 404 },
      });
      expect(await db.getRepository(VfsNodeEntity).countBy({ namespaceId: ns.id, type: 'FILE' })).toBe(0);
      expect(await db.getRepository(BlobEntity).countBy({ namespaceId: ns.id })).toBe(0);
      expect(await db.getRepository(NamespaceEntity).findOneByOrFail({ id: ns.id })).toMatchObject({
        status: 'DELETING',
        liveFileByteCount: 0,
      });
      expect(deleteObject).toHaveBeenCalledWith('blocked-object');
    } finally {
      resume.resolve();
      await outcome;
    }
  });
});
