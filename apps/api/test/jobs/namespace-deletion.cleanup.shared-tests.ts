/**
 * 실제 PostgreSQL·SQLite와 object storage에서 삭제 재시작·정산·GC 경합을 검증한다.
 * 규칙은 docs/design/13-namespace-deletion.md "GC 단계". 결정은 api ADR-0032.
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import { IsNull } from 'typeorm';
import { GcJob } from '../../src/jobs/gc.job.js';
import { NamespaceDeletionCleanup } from '../../src/jobs/namespace-deletion.cleanup.js';
import { NamespaceDeletionCleanupRepository } from '../../src/persistence/namespace-deletion-cleanup.repository.js';
import { NamespaceDeletionRepository } from '../../src/persistence/namespace-deletion.repository.js';
import { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { NamespaceDeletionEntity } from '../../src/persistence/entities/namespace-deletion.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsSnapshotEntity } from '../../src/persistence/entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from '../../src/persistence/entities/vfs-snapshot-entry.entity.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsTrashEntryEntity } from '../../src/persistence/entities/vfs-trash-entry.entity.js';
import { VfsUploadSessionEntity } from '../../src/persistence/entities/vfs-upload-session.entity.js';
import { VfsUploadPartEntity } from '../../src/persistence/entities/vfs-upload-part.entity.js';
import { VfsUploadUsageEntity } from '../../src/persistence/entities/vfs-upload-usage.entity.js';
import { VfsChangeFeedStateEntity } from '../../src/persistence/entities/vfs-change-feed-state.entity.js';
import { VfsChangeEventEntity } from '../../src/persistence/entities/vfs-change-event.entity.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import type { GcJobTestContext } from './gc.job.shared-tests.js';

/** 두 드라이버에서 같은 정리 계약을 실행한다. */
export function runNamespaceDeletionCleanupTests(getContext: () => GcJobTestContext): void {
  const caps = {
    global: { maxStagedBytes: 10000000n, maxActiveSessions: 1000 },
    namespace: { maxStagedBytes: 10000000n, maxActiveSessions: 1000 },
  };
  /** 실제 repository를 사용하고 외부 장애·동시 순서만 주입한다. */
  function services() {
    const c = getContext();
    const uploads = new VfsUploadSessionRepository(c.dataSource);
    const repository = new NamespaceDeletionCleanupRepository(
      c.dataSource,
      c.nodeRepository,
      c.blobRepository,
      uploads,
    );
    const cleanup = new NamespaceDeletionCleanup(repository, uploads);
    const deletion = new NamespaceDeletionRepository(c.dataSource, uploads);
    const job = new GcJob(
      c.storage,
      c.blobRepository,
      { get: () => '1' } as unknown as ConfigService,
      undefined,
      uploads,
      undefined,
      c.trashRetention,
      c.fileExpiry,
      cleanup,
    );
    return { ...c, uploads, repository, cleanup, deletion, job };
  }
  /** 각 테스트는 새 UUID를 사용해 이전 보류 작업과 분리한다. */
  async function fixture(trashEnabled = false) {
    const c = services();
    const ns = await new NamespaceProvisioningRepository(c.dataSource).createWithRoot(
      randomUUID(),
      `delete-${randomUUID()}`,
    );
    await c.dataSource.manager.update(NamespaceEntity, ns.id, { trashEnabled });
    const root = await c.dataSource.manager.findOneByOrFail(VfsNodeEntity, {
      namespaceId: ns.id,
      parentId: IsNull(),
    });
    const accept = () => c.deletion.accept(ns.id, randomUUID(), new Date());
    const op = () => c.dataSource.manager.findOneByOrFail(NamespaceDeletionEntity, { namespaceId: ns.id });
    return { ...c, ns, root, accept, op };
  }
  /** live·보존 자료의 동일 Blob 공유를 구성한다. */
  async function content(f: Awaited<ReturnType<typeof fixture>>, retained = false) {
    const blob = await f.dataSource.manager.save(BlobEntity, {
      namespaceId: f.ns.id,
      storageKey: `blobs/ab/${randomUUID()}`,
      size: '7',
      mimeType: 'text/plain',
      sha256: 'f'.repeat(64),
      referenceCount: retained ? 3 : 1,
    });
    await f.storage.put(blob.storageKey, Readable.from('content'));
    const node = await f.dataSource.manager.save(VfsNodeEntity, {
      namespaceId: f.ns.id,
      parentId: f.root.id,
      name: randomUUID(),
      type: 'FILE',
      blobId: blob.id,
      size: '7',
      mimeType: 'text/plain',
    });
    await f.dataSource.manager.update(NamespaceEntity, f.ns.id, {
      liveFileByteCount: '7',
      liveNodeCount: '1',
      ...(retained
        ? {
            retainedSnapshotNodeCount: 1,
            retainedSnapshotByteCount: '7',
            retainedTrashNodeCount: '1',
            retainedTrashByteCount: '7',
          }
        : {}),
    });
    if (retained) {
      const common = {
        namespaceId: f.ns.id,
        rootNodeId: node.id,
        rootType: 'FILE' as const,
        nodeCount: 1,
        logicalBytes: '7',
      };
      const snap = await f.dataSource.manager.save(VfsSnapshotEntity, {
        ...common,
        kind: 'FILE',
        sourcePath: '/file',
        sourceRevision: 'rev',
      });
      const trash = await f.dataSource.manager.save(VfsTrashEntity, {
        ...common,
        nodeCount: '1',
        originalPath: '/old',
        rootRevision: 'rev',
        deletedAt: new Date(Date.now() - 7200000),
        expiresAt: new Date(Date.now() - 3600000),
      });
      const entry = {
        namespaceId: f.ns.id,
        relativePath: '.',
        pathKey: '.',
        type: 'FILE' as const,
        sourceNodeId: node.id,
        sourceRevision: 'rev',
        blobId: blob.id,
        size: '7',
        mimeType: 'text/plain',
      };
      await f.dataSource.manager.save(VfsSnapshotEntryEntity, { ...entry, snapshotId: snap.id });
      await f.dataSource.manager.save(VfsTrashEntryEntity, { ...entry, trashId: trash.id });
    }
    return blob;
  }
  /** upload admission을 통해 namespace·global usage를 함께 증가시킨다. */
  async function session(f: Awaited<ReturnType<typeof fixture>>, part?: 'STORED' | 'RESERVED') {
    const id = randomUUID();
    await f.uploads.createSession(
      {
        id,
        namespaceId: f.ns.id,
        scope: 'test',
        creationKey: randomUUID(),
        fingerprint: 'f'.repeat(64),
        targetPath: '/upload',
        sizeBytes: '7',
        mimeType: 'text/plain',
        conditionType: 'ABSENT',
        conditionRevision: null,
        fileExpiresInSeconds: null,
        partSizeBytes: 7,
        partCount: 1,
        now: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
        maxExpiresAt: new Date(Date.now() + 7200000),
      },
      caps,
    );
    const key = `upload-staging/${randomUUID()}`;
    if (part) {
      expect((await f.uploads.reservePart(id, 0, '7', key, caps)).kind).toBe('reserved');
      await f.storage.put(key, Readable.from('content'));
      if (part === 'STORED')
        expect(await f.uploads.commitPart(id, 0, 'f'.repeat(64), null, key)).toMatchObject({
          expiresAt: expect.any(Date),
        });
    }
    return { id, key };
  }
  /** lease를 과거로 옮겨 실제 reservation 회수 경로로 미정착 tombstone을 만든다. */
  async function unsettled(f: Awaited<ReturnType<typeof fixture>>) {
    const s = await session(f, 'RESERVED');
    await f.dataSource.manager.update(
      VfsUploadPartEntity,
      { sessionId: s.id },
      { leaseExpiresAt: new Date(Date.now() - 3600000) },
    );
    expect(await f.uploads.retireExpiredPartReservation(s.id, 0, s.key, new Date())).toBe(true);
    return s;
  }

  // 각 assertion은 최종 DB 상태와 object를 확인한다. spy는 장애와 경합 시점만 고정한다.
  it('빈 namespace는 GC 한 번에 METADATA·OBJECTS를 거쳐 DELETED가 된다', async () => {
    const f = await fixture();
    await f.accept();
    expect((await f.job.run()).completedNamespaceDeletions).toBeGreaterThanOrEqual(1);
    expect((await f.op()).phase).toBe('COMPLETED');
    expect((await f.dataSource.manager.findOneByOrFail(NamespaceEntity, { id: f.ns.id })).status).toBe(
      'DELETED',
    );
    expect(await f.dataSource.manager.countBy(VfsNodeEntity, { namespaceId: f.ns.id })).toBe(0);
  });

  it('OPEN session을 CANCELLED로 바꾸고 FINALIZING이 남으면 UPLOADS에 머문다', async () => {
    const f = await fixture();
    const open = await session(f);
    const finalizing = await session(f);
    await f.dataSource.manager.update(VfsUploadSessionEntity, finalizing.id, {
      state: 'FINALIZING',
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 3600000),
    });
    await f.accept();
    await f.job.run();
    expect((await f.op()).phase).toBe('UPLOADS');
    expect((await f.dataSource.manager.findOneByOrFail(VfsUploadSessionEntity, { id: open.id })).state).toBe(
      'CANCELLED',
    );
    await f.dataSource.manager.update(VfsUploadSessionEntity, finalizing.id, {
      leaseExpiresAt: new Date(Date.now() - 3600000),
    });
    await f.job.run();
    expect((await f.op()).phase).toBe('COMPLETED');
  });

  it('live·snapshot·trash가 같은 Blob을 공유해도 참조 수와 counter를 정확히 0으로 만든다', async () => {
    const f = await fixture();
    const blob = await content(f, true);
    await f.accept();
    await f.cleanup.advance(new Date());
    expect((await f.dataSource.manager.findOneByOrFail(BlobEntity, { id: blob.id })).referenceCount).toBe(0);
    expect(Object.values(await f.repository.readCounters(f.ns.id))).toEqual(['0', '0', '0', '0', '0', '0']);
    expect(await f.repository.countRemainingMetadata(f.ns.id)).toEqual({ nodes: 0, snapshots: 0, trash: 0 });
    await f.setZeroSinceSecondsAgo(blob.id, 10);
    await f.job.run();
    expect((await f.op()).phase).toBe('COMPLETED');
  });

  it.each([true, false])(
    '휴지통 ON·OFF namespace 모두 새 휴지통 항목을 만들지 않고 영구 제거한다: %s',
    async (trashEnabled) => {
      const f = await fixture(trashEnabled);
      await content(f);
      await f.accept();
      await f.cleanup.advance(new Date());
      expect(await f.dataSource.manager.countBy(VfsTrashEntity, { namespaceId: f.ns.id })).toBe(0);
      expect(await f.dataSource.manager.countBy(VfsNodeEntity, { namespaceId: f.ns.id })).toBe(1);
    },
  );

  it('500행을 넘는 tree를 여러 배치로 leaf부터 제거한다', async () => {
    const f = await fixture();
    const directory = await f.dataSource.manager.save(VfsNodeEntity, {
      namespaceId: f.ns.id,
      parentId: f.root.id,
      name: 'dir',
      type: 'DIRECTORY',
    });
    await f.dataSource.manager.insert(
      VfsNodeEntity,
      Array.from({ length: 503 }, (_, i) => ({
        id: randomUUID(),
        namespaceId: f.ns.id,
        parentId: directory.id,
        name: String(i),
        type: 'DIRECTORY' as const,
      })),
    );
    await f.dataSource.manager.update(NamespaceEntity, f.ns.id, { liveNodeCount: '504' });
    await f.accept();
    await f.repository.setPhase(f.ns.id, 'UPLOADS', 'METADATA');
    expect(await f.repository.removeLeafNodes(f.ns.id, 500)).toBe(500);
    expect(await f.dataSource.manager.findOneBy(VfsNodeEntity, { id: directory.id })).not.toBeNull();
    expect(await f.repository.removeLeafNodes(f.ns.id, 500)).toBe(3);
    expect(await f.repository.removeLeafNodes(f.ns.id, 500)).toBe(1);
    await f.job.run();
    expect((await f.op()).phase).toBe('COMPLETED');
  });

  it('배치 사이에 GC가 중단돼도 다음 실행이 이어서 정리하고 중복 차감하지 않는다', async () => {
    const f = await fixture();
    const blob = await content(f, true);
    await f.accept();
    const failure = jest.spyOn(f.repository, 'removeOneSnapshot').mockRejectedValueOnce(new Error('중단'));
    try {
      expect((await f.cleanup.advance(new Date())).failed).toBeGreaterThanOrEqual(1);
    } finally {
      failure.mockRestore();
    }
    expect((await f.op()).phase).toBe('METADATA');
    expect((await f.dataSource.manager.findOneByOrFail(BlobEntity, { id: blob.id })).referenceCount).toBe(2);
    await services().cleanup.advance(new Date());
    expect((await f.dataSource.manager.findOneByOrFail(BlobEntity, { id: blob.id })).referenceCount).toBe(0);
    expect(Object.values(await f.repository.readCounters(f.ns.id))).toEqual(['0', '0', '0', '0', '0', '0']);
  });

  it('두 GC 실행이 겹쳐도 참조 수와 counter를 한 번만 차감한다', async () => {
    const f = await fixture();
    const blob = await content(f, true);
    await f.accept();
    await Promise.all([f.job.run(), services().job.run()]);
    expect((await f.dataSource.manager.findOneByOrFail(BlobEntity, { id: blob.id })).referenceCount).toBe(0);
    expect(Object.values(await f.repository.readCounters(f.ns.id))).toEqual(['0', '0', '0', '0', '0', '0']);
    await f.setZeroSinceSecondsAgo(blob.id, 10);
    await Promise.all([f.job.run(), services().job.run()]);
    expect((await f.op()).phase).toBe('COMPLETED');
  });

  it('정리 중 Node 제거는 change-feed event를 만들지 않는다', async () => {
    const f = await fixture();
    await content(f);
    await f.nodeRepository.createChangeFeedCheckpoint(f.ns.id, f.root.id);
    await f.accept();
    await f.cleanup.advance(new Date());
    expect(await f.dataSource.manager.countBy(VfsChangeEventEntity, { namespaceId: f.ns.id })).toBe(0);
    expect(await f.dataSource.manager.countBy(VfsChangeFeedStateEntity, { namespaceId: f.ns.id })).toBe(0);
  });

  it('grace 전에는 OBJECTS에 머물고 grace 뒤 Blob row 제거와 함께 DELETED가 된다', async () => {
    const f = await fixture();
    const blob = await content(f);
    await f.accept();
    await f.job.run();
    expect((await f.op()).phase).toBe('OBJECTS');
    await expect(f.storage.get(blob.storageKey)).resolves.toBeDefined();
    await f.setZeroSinceSecondsAgo(blob.id, 10);
    await f.job.run();
    expect((await f.op()).phase).toBe('COMPLETED');
    expect(await f.dataSource.manager.findOneBy(BlobEntity, { id: blob.id })).toBeNull();
    await expect(f.storage.get(blob.storageKey)).rejects.toThrow();
  });

  it('object 삭제가 실패하면 STORAGE_DELETE_FAILED를 기록하고 다음 성공에서 해제한다', async () => {
    const f = await fixture();
    const blob = await content(f);
    await f.accept();
    await f.cleanup.advance(new Date());
    await f.setZeroSinceSecondsAgo(blob.id, 10);
    const real = f.storage.delete.bind(f.storage);
    const failure = jest.spyOn(f.storage, 'delete').mockImplementation(async (key) => {
      if (key === blob.storageKey) throw new Error('storage down');
      return real(key);
    });
    try {
      await f.job.run();
    } finally {
      failure.mockRestore();
    }
    expect((await f.op()).blockedReason).toBe('STORAGE_DELETE_FAILED');
    await f.job.run();
    expect(await f.op()).toMatchObject({ phase: 'COMPLETED', blockedReason: null });
  });

  /** orphan-blobs 단계의 한 page(500행)를 넘는 grace 경과 Blob을 만든다. 예산이 1이라 한 page 뒤 소진된다. */
  async function addOverdueBlobs(f: Awaited<ReturnType<typeof fixture>>, count: number) {
    const zeroSince = new Date(Date.now() - 10_000);
    for (let offset = 0; offset < count; offset += 100) {
      await f.dataSource.manager.insert(
        BlobEntity,
        Array.from({ length: Math.min(100, count - offset) }, () => ({
          namespaceId: f.ns.id,
          storageKey: `blobs/ab/${randomUUID()}`,
          size: '7',
          mimeType: 'text/plain',
          sha256: 'f'.repeat(64),
          referenceCount: 0,
          zeroSince,
        })),
      );
    }
  }

  it('orphan-blobs 단계가 예산 소진으로 멈춰도 남은 Blob을 STORAGE_DELETE_FAILED로 표시하지 않는다', async () => {
    const f = await fixture();
    const blob = await content(f);
    await f.accept();
    await f.cleanup.advance(new Date());
    await f.setZeroSinceSecondsAgo(blob.id, 10);
    await addOverdueBlobs(f, 600);

    const first = await f.job.run();

    expect(first.budgetExhaustedStages).toContain('orphan-blobs');
    expect(await f.dataSource.manager.countBy(BlobEntity, { namespaceId: f.ns.id })).toBeGreaterThan(0);
    expect(await f.op()).toMatchObject({ phase: 'OBJECTS', blockedReason: null });
    for (let run = 0; run < 5 && (await f.op()).phase !== 'COMPLETED'; run++) {
      await f.job.run();
      expect((await f.op()).blockedReason).toBeNull();
    }
    expect(await f.op()).toMatchObject({ phase: 'COMPLETED', blockedReason: null });
  });

  it('orphan-blobs 단계가 예산 소진으로 멈춘 실행은 이전의 STORAGE_DELETE_FAILED를 지우지 않는다', async () => {
    const f = await fixture();
    const blob = await content(f);
    await f.accept();
    await f.cleanup.advance(new Date());
    await f.setZeroSinceSecondsAgo(blob.id, 10);
    await addOverdueBlobs(f, 600);
    await f.repository.setBlocked(f.ns.id, 'STORAGE_DELETE_FAILED');

    const first = await f.job.run();

    expect(first.budgetExhaustedStages).toContain('orphan-blobs');
    expect((await f.op()).blockedReason).toBe('STORAGE_DELETE_FAILED');
  });

  it('inspectObjects는 참조 중·grace 경과·grace 대기 Blob 수를 구분해 센다', async () => {
    const f = await fixture();
    const make = (referenceCount: number, zeroSince: Date | null) => ({
      namespaceId: f.ns.id,
      storageKey: `blobs/ab/${randomUUID()}`,
      size: '7',
      mimeType: 'text/plain',
      sha256: 'f'.repeat(64),
      referenceCount,
      zeroSince,
    });
    const old = new Date(Date.now() - 3_600_000);
    const recent = new Date(Date.now() - 1_000);
    await f.dataSource.manager.insert(BlobEntity, [
      make(2, null),
      make(0, old),
      make(0, old),
      make(0, recent),
      make(0, recent),
      make(0, recent),
      make(0, null),
    ]);

    await expect(f.repository.inspectObjects(f.ns.id, new Date(Date.now() - 60_000))).resolves.toEqual({
      referenced: 1,
      overdue: 2,
      pending: 4,
    });
    await expect(f.repository.inspectObjects(randomUUID(), new Date())).resolves.toEqual({
      referenced: 0,
      overdue: 0,
      pending: 0,
    });
  });

  it('object 삭제 성공 후 Blob row 삭제가 실패하면 다음 실행이 재시도한다', async () => {
    const f = await fixture();
    const blob = await content(f);
    await f.accept();
    await f.cleanup.advance(new Date());
    await f.setZeroSinceSecondsAgo(blob.id, 10);
    const failure = jest
      .spyOn(f.blobRepository, 'deleteBlobRows')
      .mockRejectedValueOnce(new Error('DB down'));
    try {
      await expect(f.job.run()).rejects.toThrow('DB down');
    } finally {
      failure.mockRestore();
    }
    expect(await f.dataSource.manager.findOneBy(BlobEntity, { id: blob.id })).not.toBeNull();
    await expect(f.storage.get(blob.storageKey)).rejects.toThrow();
    await f.job.run();
    expect((await f.op()).phase).toBe('COMPLETED');
  });

  it('put_settled_at 없는 tombstone이 남으면 데이터는 제거하되 OBJECTS에서 UPLOAD_SETTLEMENT_UNKNOWN으로 멈춘다', async () => {
    const f = await fixture();
    await content(f, true);
    await unsettled(f);
    await f.accept();
    await f.cleanup.advance(new Date());
    for (const blob of await f.dataSource.manager.findBy(BlobEntity, { namespaceId: f.ns.id }))
      await f.setZeroSinceSecondsAgo(blob.id, 10);
    await f.job.run();
    expect(await f.op()).toMatchObject({ phase: 'OBJECTS', blockedReason: 'UPLOAD_SETTLEMENT_UNKNOWN' });
    expect(await f.repository.countRemainingMetadata(f.ns.id)).toEqual({ nodes: 0, snapshots: 0, trash: 0 });
  });

  it('미정착 tombstone으로 멈춘 operation은 재실행 중 blockedReason을 null로 되돌리지 않는다', async () => {
    const f = await fixture();
    await content(f, true);
    await unsettled(f);
    await f.accept();
    await f.cleanup.advance(new Date());
    for (const blob of await f.dataSource.manager.findBy(BlobEntity, { namespaceId: f.ns.id }))
      await f.setZeroSinceSecondsAgo(blob.id, 10);
    await f.job.run();
    expect((await f.op()).blockedReason).toBe('UPLOAD_SETTLEMENT_UNKNOWN');
    const record = jest.spyOn(f.repository, 'setBlocked');
    let reasons: unknown[];
    try {
      await f.job.run();
      reasons = record.mock.calls.filter(([id]) => id === f.ns.id).map(([, reason]) => reason);
    } finally {
      record.mockRestore();
    }
    expect(reasons).toEqual(['UPLOAD_SETTLEMENT_UNKNOWN']);
    expect((await f.op()).blockedReason).toBe('UPLOAD_SETTLEMENT_UNKNOWN');
  });

  it('counter가 데이터와 맞지 않으면 DATA_INCONSISTENT로 멈추고 0으로 덮어쓰지 않는다', async () => {
    const f = await fixture();
    await content(f);
    await f.dataSource.manager.update(NamespaceEntity, f.ns.id, { liveFileByteCount: '2' });
    await f.accept();
    await f.job.run();
    expect((await f.op()).blockedReason).toBe('DATA_INCONSISTENT');
    expect((await f.repository.readCounters(f.ns.id)).live).toBe('2');
    expect(await f.dataSource.manager.countBy(VfsNodeEntity, { namespaceId: f.ns.id, type: 'FILE' })).toBe(1);
    // 다음 사례의 GC에 의도적인 오류를 계속 남기지 않도록 정합성을 복구한다.
    await f.dataSource.manager.update(NamespaceEntity, f.ns.id, { liveFileByteCount: '7' });
  });

  it('같은 이름으로 새로 만든 namespace의 Blob·counter는 정리 중 바뀌지 않는다', async () => {
    const f = await fixture();
    await content(f);
    await f.accept();
    const newer = await new NamespaceProvisioningRepository(f.dataSource).createWithRoot(
      randomUUID(),
      f.ns.name,
    );
    const root = await f.dataSource.manager.findOneByOrFail(VfsNodeEntity, {
      namespaceId: newer.id,
      parentId: IsNull(),
    });
    const newBlob = await content({ ...f, ns: newer, root });
    await f.job.run();
    expect((await f.dataSource.manager.findOneByOrFail(BlobEntity, { id: newBlob.id })).referenceCount).toBe(
      1,
    );
    expect((await f.repository.readCounters(newer.id)).live).toBe('7');
  });

  it('DELETED 뒤 GC 재실행은 아무것도 바꾸지 않는다', async () => {
    const f = await fixture();
    await f.accept();
    await f.job.run();
    const before = await f.op();
    await f.job.run();
    expect(await f.op()).toEqual(before);
  });

  it('GC 격리: 한 namespace 정리 실패와 DELETING namespace의 만료 휴지통이 다른 GC 단계를 막지 않는다', async () => {
    const f = await fixture();
    await content(f, true);
    await f.accept();
    const other = await fixture();
    await other.accept();
    const original = f.repository.removeLeafNodes.bind(f.repository);
    const failure = jest.spyOn(f.repository, 'removeLeafNodes').mockImplementation(async (ns, limit) => {
      if (ns === f.ns.id) throw new Error('isolated failure');
      return original(ns, limit);
    });
    try {
      const result = await f.job.run();
      expect(result.failedNamespaceDeletions).toBeGreaterThanOrEqual(1);
      expect((await other.op()).phase).toBe('COMPLETED');
      expect(await f.dataSource.manager.countBy(VfsTrashEntity, { namespaceId: f.ns.id })).toBe(1);
    } finally {
      failure.mockRestore();
    }
  });

  it('global upload usage는 namespace 행과 같은 양만 줄고 별도로 차감되지 않는다', async () => {
    const f = await fixture();
    const other = await fixture();
    await session(f, 'STORED');
    await session(other, 'STORED');
    const global = () => f.dataSource.manager.findOneByOrFail(VfsUploadUsageEntity, { id: 'global' });
    const before = await global();
    await f.accept();
    await f.job.run();
    const after = await global();
    expect(BigInt(before.activeSessions) - BigInt(after.activeSessions)).toBe(1n);
    expect(BigInt(before.stagedBytes) - BigInt(after.stagedBytes)).toBe(7n);
    expect(await f.uploads.readNamespaceUsage(f.ns.id)).toEqual({ activeSessions: '0', stagedBytes: '0' });
    expect(await f.uploads.readNamespaceUsage(other.ns.id)).toEqual({
      activeSessions: '1',
      stagedBytes: '7',
    });
  });

  it('tombstone이 남은 session은 지우지 않고 늦은 PUT 종료가 tombstone을 정산한다', async () => {
    const f = await fixture();
    const s = await unsettled(f);
    await session(f);
    await f.accept();
    await f.job.run();
    expect(await f.uploads.countSessions(f.ns.id)).toBe(1);
    expect(await f.uploads.releasePartReservation(s.id, 0, true, s.key)).toBe(true);
    await f.job.run();
    expect((await f.op()).phase).toBe('COMPLETED');
    expect(await f.uploads.readNamespaceUsage(f.ns.id)).toEqual({ activeSessions: '0', stagedBytes: '0' });
  });

  it('METADATA 때 남은 STORED part를 기존 GC가 정리하면 OBJECTS에서 session을 지우고 완료한다', async () => {
    const f = await fixture();
    await session(f, 'STORED');
    await f.accept();
    await f.cleanup.advance(new Date());
    expect((await f.op()).phase).toBe('OBJECTS');
    expect(await f.uploads.countSessions(f.ns.id)).toBe(1);
    await f.job.run();
    expect((await f.op()).phase).toBe('COMPLETED');
    expect(await f.uploads.countSessions(f.ns.id)).toBe(0);
  });

  it('미정착 tombstone이 있는 session이 남으면 blockedReason은 UPLOAD_SETTLEMENT_UNKNOWN이다', async () => {
    const f = await fixture();
    await unsettled(f);
    await f.accept();
    await f.job.run();
    expect(await f.uploads.countSessions(f.ns.id)).toBe(1);
    expect(await f.op()).toMatchObject({ phase: 'OBJECTS', blockedReason: 'UPLOAD_SETTLEMENT_UNKNOWN' });
  });

  it('snapshot·trash의 2^53 초과 byte를 정확히 정산한다', async () => {
    const f = await fixture();
    const blob = await content(f, true);
    const size = '9007199254740993';
    const snapshot = await f.dataSource.manager.findOneByOrFail(VfsSnapshotEntity, { namespaceId: f.ns.id });
    const trash = await f.dataSource.manager.findOneByOrFail(VfsTrashEntity, { namespaceId: f.ns.id });
    // SQLite Number 변환을 거치지 않도록 실제 SQL의 정수 상수로 큰 값을 구성한다.
    await f.dataSource.query(`UPDATE blob SET size = ${size} WHERE id = '${blob.id}'`);
    await f.dataSource.query(`UPDATE vfs_node SET size = ${size} WHERE blob_id = '${blob.id}'`);
    await f.dataSource.query(`UPDATE vfs_snapshot_entry SET size = ${size} WHERE blob_id = '${blob.id}'`);
    await f.dataSource.query(`UPDATE vfs_trash_entry SET size = ${size} WHERE blob_id = '${blob.id}'`);
    await f.dataSource.query(`UPDATE vfs_snapshot SET logical_bytes = ${size} WHERE id = '${snapshot.id}'`);
    await f.dataSource.query(`UPDATE vfs_trash SET logical_bytes = ${size} WHERE id = '${trash.id}'`);
    await f.dataSource.query(
      `UPDATE namespace SET live_file_byte_count = ${size}, retained_snapshot_byte_count = ${size}, retained_trash_byte_count = ${size} WHERE id = '${f.ns.id}'`,
    );
    await f.accept();
    await f.cleanup.advance(new Date());
    expect(Object.values(await f.repository.readCounters(f.ns.id))).toEqual(['0', '0', '0', '0', '0', '0']);
    expect((await f.dataSource.manager.findOneByOrFail(BlobEntity, { id: blob.id })).referenceCount).toBe(0);
  });

  it('한 manifest의 여러 COW entry를 한 번에 차감한다', async () => {
    const f = await fixture();
    const blob = await content(f, true);
    const snapshot = await f.dataSource.manager.findOneByOrFail(VfsSnapshotEntity, { namespaceId: f.ns.id });
    const trash = await f.dataSource.manager.findOneByOrFail(VfsTrashEntity, { namespaceId: f.ns.id });
    for (const entity of [VfsSnapshotEntryEntity, VfsTrashEntryEntity]) {
      const original = await f.dataSource.manager.findOneByOrFail(entity, { namespaceId: f.ns.id });
      await f.dataSource.manager.update(entity, original.id, { relativePath: 'first', pathKey: 'first' });
      await f.dataSource.manager.save(entity, {
        ...original,
        id: randomUUID(),
        relativePath: 'copy',
        pathKey: 'copy',
      });
      await f.dataSource.manager.save(entity, {
        ...original,
        id: randomUUID(),
        type: 'DIRECTORY',
        blobId: null,
        size: null,
        mimeType: null,
      });
    }
    await f.dataSource.manager.update(VfsSnapshotEntity, snapshot.id, {
      kind: 'TREE',
      rootType: 'DIRECTORY',
      nodeCount: 3,
      logicalBytes: '14',
    });
    await f.dataSource.manager.update(VfsTrashEntity, trash.id, {
      rootType: 'DIRECTORY',
      nodeCount: '3',
      logicalBytes: '14',
    });
    await f.dataSource.manager.update(BlobEntity, blob.id, { referenceCount: 5 });
    await f.dataSource.manager.update(NamespaceEntity, f.ns.id, {
      retainedSnapshotNodeCount: 3,
      retainedSnapshotByteCount: '14',
      retainedTrashNodeCount: '3',
      retainedTrashByteCount: '14',
    });
    await f.accept();
    await f.cleanup.advance(new Date());
    expect((await f.dataSource.manager.findOneByOrFail(BlobEntity, { id: blob.id })).referenceCount).toBe(0);
    expect(Object.values(await f.repository.readCounters(f.ns.id))).toEqual(['0', '0', '0', '0', '0', '0']);
  });

  it('manifest 불일치는 entry·Blob 참조·counter를 모두 롤백한다', async () => {
    const f = await fixture();
    const blob = await content(f, true);
    const snapshot = await f.dataSource.manager.findOneByOrFail(VfsSnapshotEntity, { namespaceId: f.ns.id });
    await f.dataSource.manager.update(VfsSnapshotEntity, snapshot.id, { logicalBytes: '8' });
    await f.accept();
    await f.cleanup.advance(new Date());
    expect((await f.op()).blockedReason).toBe('DATA_INCONSISTENT');
    expect((await f.dataSource.manager.findOneByOrFail(BlobEntity, { id: blob.id })).referenceCount).toBe(2);
    expect(await f.dataSource.manager.countBy(VfsSnapshotEntryEntity, { snapshotId: snapshot.id })).toBe(1);
    expect((await f.repository.readCounters(f.ns.id)).snapBytes).toBe('7');
    await f.dataSource.manager.update(VfsSnapshotEntity, snapshot.id, { logicalBytes: '7' });
  });

  it('OBJECTS의 잔존 Blob 참조와 잔존 counter는 완료를 막는다', async () => {
    const f = await fixture();
    const blob = await content(f);
    await f.accept();
    await f.cleanup.advance(new Date());
    await f.dataSource.manager.update(BlobEntity, blob.id, { referenceCount: 1, zeroSince: null });
    await f.cleanup.settle(new Date(), new Date());
    expect((await f.op()).blockedReason).toBe('DATA_INCONSISTENT');
    await f.dataSource.manager.update(BlobEntity, blob.id, {
      referenceCount: 0,
      zeroSince: new Date(Date.now() - 10000),
    });
    await f.dataSource.manager.update(NamespaceEntity, f.ns.id, { retainedTrashByteCount: '1' });
    await f.job.run();
    expect((await f.op()).blockedReason).toBe('DATA_INCONSISTENT');
    expect((await f.repository.readCounters(f.ns.id)).trashBytes).toBe('1');
    await f.dataSource.manager.update(NamespaceEntity, f.ns.id, { retainedTrashByteCount: '0' });
  });

  it('ACTIVE에서 선택된 휴지통 후보의 root가 삭제되어도 현재 GC와 다음 namespace 정리를 계속한다', async () => {
    const f = await fixture();
    const blob = await content(f, true);
    const other = await fixture();
    await content(other, true);
    const original = f.nodeRepository.purgeTrashItem.bind(f.nodeRepository);
    let injected = false;
    const race = jest.spyOn(f.nodeRepository, 'purgeTrashItem').mockImplementation(async (ns, id, tx) => {
      if (ns === f.ns.id && !tx && !injected) {
        injected = true;
        await f.accept();
        await f.cleanup.advance(new Date());
        await f.setZeroSinceSecondsAgo(blob.id, 10);
        await f.storage.delete(blob.storageKey);
        await f.blobRepository.deleteBlobRows([blob.id]);
        await f.cleanup.settle(new Date(Date.now() - 1000), new Date());
        expect((await f.op()).phase).toBe('COMPLETED');
      }
      return original(ns, id, tx);
    });
    try {
      await expect(f.job.run()).resolves.toBeDefined();
    } finally {
      race.mockRestore();
    }
    expect(injected).toBe(true);
    expect(await f.dataSource.manager.countBy(VfsTrashEntity, { namespaceId: other.ns.id })).toBe(0);
  });

  it('ACTIVE namespace의 root 손상은 건너뛰지 않고 error 로그와 실패 수로 남긴다', async () => {
    const f = await fixture();
    await content(f, true);
    const original = f.nodeRepository.purgeTrashItem.bind(f.nodeRepository);
    const race = jest.spyOn(f.nodeRepository, 'purgeTrashItem').mockImplementation(async (ns, id, tx) => {
      if (ns === f.ns.id && !tx) {
        await f.dataSource.manager.delete(VfsNodeEntity, { namespaceId: f.ns.id, type: 'FILE' });
        await f.dataSource.manager.delete(VfsNodeEntity, { id: f.root.id });
      }
      return original(ns, id, tx);
    });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(f.trashRetention.pruneExpiredBatch(500)).resolves.toMatchObject({ failed: 1 });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`휴지통 보존 정리 실패 namespace=${f.ns.id}`),
        expect.anything(),
      );
    } finally {
      race.mockRestore();
      error.mockRestore();
    }
    expect((await f.dataSource.manager.findOneByOrFail(NamespaceEntity, { id: f.ns.id })).status).toBe(
      'ACTIVE',
    );
  });
}
