import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import { DataSource, IsNull } from 'typeorm';
import { GcJob } from '../../src/jobs/gc.job.js';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { GcCursorRepository } from '../../src/persistence/gc-cursor.repository.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from '../../src/persistence/entities/vfs-trash-entry.entity.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import {
  type ExpiredFileBatch,
  type FileExpiryCursor,
  VfsFileExpiryRepository,
} from '../../src/persistence/vfs-file-expiry.repository.js';
import { VfsTrashRetentionRepository } from '../../src/persistence/vfs-trash-retention.repository.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { readDbNow } from '../../src/persistence/vfs-node.repository.helpers.js';
import { encodeRevision } from '../../src/vfs/revision.js';
import { VfsNodeNotFoundError } from '../../src/vfs/vfs.errors.js';
import { CreateMultipartUploadCommand, type S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import { S3BlobStorage } from '../../src/storage/s3-blob-storage.js';
import { StoragePutOwnershipRepository } from '../../src/persistence/storage-put-ownership.repository.js';
import { PutProtectedBlobStorage } from '../../src/storage/put-protected-blob-storage.js';

export interface GcJobTestContext {
  readonly dataSource: DataSource;
  readonly storage: S3BlobStorage;
  /** 미완료 multipart upload처럼 어댑터가 만들지 않는 상태를 직접 만드는 데 쓴다. */
  readonly client: S3Client;
  readonly blobRepository: BlobRepository;
  readonly namespaceId: string;
  readonly nodeRepository: VfsNodeRepository;
  readonly trashRetention: VfsTrashRetentionRepository;
  readonly fileExpiry: VfsFileExpiryRepository;
  setZeroSinceSecondsAgo(blobId: string, secondsAgo: number): Promise<void>;
}

// Postgres/SQLite 공용 테스트 본문. 드라이버별 실행 파일(*.integration-spec.ts,
// *.sqlite.integration-spec.ts)이 이 함수를 호출해 같은 테스트를 두 드라이버에
// 대해 반복한다 — 테스트 로직 중복 없이 드라이버별 실행만 분리한다.
export function runGcJobSharedTests(getContext: () => GcJobTestContext): void {
  function makeConfig(gracePeriodSeconds: number): ConfigService {
    return {
      get: (key: string) => (key === 'STORIX_ORPHAN_GRACE_PERIOD' ? String(gracePeriodSeconds) : undefined),
    } as unknown as ConfigService;
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
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: `gc-trash-${randomUUID()}` }));
    const root = await dataSource.getRepository(VfsNodeEntity).save({
      namespaceId: namespace.id,
      parentId: null,
      name: '',
      type: 'DIRECTORY',
      blobId: null,
      size: null,
      mimeType: null,
    });
    const storageKey = `blobs/ab/${randomUUID()}`;
    const blob = await dataSource.getRepository(BlobEntity).save({
      namespaceId: namespace.id,
      storageKey,
      size: '7',
      mimeType: 'text/plain',
      sha256: 'f'.repeat(64),
      referenceCount: expiredCount + futureCount + 1,
    });
    await storage.put(storageKey, Readable.from(Buffer.from('content')));
    await dataSource.getRepository(VfsNodeEntity).save({
      namespaceId: namespace.id,
      parentId: root.id,
      name: 'live',
      type: 'FILE',
      blobId: blob.id,
      size: '7',
      mimeType: 'text/plain',
    });
    const ids: string[] = [];
    for (let index = 0; index < expiredCount + futureCount; index++) {
      const sourceNodeId = randomUUID();
      const trash = await dataSource.getRepository(VfsTrashEntity).save({
        namespaceId: namespace.id,
        rootType: 'FILE',
        originalPath: `/old-${index}`,
        rootNodeId: sourceNodeId,
        rootRevision: 'old-revision',
        nodeCount: '1',
        logicalBytes: '7',
        deletedAt: new Date(Date.now() - 31 * 86400000),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      await dataSource.getRepository(VfsTrashEntryEntity).save({
        namespaceId: namespace.id,
        trashId: trash.id,
        relativePath: '.',
        pathKey: '.',
        type: 'FILE',
        sourceNodeId,
        sourceRevision: 'old-revision',
        blobId: blob.id,
        size: '7',
        mimeType: 'text/plain',
      });
      if (index < expiredCount) {
        await dataSource
          .getRepository(VfsTrashEntity)
          .createQueryBuilder()
          .update()
          .set({ expiresAt: () => 'CURRENT_TIMESTAMP' })
          .where('id = :id', { id: trash.id })
          .execute();
      }
      ids.push(trash.id);
    }
    await dataSource.getRepository(NamespaceEntity).update(
      { id: namespace.id },
      {
        liveFileByteCount: '7',
        retainedTrashNodeCount: String(ids.length),
        retainedTrashByteCount: String(7 * ids.length),
      },
    );
    return { namespaceId: namespace.id, blob, ids, storageKey };
  }

  async function createExpiringFixture(trashEnabled: boolean, names: string[]) {
    const { dataSource, nodeRepository } = getContext();
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      randomUUID(),
      `gc-expiry-${randomUUID()}`,
    );
    await dataSource.getRepository(NamespaceEntity).update({ id: namespace.id }, { trashEnabled });
    const root = await dataSource
      .getRepository(VfsNodeEntity)
      .findOneByOrFail({ namespaceId: namespace.id, parentId: IsNull() });
    const ids: string[] = [];
    for (const name of names) {
      const created = await nodeRepository.withMutation(namespace.id, root.id, (tx) =>
        nodeRepository.putConditionalContent(
          tx,
          [name],
          { ifAbsent: true, expiresInSeconds: 600 },
          {
            storageKey: `blobs/ab/${randomUUID()}`,
            size: '7',
            mimeType: 'text/plain',
            sha256: 'f'.repeat(64),
            encryptionIv: null,
          },
        ),
      );
      ids.push(created.value.resource.id);
    }
    return { namespaceId: namespace.id, rootId: root.id, ids };
  }

  // 만료 삭제는 한 호출에 한 batch다. cursor를 이어 끝까지 돌려 합산한다.
  async function drainExpiry(
    fileExpiry: VfsFileExpiryRepository,
    batchSize: number,
  ): Promise<{ files: number; bytes: string }> {
    let cursor: FileExpiryCursor | null = null;
    let files = 0;
    let bytes = 0n;
    do {
      const batch: ExpiredFileBatch = await fileExpiry.expireDue(batchSize, cursor);
      files += batch.files;
      bytes += BigInt(batch.bytes);
      cursor = batch.next;
    } while (cursor !== null);
    return { files, bytes: bytes.toString() };
  }

  async function makeOverdue(id: string, secondsAgo = 60): Promise<void> {
    const { dataSource } = getContext();
    const now = await readDbNow(dataSource.manager);
    await dataSource
      .getRepository(VfsNodeEntity)
      .update({ id }, { expiresAt: new Date(now.getTime() - secondsAgo * 1000) });
  }

  it('만료 파일만 삭제하고 확정·미만료 파일은 보존한다', async () => {
    const { dataSource, fileExpiry } = getContext();
    const fixture = await createExpiringFixture(false, ['a', 'b', 'c']);
    await makeOverdue(fixture.ids[0]);
    await makeOverdue(fixture.ids[1]);
    await dataSource.getRepository(VfsNodeEntity).update({ id: fixture.ids[1] }, { expiresAt: null });

    expect(await drainExpiry(fileExpiry, 500)).toEqual({ files: 1, bytes: '7' });
    const remaining = await dataSource
      .getRepository(VfsNodeEntity)
      .findBy({ namespaceId: fixture.namespaceId, type: 'FILE' });
    expect(remaining.map((node) => node.id).sort()).toEqual([fixture.ids[1], fixture.ids[2]].sort());
    const namespace = await dataSource
      .getRepository(NamespaceEntity)
      .findOneByOrFail({ id: fixture.namespaceId });
    expect(String(namespace.liveFileByteCount)).toBe('14');
    expect(await dataSource.getRepository(VfsTrashEntity).countBy({ namespaceId: fixture.namespaceId })).toBe(
      0,
    );
  });

  it('휴지통이 켜진 namespace의 만료 파일을 휴지통으로 옮긴다', async () => {
    const { dataSource, fileExpiry } = getContext();
    const fixture = await createExpiringFixture(true, ['a']);
    await makeOverdue(fixture.ids[0]);

    expect(await drainExpiry(fileExpiry, 500)).toEqual({ files: 1, bytes: '7' });
    const trash = await dataSource.getRepository(VfsTrashEntity).findBy({ namespaceId: fixture.namespaceId });
    expect(trash).toHaveLength(1);
    expect(trash[0].originalPath).toBe('/a');
  });

  it('후보 조회 뒤 이동된 파일의 현재 경로를 따라 삭제한다', async () => {
    const { dataSource, nodeRepository, fileExpiry } = getContext();
    const fixture = await createExpiringFixture(false, ['a']);
    await makeOverdue(fixture.ids[0]);
    const originalExpire = nodeRepository.expireNode.bind(nodeRepository);
    const expire = jest
      .spyOn(nodeRepository, 'expireNode')
      .mockImplementationOnce(async (namespaceId, nodeId, cutoff) => {
        await nodeRepository.ensureDirectory(fixture.namespaceId, fixture.rootId, ['moved'], false);
        await nodeRepository.moveNode(
          fixture.namespaceId,
          fixture.rootId,
          ['a'],
          ['moved', 'a'],
          false,
          Number.MAX_SAFE_INTEGER,
        );
        return originalExpire(namespaceId, nodeId, cutoff);
      });
    try {
      expect(await drainExpiry(fileExpiry, 500)).toEqual({ files: 1, bytes: '7' });
    } finally {
      expire.mockRestore();
    }
    expect(await dataSource.getRepository(VfsNodeEntity).findOneBy({ id: fixture.ids[0] })).toBeNull();
  });

  it('잠긴 경로의 대상 ID가 후보와 다르면 삭제하지 않는다', async () => {
    const { dataSource, nodeRepository } = getContext();
    const fixture = await createExpiringFixture(false, ['a', 'b']);
    await makeOverdue(fixture.ids[0]);
    const other = await dataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: fixture.ids[1] });
    const cutoff = await readDbNow(dataSource.manager);
    // root 잠금을 쓰지 않는 외부 변경이 경로 해석과 대상 잠금 사이에 끼어든 경우를 재현한다.
    const lockTarget = jest
      .spyOn(
        nodeRepository as unknown as {
          lockTargetNode: (...args: unknown[]) => Promise<VfsNodeEntity | null>;
        },
        'lockTargetNode',
      )
      .mockResolvedValueOnce(other);
    try {
      expect(await nodeRepository.expireNode(fixture.namespaceId, fixture.ids[0], cutoff)).toBeNull();
    } finally {
      lockTarget.mockRestore();
    }
    expect(await dataSource.getRepository(VfsNodeEntity).findOneBy({ id: fixture.ids[0] })).not.toBeNull();
    await dataSource.getRepository(VfsNodeEntity).update({ id: fixture.ids[0] }, { expiresAt: null });
  });

  it('확정으로 건너뛴 항목이 있어도 작은 배치의 keyset을 전진한다', async () => {
    const { nodeRepository, fileExpiry } = getContext();
    const fixture = await createExpiringFixture(false, ['a', 'b', 'c', 'd', 'e']);
    for (const [index, id] of fixture.ids.entries()) await makeOverdue(id, 100 - index);
    const originalExpire = nodeRepository.expireNode.bind(nodeRepository);
    const expire = jest
      .spyOn(nodeRepository, 'expireNode')
      .mockImplementation(async (namespaceId, id, cutoff) => {
        if (id === fixture.ids[1]) {
          const node = await getContext().dataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id });
          await nodeRepository.withMutation(fixture.namespaceId, fixture.rootId, (tx) =>
            nodeRepository.applyConditionalMutation(tx, {
              kind: 'persist',
              path: '/b',
              segments: ['b'],
              ifRevision: encodeRevision(node),
            }),
          );
        }
        return originalExpire(namespaceId, id, cutoff);
      });
    try {
      expect(await drainExpiry(fileExpiry, 2)).toEqual({ files: 4, bytes: '28' });
    } finally {
      expire.mockRestore();
    }
  });

  it('DELETING namespace의 만료 파일은 보존한다', async () => {
    const { dataSource, fileExpiry } = getContext();
    const fixture = await createExpiringFixture(false, ['a']);
    await makeOverdue(fixture.ids[0]);
    await dataSource
      .getRepository(NamespaceEntity)
      .update({ id: fixture.namespaceId }, { status: 'DELETING' });

    expect(await drainExpiry(fileExpiry, 500)).toEqual({ files: 0, bytes: '0' });
    expect(await dataSource.getRepository(VfsNodeEntity).findOneBy({ id: fixture.ids[0] })).not.toBeNull();
  });

  it('확정과 만료 삭제가 경합하면 하나만 적용한다', async () => {
    const { dataSource, nodeRepository } = getContext();
    const fixture = await createExpiringFixture(false, ['a']);
    await makeOverdue(fixture.ids[0]);
    const node = await dataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: fixture.ids[0] });
    const cutoff = await readDbNow(dataSource.manager);

    const [expired, persisted] = await Promise.allSettled([
      nodeRepository.expireNode(fixture.namespaceId, node.id, cutoff),
      nodeRepository.withMutation(fixture.namespaceId, fixture.rootId, (tx) =>
        nodeRepository.applyConditionalMutation(tx, {
          kind: 'persist',
          path: '/a',
          segments: ['a'],
          ifRevision: encodeRevision(node),
        }),
      ),
    ]);
    const after = await dataSource.getRepository(VfsNodeEntity).findOneBy({ id: node.id });
    if (after === null) {
      expect(expired).toEqual({ status: 'fulfilled', value: { size: '7' } });
      expect(persisted.status).toBe('rejected');
      if (persisted.status === 'rejected') expect(persisted.reason).toBeInstanceOf(VfsNodeNotFoundError);
    } else {
      expect(after.expiresAt).toBeNull();
      expect(persisted.status).toBe('fulfilled');
      expect(expired).toEqual({ status: 'fulfilled', value: null });
    }
  });

  it('GC가 먼저 삭제하면 persist는 VFS_NODE_NOT_FOUND로 끝난다', async () => {
    const { dataSource, nodeRepository } = getContext();
    const fixture = await createExpiringFixture(false, ['a']);
    await makeOverdue(fixture.ids[0]);
    const node = await dataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: fixture.ids[0] });
    const cutoff = await readDbNow(dataSource.manager);

    expect(await nodeRepository.expireNode(fixture.namespaceId, node.id, cutoff)).toEqual({ size: '7' });
    await expect(
      nodeRepository.withMutation(fixture.namespaceId, fixture.rootId, (tx) =>
        nodeRepository.applyConditionalMutation(tx, {
          kind: 'persist',
          path: '/a',
          segments: ['a'],
          ifRevision: encodeRevision(node),
        }),
      ),
    ).rejects.toBeInstanceOf(VfsNodeNotFoundError);
  });

  it('persist가 먼저 확정하면 GC는 같은 파일을 삭제하지 않는다', async () => {
    const { dataSource, nodeRepository } = getContext();
    const fixture = await createExpiringFixture(false, ['a']);
    await makeOverdue(fixture.ids[0]);
    const node = await dataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: fixture.ids[0] });
    const cutoff = await readDbNow(dataSource.manager);

    await nodeRepository.withMutation(fixture.namespaceId, fixture.rootId, (tx) =>
      nodeRepository.applyConditionalMutation(tx, {
        kind: 'persist',
        path: '/a',
        segments: ['a'],
        ifRevision: encodeRevision(node),
      }),
    );
    expect(await nodeRepository.expireNode(fixture.namespaceId, node.id, cutoff)).toBeNull();
    expect(
      (await dataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: node.id })).expiresAt,
    ).toBeNull();
  });

  it('만료 예정 FILE의 setMimeType과 GC 만료 삭제가 경합해도 DB 상태가 일관된다', async () => {
    const { dataSource, nodeRepository } = getContext();
    const fixture = await createExpiringFixture(false, ['a']);
    await makeOverdue(fixture.ids[0]);
    const node = await dataSource.getRepository(VfsNodeEntity).findOneByOrFail({ id: fixture.ids[0] });
    const cutoff = await readDbNow(dataSource.manager);

    const [expired, mimeTypeChanged] = await Promise.allSettled([
      nodeRepository.expireNode(fixture.namespaceId, node.id, cutoff),
      nodeRepository.withMutation(fixture.namespaceId, fixture.rootId, (tx) =>
        nodeRepository.applyConditionalMutation(tx, {
          kind: 'setMimeType',
          path: '/a',
          segments: ['a'],
          ifRevision: encodeRevision(node),
          mimeType: 'image/png',
        }),
      ),
    ]);

    // setMimeType은 expiresAt을 읽지도 쓰지도 않으므로(persist와 달리 만료를 해제하지 않는다),
    // 실행 순서와 무관하게 GC는 항상 만료 삭제에 성공한다.
    expect(expired).toEqual({ status: 'fulfilled', value: { size: '7' } });
    expect(await dataSource.getRepository(VfsNodeEntity).findOneBy({ id: node.id })).toBeNull();
    if (mimeTypeChanged.status === 'rejected') {
      // GC가 먼저 삭제한 경우: setMimeType은 404로 끝난다.
      expect(mimeTypeChanged.reason).toBeInstanceOf(VfsNodeNotFoundError);
    } else {
      // setMimeType이 먼저 확정한 경우: 변경 자체는 성공하지만 만료는 그대로라 뒤이어 GC가 삭제한다.
      expect(mimeTypeChanged.value.value.status).toBe(200);
    }
  });

  it('GC 결과에 만료 삭제 건수와 바이트를 기록한다', async () => {
    const { storage, blobRepository, fileExpiry } = getContext();
    const fixture = await createExpiringFixture(false, ['a']);
    await makeOverdue(fixture.ids[0]);
    const job = new GcJob(
      storage,
      blobRepository,
      makeConfig(3600),
      undefined,
      undefined,
      undefined,
      undefined,
      fileExpiry,
    );

    const result = await job.run();
    expect(result.expiredFiles).toBeGreaterThanOrEqual(1);
    expect(BigInt(result.expiredBytes)).toBeGreaterThanOrEqual(7n);
  });

  it('만료 경계의 항목을 한 배치씩 purge하고 미만료 항목·공유 Blob·quota를 보존한다', async () => {
    const { dataSource, storage, trashRetention } = getContext();
    const fixture = await createTrashFixture(2, 1);
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const before = await namespaceRepo.findOneByOrFail({ id: fixture.namespaceId });
    expect([String(before.retainedTrashNodeCount), String(before.retainedTrashByteCount)]).toEqual([
      '3',
      '21',
    ]);

    expect(await trashRetention.pruneExpiredBatch(1)).toEqual({ items: 1, nodes: 1, bytes: '7', failed: 0 });
    const midway = await namespaceRepo.findOneByOrFail({ id: fixture.namespaceId });
    expect([String(midway.retainedTrashNodeCount), String(midway.retainedTrashByteCount)]).toEqual([
      '2',
      '14',
    ]);
    expect(await trashRetention.pruneExpiredBatch(1)).toEqual({ items: 1, nodes: 1, bytes: '7', failed: 0 });
    expect(await trashRetention.pruneExpiredBatch(1)).toEqual({ items: 0, nodes: 0, bytes: '0', failed: 0 });
    expect(
      await dataSource.getRepository(VfsTrashEntity).findBy({ namespaceId: fixture.namespaceId }),
    ).toHaveLength(1);
    const after = await namespaceRepo.findOneByOrFail({ id: fixture.namespaceId });
    expect([
      String(after.retainedTrashNodeCount),
      String(after.retainedTrashByteCount),
      String(after.liveFileByteCount),
    ]).toEqual(['1', '7', '7']);
    expect(
      (await dataSource.getRepository(BlobEntity).findOneByOrFail({ id: fixture.blob.id })).referenceCount,
    ).toBe(2);
    await expect(storage.get(fixture.storageKey)).resolves.toBeDefined();
  });

  it('손상된 휴지통 항목이 있어도 다른 namespace의 만료 항목은 정리하고 실패 수를 집계한다', async () => {
    const { dataSource, trashRetention } = getContext();
    const broken = await createTrashFixture(1, 0);
    const healthy = await createTrashFixture(1, 0);
    // entry 크기 합(7)과 manifest logical_bytes가 어긋난 손상 항목
    await dataSource.getRepository(VfsTrashEntity).update({ id: broken.ids[0] }, { logicalBytes: '8' });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const result = await trashRetention.pruneExpiredBatch(500);

      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(broken.ids[0]), expect.anything());
    } finally {
      error.mockRestore();
    }
    expect(await dataSource.getRepository(VfsTrashEntity).countBy({ namespaceId: healthy.namespaceId })).toBe(
      0,
    );
    expect(await dataSource.getRepository(VfsTrashEntity).countBy({ namespaceId: broken.namespaceId })).toBe(
      1,
    );
    // 같은 DB를 쓰는 뒤 테스트의 실패 수에 섞이지 않도록 손상 항목을 지운다.
    await dataSource.getRepository(VfsTrashEntryEntity).delete({ trashId: broken.ids[0] });
    await dataSource.getRepository(VfsTrashEntity).delete({ id: broken.ids[0] });
  });

  it('GC 결과는 완료된 만료 purge의 item 수와 논리 byte만 집계한다', async () => {
    const { dataSource, storage, blobRepository, trashRetention } = getContext();
    const fixture = await createTrashFixture(1, 1);
    const job = new GcJob(
      storage,
      blobRepository,
      makeConfig(3600),
      undefined,
      undefined,
      undefined,
      trashRetention,
    );
    const result = await job.run();
    expect([result.prunedTrashItems, result.prunedTrashBytes]).toEqual([1, '7']);
    expect(await dataSource.getRepository(VfsTrashEntity).countBy({ namespaceId: fixture.namespaceId })).toBe(
      1,
    );
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

    await expect(
      dataSource.getRepository(BlobEntity).findOneBy({ id: referenced.id }),
    ).resolves.not.toBeNull();
    await expect(storage.get(referenced.storageKey)).resolves.toBeDefined();
  });

  it('metadata 없이 grace period가 지난 orphan 스토리지 object를 회수한다', async () => {
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

  it('시작 뒤 최대 업로드 시간과 유예가 지난 미완료 multipart upload만 abort하고 Storix 밖 prefix는 건드리지 않는다', async () => {
    const { client, storage, blobRepository } = getContext();
    const bucket = (storage as unknown as { bucket: string }).bucket;
    async function startUpload(key: string): Promise<string> {
      const created = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
      await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: created.UploadId,
          PartNumber: 1,
          Body: Buffer.alloc(16),
        }),
      );
      return created.UploadId!;
    }
    const staleKey = `blobs/ab/${randomUUID()}`;
    const stagingKey = `upload-staging/${randomUUID()}`;
    const activeOldKey = `blobs/ab/${randomUUID()}`;
    const settledKey = `blobs/ab/${randomUUID()}`;
    const foreignKey = `foreign/${randomUUID()}`;
    await startUpload(staleKey);
    await startUpload(stagingKey);
    await startUpload(settledKey);
    const foreignUploadId = await startUpload(foreignKey);
    const queryFailureKey = `blobs/ab/${randomUUID()}`;
    await startUpload(queryFailureKey);
    const ownership = new StoragePutOwnershipRepository(getContext().dataSource);
    const writerExecutionId = randomUUID();
    const gcExecutionId = randomUUID();
    const activeExecutionId = randomUUID();
    await ownership.registerExecution(writerExecutionId);
    await ownership.registerExecution(gcExecutionId);
    await ownership.registerExecution(activeExecutionId);
    await ownership.beginPut(staleKey, writerExecutionId);
    await ownership.beginPut(stagingKey, writerExecutionId);
    await ownership.beginPut(queryFailureKey, writerExecutionId);
    await ownership
      .beginPut(settledKey, writerExecutionId)
      .then((attemptId) => ownership.settlePut(attemptId));

    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    async function* activeBody(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(17 * 1024 * 1024);
      await bodyGate;
      yield Buffer.from('tail');
    }
    const activePutStorage = new PutProtectedBlobStorage(storage, ownership, activeExecutionId);
    const activePut = activePutStorage.put(activeOldKey, Readable.from(activeBody()));
    const uploadReadyBy = Date.now() + 10_000;
    let activeMultipartVisible = false;
    while (Date.now() < uploadReadyBy) {
      const activeUploads = await storage.listIncompleteUploadsPage('blobs/ab/', { limit: 1000 });
      if (activeUploads.items.some((upload) => upload.key === activeOldKey)) {
        activeMultipartVisible = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!activeMultipartVisible) {
      releaseBody();
      await activePut;
      await storage.delete(activeOldKey);
    }
    expect(activeMultipartVisible).toBe(true);

    // 활성 SDK PUT를 cutoff보다 오래 열어 둔다.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const realClaim = ownership.claimForGc.bind(ownership);
    ownership.claimForGc = async (key, claimId, executionId) => {
      if (key === queryFailureKey) throw new Error('injected ownership database read failure');
      return realClaim(key, claimId, executionId);
    };
    const values: Record<string, string> = {
      STORIX_ORPHAN_GRACE_PERIOD: '1',
      STORIX_MUTATION_MAX_UPLOAD_SECONDS: '1',
    };
    const config = { get: (key: string) => values[key] } as unknown as ConfigService;

    const result = await new GcJob(
      storage,
      blobRepository,
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ownership,
      gcExecutionId,
    ).run();

    expect(result.abortedIncompleteUploads).toBe(1);
    const remaining = async (prefix: string) =>
      (await storage.listIncompleteUploadsPage(prefix, { limit: 1000 })).items.map((item) => item.key);
    expect(await remaining('blobs/')).toContain(activeOldKey);
    expect(await remaining('blobs/')).toContain(queryFailureKey);
    expect(await remaining('blobs/')).toContain(staleKey);
    expect(await remaining('blobs/')).not.toContain(settledKey);
    expect(await remaining('upload-staging/')).toContain(stagingKey);
    expect(await remaining('foreign/')).toContain(foreignKey);

    releaseBody();
    await activePut;
    await storage.delete(activeOldKey);
    ownership.claimForGc = realClaim;
    expect(await ownership.confirmExecutionStopped(writerExecutionId)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const recovery = await new GcJob(
      storage,
      blobRepository,
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ownership,
      gcExecutionId,
    ).run();
    expect(recovery.abortedIncompleteUploads).toBeGreaterThanOrEqual(3);
    expect(await remaining('blobs/')).not.toContain(activeOldKey);
    expect(await remaining('blobs/')).not.toContain(queryFailureKey);
    expect(await remaining('blobs/')).not.toContain(staleKey);
    expect(await remaining('upload-staging/')).not.toContain(stagingKey);

    await storage.abortIncompleteUpload(foreignKey, foreignUploadId);
  });

  it('metadata 없어도 grace period 이내면 orphan 스토리지 object를 보존한다', async () => {
    const { storage, blobRepository } = getContext();
    const freshOrphanKey = `blobs/ab/${randomUUID()}`;
    await storage.put(freshOrphanKey, Readable.from(Buffer.from('fresh orphan')));
    const job = new GcJob(storage, blobRepository, makeConfig(3600));

    await job.run();

    await expect(storage.get(freshOrphanKey)).resolves.toBeDefined();
  });
  it('storage page 한도를 넘는 미등록 object를 예산을 나눠 모두 회수하고 등록된 object는 보존한다', async () => {
    const { dataSource, storage, blobRepository } = getContext();
    const known = await createBlob(1);
    const unknownKeys = Array.from({ length: 1100 }, () => `blobs/ab/orphan-${randomUUID()}`);
    for (let start = 0; start < unknownKeys.length; start += 50) {
      await Promise.all(
        unknownKeys
          .slice(start, start + 50)
          .map((key) => storage.put(key, Readable.from(Buffer.from('orphan')))),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const config = {
      get: (key: string) =>
        key === 'STORIX_ORPHAN_GRACE_PERIOD'
          ? '1'
          : key === 'STORIX_GC_MAX_ROWS_PER_STAGE'
            ? '500'
            : undefined,
    } as unknown as ConfigService;
    const cursors = new GcCursorRepository(dataSource);
    const job = new GcJob(
      storage,
      blobRepository,
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      cursors,
    );

    const first = await job.run();
    expect(first.budgetExhaustedStages).toContain('orphan-objects-blobs');
    expect(await cursors.read('orphan-objects-blobs')).not.toBeNull();

    let deleted = first.deletedOrphanObjects;
    for (let run = 0; run < 10 && (await cursors.read('orphan-objects-blobs')) !== null; run++) {
      deleted += (await job.run()).deletedOrphanObjects;
    }

    expect(deleted).toBeGreaterThanOrEqual(unknownKeys.length);
    for (const key of [unknownKeys[0], unknownKeys[549], unknownKeys[1099]])
      await expect(storage.get(key)).rejects.toThrow();
    await expect(storage.get(known.storageKey)).resolves.toBeDefined();
    expect(await cursors.read('orphan-objects-blobs')).toBeNull();
  }, 120000);
}
