import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { GcJob } from '../../src/jobs/gc.job.js';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from '../../src/persistence/entities/vfs-trash-entry.entity.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsTrashRetentionRepository } from '../../src/persistence/vfs-trash-retention.repository.js';
import { MinioBlobStorage } from '../../src/storage/minio-blob-storage.js';

export interface GcJobTestContext {
  readonly dataSource: DataSource;
  readonly storage: MinioBlobStorage;
  readonly blobRepository: BlobRepository;
  readonly namespaceId: string;
  readonly nodeRepository: VfsNodeRepository;
  readonly trashRetention: VfsTrashRetentionRepository;
  setZeroSinceSecondsAgo(blobId: string, secondsAgo: number): Promise<void>;
}

// Postgres/SQLite 공용 테스트 본문. 드라이버별 실행 파일(*.integration-spec.ts,
// *.sqlite.integration-spec.ts)이 이 함수를 호출해 같은 테스트를 두 드라이버에
// 대해 반복한다 — 테스트 로직 중복 없이 드라이버별 실행만 분리한다.
export function runGcJobSharedTests(getContext: () => GcJobTestContext): void {
  function makeConfig(gracePeriodSeconds: number): ConfigService {
    return { get: () => String(gracePeriodSeconds) } as unknown as ConfigService;
  }

  async function createBlob(referenceCount: number): Promise<BlobEntity> {
    const { dataSource, storage, namespaceId } = getContext();
    const blobRepo = dataSource.getRepository(BlobEntity);
    const storageKey = `blobs/ab/${randomUUID()}`;
    const blob = await blobRepo.save(
      blobRepo.create({
        namespaceId,
        storageKey,
        size: '1',
        mimeType: 'application/octet-stream',
        sha256: 'f'.repeat(64),
        referenceCount,
      }),
    );
    await storage.put(storageKey, Readable.from(Buffer.from('content')));
    return blob;
  }

  async function createTrashFixture(expiredCount: number, futureCount: number) {
    const { dataSource, storage } = getContext();
    const namespace = await dataSource.getRepository(NamespaceEntity).save({ name: `gc-trash-${randomUUID()}` });
    const root = await dataSource.getRepository(VfsNodeEntity).save({
      namespaceId: namespace.id, parentId: null, name: '', type: 'DIRECTORY',
      blobId: null, size: null, mimeType: null,
    });
    const storageKey = `blobs/ab/${randomUUID()}`;
    const blob = await dataSource.getRepository(BlobEntity).save({
      namespaceId: namespace.id, storageKey, size: '7', mimeType: 'text/plain',
      sha256: 'f'.repeat(64), referenceCount: expiredCount + futureCount + 1,
    });
    await storage.put(storageKey, Readable.from(Buffer.from('content')));
    await dataSource.getRepository(VfsNodeEntity).save({
      namespaceId: namespace.id, parentId: root.id, name: 'live', type: 'FILE',
      blobId: blob.id, size: '7', mimeType: 'text/plain',
    });
    const ids: string[] = [];
    for (let index = 0; index < expiredCount + futureCount; index++) {
      const sourceNodeId = randomUUID();
      const trash = await dataSource.getRepository(VfsTrashEntity).save({
        namespaceId: namespace.id, rootType: 'FILE', originalPath: `/old-${index}`,
        rootNodeId: sourceNodeId, rootRevision: 'old-revision', nodeCount: '1', logicalBytes: '7',
        deletedAt: new Date(Date.now() - 31 * 86400000),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await dataSource.getRepository(VfsTrashEntryEntity).save({
        namespaceId: namespace.id, trashId: trash.id, relativePath: '.', pathKey: '.',
        type: 'FILE', sourceNodeId, sourceRevision: 'old-revision',
        blobId: blob.id, size: '7', mimeType: 'text/plain',
      });
      if (index < expiredCount) {
        await dataSource.getRepository(VfsTrashEntity).createQueryBuilder().update()
          .set({ expiresAt: () => 'CURRENT_TIMESTAMP' }).where('id = :id', { id: trash.id }).execute();
      }
      ids.push(trash.id);
    }
    await dataSource.getRepository(NamespaceEntity).update({ id: namespace.id }, {
      liveFileByteCount: '7', retainedTrashNodeCount: String(ids.length),
      retainedTrashByteCount: String(7 * ids.length),
    });
    return { namespaceId: namespace.id, blob, ids, storageKey };
  }

  it('만료 경계의 항목을 한 배치씩 purge하고 미만료 항목·공유 Blob·quota를 보존한다', async () => {
    const { dataSource, storage, trashRetention } = getContext();
    const fixture = await createTrashFixture(2, 1);
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const before = await namespaceRepo.findOneByOrFail({ id: fixture.namespaceId });
    expect([String(before.retainedTrashNodeCount), String(before.retainedTrashByteCount)])
      .toEqual(['3', '21']);

    expect(await trashRetention.pruneExpiredBatch(1)).toEqual({ items: 1, nodes: 1, bytes: '7' });
    const midway = await namespaceRepo.findOneByOrFail({ id: fixture.namespaceId });
    expect([String(midway.retainedTrashNodeCount), String(midway.retainedTrashByteCount)])
      .toEqual(['2', '14']);
    expect(await trashRetention.pruneExpiredBatch(1)).toEqual({ items: 1, nodes: 1, bytes: '7' });
    expect(await trashRetention.pruneExpiredBatch(1)).toEqual({ items: 0, nodes: 0, bytes: '0' });
    expect(await dataSource.getRepository(VfsTrashEntity).findBy({ namespaceId: fixture.namespaceId }))
      .toHaveLength(1);
    const after = await namespaceRepo.findOneByOrFail({ id: fixture.namespaceId });
    expect([String(after.retainedTrashNodeCount), String(after.retainedTrashByteCount), String(after.liveFileByteCount)])
      .toEqual(['1', '7', '7']);
    expect((await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: fixture.blob.id })).referenceCount)
      .toBe(2);
    await expect(storage.get(fixture.storageKey)).resolves.toBeDefined();
  });

  it('GC 결과는 완료된 만료 purge의 item 수와 논리 byte만 집계한다', async () => {
    const { dataSource, storage, blobRepository, trashRetention } = getContext();
    const fixture = await createTrashFixture(1, 1);
    const job = new GcJob(storage, blobRepository, makeConfig(3600), undefined, undefined, undefined, trashRetention);
    const result = await job.run();
    expect([result.prunedTrashItems, result.prunedTrashBytes]).toEqual([1, '7']);
    expect(await dataSource.getRepository(VfsTrashEntity).countBy({ namespaceId: fixture.namespaceId })).toBe(1);
    const repeated = await job.run();
    expect([repeated.prunedTrashItems, repeated.prunedTrashBytes]).toEqual([0, '0']);
  });

  it('grace period가 지난 reference_count=0 blob의 object와 row를 모두 삭제한다', async () => {
    const { dataSource, storage, blobRepository, setZeroSinceSecondsAgo } = getContext();
    const expired = await createBlob(0);
    await setZeroSinceSecondsAgo(expired.id, 7200);
    const job = new GcJob(storage, blobRepository, makeConfig(3600));

    const result = await job.run();

    expect(result.deletedOrphanBlobs).toBeGreaterThanOrEqual(1);
    await expect(dataSource.getRepository(BlobEntity).findOneBy({ id: expired.id })).resolves.toBeNull();
    await expect(storage.get(expired.storageKey)).rejects.toThrow();
  });

  it('grace period 이내의 reference_count=0 blob은 건드리지 않는다', async () => {
    const { dataSource, storage, blobRepository, setZeroSinceSecondsAgo } = getContext();
    const recent = await createBlob(0);
    await setZeroSinceSecondsAgo(recent.id, 0);
    const job = new GcJob(storage, blobRepository, makeConfig(3600));

    await job.run();

    await expect(dataSource.getRepository(BlobEntity).findOneBy({ id: recent.id })).resolves.not.toBeNull();
    await expect(storage.get(recent.storageKey)).resolves.toBeDefined();

    // 이후 테스트(특히 짧은 grace period를 쓰는 orphan object 테스트)가 실행될
    // 때쯤이면 이 blob의 zero_since도 그 grace period보다 오래된 것으로 보여
    // 함께 회수될 수 있다. 테스트 간 순서 의존을 없애기 위해 검증이 끝난 직후
    // 직접 정리한다.
    await dataSource.getRepository(BlobEntity).delete({ id: recent.id });
    await storage.delete(recent.storageKey);
  });

  it('참조가 남아있는 blob은 GC 대상이 아니다', async () => {
    const { dataSource, storage, blobRepository } = getContext();
    const referenced = await createBlob(1);
    const job = new GcJob(storage, blobRepository, makeConfig(3600));

    await job.run();

    await expect(dataSource.getRepository(BlobEntity).findOneBy({ id: referenced.id })).resolves.not.toBeNull();
    await expect(storage.get(referenced.storageKey)).resolves.toBeDefined();
  });

  it('metadata 없이 grace period가 지난 orphan MinIO object를 회수한다', async () => {
    const { storage, blobRepository } = getContext();
    const orphanKey = `blobs/ab/${randomUUID()}`;
    await storage.put(orphanKey, Readable.from(Buffer.from('orphan')));
    // STORIX_ORPHAN_GRACE_PERIOD는 parsePositiveInt로 파싱되어 0을 허용하지 않으므로
    // 최소값 1초를 쓰고, object가 확실히 grace period보다 오래되도록 잠깐 대기한다.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const job = new GcJob(storage, blobRepository, makeConfig(1));

    const result = await job.run();

    expect(result.deletedOrphanObjects).toBeGreaterThanOrEqual(1);
    await expect(storage.get(orphanKey)).rejects.toThrow();
  });

  it('metadata 없어도 grace period 이내면 orphan MinIO object를 보존한다', async () => {
    const { storage, blobRepository } = getContext();
    const freshOrphanKey = `blobs/ab/${randomUUID()}`;
    await storage.put(freshOrphanKey, Readable.from(Buffer.from('fresh orphan')));
    const job = new GcJob(storage, blobRepository, makeConfig(3600));

    await job.run();

    await expect(storage.get(freshOrphanKey)).resolves.toBeDefined();
  });
}
