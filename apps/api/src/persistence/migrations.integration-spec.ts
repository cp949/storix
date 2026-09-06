import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, QueryDeepPartialEntity } from 'typeorm';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { AddBlobZeroSince1788800000000 } from './migrations/1788800000000-AddBlobZeroSince.js';
import { AddIdempotencyKey1788700000000 } from './migrations/1788700000000-AddIdempotencyKey.js';
import { AddNamespaceResourceLimits1789000000000 } from './migrations/1789000000000-AddNamespaceResourceLimits.js';
import { AddEncryptionSupport1789100000000 } from './migrations/1789100000000-AddEncryptionSupport.js';
import { InitSchema1788637362016 } from './migrations/1788637362016-InitSchema.js';

describe('Migration: InitSchema', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
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
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  it('namespace row를 생성하고 조회할 수 있다', async () => {
    const repo = dataSource.getRepository(NamespaceEntity);
    const saved = await repo.save(repo.create({ name: 'acme' }));

    const found = await repo.findOneByOrFail({ id: saved.id });

    expect(found.name).toBe('acme');
    expect(found.encryptionPolicy).toBe('NONE');
    expect(found.status).toBe('ACTIVE');
  });

  it('활성 namespace끼리는 같은 name을 가질 수 없다', async () => {
    const repo = dataSource.getRepository(NamespaceEntity);
    await repo.save(repo.create({ name: 'dup-active' }));

    await expect(repo.save(repo.create({ name: 'dup-active' }))).rejects.toThrow();
  });

  it('DELETED 상태의 namespace와는 같은 name을 재사용할 수 있다', async () => {
    const repo = dataSource.getRepository(NamespaceEntity);
    const first = await repo.save(repo.create({ name: 'reusable', status: 'DELETED' }));

    const second = await repo.save(repo.create({ name: 'reusable' }));

    expect(second.id).not.toBe(first.id);
  });

  it('blob의 reference_count는 음수가 될 수 없다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const blobRepo = dataSource.getRepository(BlobEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'blob-owner' }));

    await expect(
      blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: 'blobs/ab/negative',
          size: '10',
          mimeType: 'application/octet-stream',
          sha256: 'a'.repeat(64),
          referenceCount: -1,
        }),
      ),
    ).rejects.toThrow();
  });

  it('같은 storage_key를 가진 blob을 중복 생성할 수 없다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const blobRepo = dataSource.getRepository(BlobEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'blob-key-owner' }));
    const makeBlob = () =>
      blobRepo.create({
        namespaceId: namespace.id,
        storageKey: 'blobs/ab/dup-key',
        size: '1',
        mimeType: 'application/octet-stream',
        sha256: 'b'.repeat(64),
      });

    await blobRepo.save(makeBlob());

    await expect(blobRepo.save(makeBlob())).rejects.toThrow();
  });

  it('namespace당 parent_id가 NULL인 root는 하나만 존재할 수 있다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const nodeRepo = dataSource.getRepository(VfsNodeEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'root-owner' }));

    await nodeRepo.save(
      nodeRepo.create({
        namespaceId: namespace.id,
        parentId: null,
        type: 'DIRECTORY',
        name: '',
      }),
    );

    await expect(
      nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: null,
          type: 'DIRECTORY',
          name: '',
        }),
      ),
    ).rejects.toThrow();
  });

  it('FILE type node는 blob_id 없이 생성할 수 없다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const nodeRepo = dataSource.getRepository(VfsNodeEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'file-owner' }));
    const root = await nodeRepo.save(
      nodeRepo.create({
        namespaceId: namespace.id,
        parentId: null,
        type: 'DIRECTORY',
        name: '',
      }),
    );

    await expect(
      nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: root.id,
          type: 'FILE',
          name: 'a.txt',
          blobId: null,
        }),
      ),
    ).rejects.toThrow();
  });

  it('같은 parent 아래 같은 이름의 child를 중복 생성할 수 없다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const nodeRepo = dataSource.getRepository(VfsNodeEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'child-owner' }));
    const root = await nodeRepo.save(
      nodeRepo.create({
        namespaceId: namespace.id,
        parentId: null,
        type: 'DIRECTORY',
        name: '',
      }),
    );
    await nodeRepo.save(
      nodeRepo.create({
        namespaceId: namespace.id,
        parentId: root.id,
        type: 'DIRECTORY',
        name: 'dup',
      }),
    );

    await expect(
      nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespace.id,
          parentId: root.id,
          type: 'DIRECTORY',
          name: 'dup',
        }),
      ),
    ).rejects.toThrow();
  });

  it('다른 namespace 소속 parent를 참조하는 child는 생성할 수 없다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const nodeRepo = dataSource.getRepository(VfsNodeEntity);
    const namespaceA = await namespaceRepo.save(namespaceRepo.create({ name: 'ns-a' }));
    const namespaceB = await namespaceRepo.save(namespaceRepo.create({ name: 'ns-b' }));
    const rootA = await nodeRepo.save(
      nodeRepo.create({
        namespaceId: namespaceA.id,
        parentId: null,
        type: 'DIRECTORY',
        name: '',
      }),
    );

    await expect(
      nodeRepo.save(
        nodeRepo.create({
          namespaceId: namespaceB.id,
          parentId: rootA.id,
          type: 'DIRECTORY',
          name: 'x',
        }),
      ),
    ).rejects.toThrow();
  });

  describe('idempotency_key 제약', () => {
    it('같은 key로 두 번 생성할 수 없다', async () => {
      const repo = dataSource.getRepository(IdempotencyKeyEntity);
      const makeRow = () =>
        repo.create({
          key: 'dup-idempotency-key',
          requestHash: 'a'.repeat(64),
          responseStatus: 201,
          responseBody: { id: 'x' },
        });

      await repo.insert(makeRow() as QueryDeepPartialEntity<IdempotencyKeyEntity>);

      await expect(repo.insert(makeRow() as QueryDeepPartialEntity<IdempotencyKeyEntity>)).rejects.toThrow();
    });

    it('response_body를 jsonb 객체로 그대로 저장하고 조회한다', async () => {
      const repo = dataSource.getRepository(IdempotencyKeyEntity);
      const saved = await repo.save(
        repo.create({
          key: 'jsonb-idempotency-key',
          requestHash: 'b'.repeat(64),
          responseStatus: 409,
          responseBody: { code: 'NAMESPACE_ALREADY_EXISTS', message: '이미 존재함' },
        }),
      );

      const found = await repo.findOneByOrFail({ key: saved.key });

      expect(found.responseBody).toEqual({ code: 'NAMESPACE_ALREADY_EXISTS', message: '이미 존재함' });
      expect(found.responseStatus).toBe(409);
    });
  });

  describe('blob.zero_since', () => {
    it('생성 시 zero_since는 NULL이다', async () => {
      const namespaceRepo = dataSource.getRepository(NamespaceEntity);
      const blobRepo = dataSource.getRepository(BlobEntity);
      const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'zero-since-owner' }));

      const blob = await blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: 'blobs/ab/zero-since-null',
          size: '1',
          mimeType: 'application/octet-stream',
          sha256: 'c'.repeat(64),
          referenceCount: 1,
        }),
      );

      expect(blob.zeroSince).toBeNull();
    });

    it('zero_since를 채워 넣고 조회할 수 있다', async () => {
      const namespaceRepo = dataSource.getRepository(NamespaceEntity);
      const blobRepo = dataSource.getRepository(BlobEntity);
      const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'zero-since-set-owner' }));
      const blob = await blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: 'blobs/ab/zero-since-set',
          size: '1',
          mimeType: 'application/octet-stream',
          sha256: 'd'.repeat(64),
          referenceCount: 0,
        }),
      );

      await dataSource.query('UPDATE blob SET zero_since = now() WHERE id = $1', [blob.id]);
      const updated = await blobRepo.findOneByOrFail({ id: blob.id });

      expect(updated.zeroSince).toBeInstanceOf(Date);
    });
  });

  describe('namespace 리소스 상한 컬럼', () => {
    it('생성 시 세 컬럼 모두 NULL이다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);
      const saved = await repo.save(repo.create({ name: 'limits-null-owner' }));

      expect(saved.maxFileSizeBytes).toBeNull();
      expect(saved.maxSyncDeleteNodes).toBeNull();
      expect(saved.maxSyncCopyNodes).toBeNull();
    });

    it('값을 채워 넣고 조회할 수 있다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);
      const saved = await repo.save(
        repo.create({
          name: 'limits-set-owner',
          maxFileSizeBytes: '1000',
          maxSyncDeleteNodes: 5,
          maxSyncCopyNodes: 5,
        }),
      );

      const found = await repo.findOneByOrFail({ id: saved.id });

      expect(found.maxFileSizeBytes).toBe('1000');
      expect(found.maxSyncDeleteNodes).toBe(5);
      expect(found.maxSyncCopyNodes).toBe(5);
    });

    it('0 이하 값은 CHECK 제약 위반으로 거부된다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);

      await expect(
        repo.save(repo.create({ name: 'limits-invalid-owner', maxSyncDeleteNodes: 0 })),
      ).rejects.toThrow();
    });

    it('파일 크기 상한이 0이면 CHECK 제약 위반으로 거부된다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);

      await expect(
        repo.save(repo.create({ name: 'limits-invalid-file-size', maxFileSizeBytes: '0' })),
      ).rejects.toThrow();
    });

    it('동기 복사 노드 상한이 0이면 CHECK 제약 위반으로 거부된다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);

      await expect(
        repo.save(repo.create({ name: 'limits-invalid-copy-nodes', maxSyncCopyNodes: 0 })),
      ).rejects.toThrow();
    });
  });

  describe('암호화 정책 및 blob.encryption_iv 컬럼', () => {
    it('encryption_policy에 ENCRYPTED를 허용한다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);
      const saved = await repo.save(repo.create({ name: 'encrypted-ns-owner', encryptionPolicy: 'ENCRYPTED' }));

      expect(saved.encryptionPolicy).toBe('ENCRYPTED');
    });

    it('encryption_policy에 정의되지 않은 값은 CHECK 제약 위반으로 거부된다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);

      await expect(
        repo.save(repo.create({ name: 'invalid-policy-owner', encryptionPolicy: 'AES' as never })),
      ).rejects.toThrow();
    });

    it('blob.encryption_iv는 기본적으로 NULL이고, 16바이트 Buffer를 저장하고 조회할 수 있다', async () => {
      const namespaceRepo = dataSource.getRepository(NamespaceEntity);
      const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'blob-iv-owner' }));
      const blobRepo = dataSource.getRepository(BlobEntity);
      const withoutIv = await blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: 'blobs/00/no-iv',
          size: '0',
          mimeType: 'application/octet-stream',
          sha256: '0'.repeat(64),
        }),
      );
      expect(withoutIv.encryptionIv).toBeNull();

      const iv = Buffer.from('0'.repeat(32), 'hex');
      const withIv = await blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: 'blobs/00/with-iv',
          size: '0',
          mimeType: 'application/octet-stream',
          sha256: '1'.repeat(64),
          encryptionIv: iv,
        }),
      );
      const found = await blobRepo.findOneByOrFail({ id: withIv.id });

      expect(found.encryptionIv).toEqual(iv);
    });

    it('16바이트가 아닌 encryption_iv는 CHECK 제약 위반으로 거부된다', async () => {
      const namespaceRepo = dataSource.getRepository(NamespaceEntity);
      const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'blob-iv-invalid-owner' }));
      const blobRepo = dataSource.getRepository(BlobEntity);

      await expect(
        blobRepo.save(
          blobRepo.create({
            namespaceId: namespace.id,
            storageKey: 'blobs/00/bad-iv',
            size: '0',
            mimeType: 'application/octet-stream',
            sha256: '2'.repeat(64),
            encryptionIv: Buffer.from('ab', 'hex'),
          }),
        ),
      ).rejects.toThrow();
    });
  });
});

