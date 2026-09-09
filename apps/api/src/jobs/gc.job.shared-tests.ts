import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { GcJob } from './gc.job.js';
import { BlobRepository } from '../persistence/blob.repository.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { MinioBlobStorage } from '../storage/minio-blob-storage.js';

export interface GcJobTestContext {
  readonly dataSource: DataSource;
  readonly storage: MinioBlobStorage;
  readonly blobRepository: BlobRepository;
  readonly namespaceId: string;
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
