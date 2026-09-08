import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { MinioContainer, StartedMinioContainer } from '@testcontainers/minio';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { DataSource } from 'typeorm';
import { GcJob } from './gc.job.js';
import { BlobRepository } from '../persistence/blob.repository.js';
import { BlobEntity } from '../persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../persistence/entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from '../persistence/migrations/1788800000000-AddBlobZeroSince.js';
import { AddIdempotencyKey1788700000000 } from '../persistence/migrations/1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from '../persistence/migrations/1789000000000-AddNamespaceResourceLimits.js';
import { AddEncryptionSupport1789100000000 } from '../persistence/migrations/1789100000000-AddEncryptionSupport.js';
import { InitSchema1788637362016 } from '../persistence/migrations/1788637362016-InitSchema.js';
import { MinioBlobStorage } from '../storage/minio-blob-storage.js';

describe('GcJob 통합', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let minioContainer: StartedMinioContainer;
  let dataSource: DataSource;
  let blobRepository: BlobRepository;
  let storage: MinioBlobStorage;
  let namespaceId: string;
  const bucket = 'storix-gc-test';

  function makeConfig(gracePeriodSeconds: number): ConfigService {
    return { get: () => String(gracePeriodSeconds) } as unknown as ConfigService;
  }

  async function createBlob(referenceCount: number, zeroSinceHoursAgo?: number): Promise<BlobEntity> {
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
    if (zeroSinceHoursAgo !== undefined) {
      await dataSource.query(`UPDATE blob SET zero_since = now() - ($1 || ' hours')::interval WHERE id = $2`, [
        zeroSinceHoursAgo,
        blob.id,
      ]);
    }
    return blob;
  }

  beforeAll(async () => {
    [pgContainer, minioContainer] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      new MinioContainer('docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z').start(),
    ]);

    dataSource = new DataSource({
      type: 'postgres',
      url: pgContainer.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: [
        InitSchema1788637362016,
        AddIdempotencyKey1788700000000,
        AddBlobZeroSince1788800000000,
        AddNamespaceResourceLimits1789000000000,
        AddEncryptionSupport1789100000000,
      ],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    blobRepository = new BlobRepository(dataSource);

    const client = new Client({
      endPoint: minioContainer.getHost(),
      port: minioContainer.getPort(),
      useSSL: false,
      accessKey: minioContainer.getUsername(),
      secretKey: minioContainer.getPassword(),
    });
    await client.makeBucket(bucket);
    storage = new MinioBlobStorage(client, bucket, null);

    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'gc-job-owner' }));
    namespaceId = namespace.id;
  }, 180000);

  afterAll(async () => {
    await dataSource.destroy();
    await Promise.all([pgContainer.stop(), minioContainer.stop()]);
  });

  it('grace period가 지난 reference_count=0 blob의 object와 row를 모두 삭제한다', async () => {
    const expired = await createBlob(0, 2);
    const job = new GcJob(storage, blobRepository, makeConfig(3600));

    const result = await job.run();

    expect(result.deletedOrphanBlobs).toBeGreaterThanOrEqual(1);
    await expect(dataSource.getRepository(BlobEntity).findOneBy({ id: expired.id })).resolves.toBeNull();
    await expect(storage.get(expired.storageKey)).rejects.toThrow();
  });

  it('grace period 이내의 reference_count=0 blob은 건드리지 않는다', async () => {
    const recent = await createBlob(0, 0);
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
    const referenced = await createBlob(1);
    const job = new GcJob(storage, blobRepository, makeConfig(3600));

    await job.run();

    await expect(dataSource.getRepository(BlobEntity).findOneBy({ id: referenced.id })).resolves.not.toBeNull();
    await expect(storage.get(referenced.storageKey)).resolves.toBeDefined();
  });

  it('metadata 없이 grace period가 지난 orphan MinIO object를 회수한다', async () => {
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
    const freshOrphanKey = `blobs/ab/${randomUUID()}`;
    await storage.put(freshOrphanKey, Readable.from(Buffer.from('fresh orphan')));
    const job = new GcJob(storage, blobRepository, makeConfig(3600));

    await job.run();

    await expect(storage.get(freshOrphanKey)).resolves.toBeDefined();
  });
});