describe('Migration: AddBlobZeroSince backfill', () => {
  let container: StartedPostgreSqlContainer;
  let preBackfillDataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    preBackfillDataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: [InitSchema1788637362016, AddIdempotencyKey1788700000000],
    });
    await preBackfillDataSource.initialize();
    await preBackfillDataSource.runMigrations();
  }, 120000);

  afterAll(async () => {
    await preBackfillDataSource.destroy();
    await container.stop();
  });

  it('reference_count=0인 기존 blob에 zero_since를 백필한다', async () => {
    // AddNamespaceResourceLimits 이전 스키마에는 리소스 상한 컬럼이 없으므로,
    // 이미 그 컬럼을 알고 있는 NamespaceEntity를 통한 insert 대신 raw SQL을 사용한다
    // (아래 blob insert가 zero_since 컬럼을 피해가는 것과 동일한 이유)
    const namespaceId = randomUUID();
    await preBackfillDataSource.query(
      `INSERT INTO namespace (id, name, encryption_policy, status, created_at, updated_at)
       VALUES ($1, $2, 'NONE', 'ACTIVE', now(), now())`,
      [namespaceId, 'backfill-test-ns'],
    );

    // 마이그레이션 전에 reference_count=0인 blob을 삽입
    const blobId = randomUUID();
    await preBackfillDataSource.query(
      `INSERT INTO blob (id, namespace_id, storage_key, size, mime_type, sha256, reference_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        blobId,
        namespaceId,
        'blobs/ab/backfill-test',
        '100',
        'application/octet-stream',
        'e'.repeat(64),
        0,
      ],
    );

    // AddBlobZeroSince 마이그레이션 실행
    const queryRunner = preBackfillDataSource.createQueryRunner();
    try {
      const migration = new AddBlobZeroSince1788800000000();
      await migration.up(queryRunner);
    } finally {
      await queryRunner.release();
    }

    // zero_since가 백필되었는지 확인
    const result = await preBackfillDataSource.query(
      'SELECT zero_since FROM blob WHERE id = $1',
      [blobId],
    );

    expect(result).toHaveLength(1);
    expect(result[0].zero_since).not.toBeNull();
  });
});
