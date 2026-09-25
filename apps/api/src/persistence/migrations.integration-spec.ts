import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, QueryDeepPartialEntity } from 'typeorm';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { AddBlobZeroSince1788800000000 } from './migrations/1788800000000-AddBlobZeroSince.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';

describe('Migration: InitSchema', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  describe('snapshot schema', () => {
    it('captures immutable metadata and manifest columns with UUID and timestamp types', async () => {
      const columns: { table_name: string; column_name: string; data_type: string }[] =
        await dataSource.query(`
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_name IN ('vfs_snapshot', 'vfs_snapshot_entry')
      `);
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table_name: 'vfs_snapshot', column_name: 'id', data_type: 'uuid' }),
          expect.objectContaining({
            table_name: 'vfs_snapshot',
            column_name: 'namespace_id',
            data_type: 'uuid',
          }),
          expect.objectContaining({ table_name: 'vfs_snapshot', column_name: 'kind' }),
          expect.objectContaining({ table_name: 'vfs_snapshot', column_name: 'source_path' }),
          expect.objectContaining({
            table_name: 'vfs_snapshot',
            column_name: 'root_node_id',
            data_type: 'uuid',
          }),
          expect.objectContaining({ table_name: 'vfs_snapshot', column_name: 'source_revision' }),
          expect.objectContaining({ table_name: 'vfs_snapshot', column_name: 'root_type' }),
          expect.objectContaining({ table_name: 'vfs_snapshot', column_name: 'node_count' }),
          expect.objectContaining({
            table_name: 'vfs_snapshot',
            column_name: 'logical_bytes',
            data_type: 'bigint',
          }),
          expect.objectContaining({
            table_name: 'vfs_snapshot',
            column_name: 'created_at',
            data_type: 'timestamp with time zone',
          }),
          expect.objectContaining({ table_name: 'vfs_snapshot_entry', column_name: 'id', data_type: 'uuid' }),
          expect.objectContaining({
            table_name: 'vfs_snapshot_entry',
            column_name: 'namespace_id',
            data_type: 'uuid',
          }),
          expect.objectContaining({
            table_name: 'vfs_snapshot_entry',
            column_name: 'snapshot_id',
            data_type: 'uuid',
          }),
          expect.objectContaining({ table_name: 'vfs_snapshot_entry', column_name: 'relative_path' }),
          expect.objectContaining({ table_name: 'vfs_snapshot_entry', column_name: 'path_key' }),
          expect.objectContaining({ table_name: 'vfs_snapshot_entry', column_name: 'type' }),
          expect.objectContaining({
            table_name: 'vfs_snapshot_entry',
            column_name: 'source_node_id',
            data_type: 'uuid',
          }),
          expect.objectContaining({ table_name: 'vfs_snapshot_entry', column_name: 'source_revision' }),
          expect.objectContaining({
            table_name: 'vfs_snapshot_entry',
            column_name: 'blob_id',
            data_type: 'uuid',
          }),
          expect.objectContaining({
            table_name: 'vfs_snapshot_entry',
            column_name: 'size',
            data_type: 'bigint',
          }),
          expect.objectContaining({ table_name: 'vfs_snapshot_entry', column_name: 'mime_type' }),
        ]),
      );
    });

    it('enforces snapshot and entry foreign keys and checks without indexing long path text', async () => {
      const constraints: { table_name: string; constraint_name: string; constraint_type: string }[] =
        await dataSource.query(`
          SELECT tc.table_name, tc.constraint_name, tc.constraint_type
          FROM information_schema.table_constraints tc
          WHERE tc.table_name IN ('vfs_snapshot', 'vfs_snapshot_entry')
        `);
      const definitions: { conname: string; definition: string }[] = await dataSource.query(`
        SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid IN ('vfs_snapshot'::regclass, 'vfs_snapshot_entry'::regclass)
      `);
      expect(
        constraints.filter(
          (row) => row.table_name === 'vfs_snapshot' && row.constraint_type === 'FOREIGN KEY',
        ),
      ).toHaveLength(1);
      expect(
        constraints.filter(
          (row) => row.table_name === 'vfs_snapshot_entry' && row.constraint_type === 'FOREIGN KEY',
        ),
      ).toHaveLength(3);
      expect(definitions.map((row) => row.definition)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'FOREIGN KEY (namespace_id, blob_id) REFERENCES blob(namespace_id, id) ON DELETE RESTRICT',
          ),
        ]),
      );
      expect(
        definitions.some(
          (row) =>
            row.definition.includes('type') &&
            row.definition.includes('FILE') &&
            row.definition.includes('DIRECTORY'),
        ),
      ).toBe(true);
      expect(
        definitions.some((row) => row.definition.includes('size') && row.definition.includes('>= 0')),
      ).toBe(true);
      const indexes: { indexname: string; indexdef: string }[] = await dataSource.query(`
        SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'vfs_snapshot_entry'
      `);
      expect(indexes.map((row) => row.indexname)).toContain('idx_vfs_snapshot_entry_snapshot_id');
      expect(indexes.some((row) => /relative_path|path_key/.test(row.indexdef))).toBe(false);
    });

    it('defaults retained usage to zero and rejects invalid namespace snapshot limits or usage', async () => {
      const columns: { column_name: string; column_default: string | null }[] = await dataSource.query(`
        SELECT column_name, column_default FROM information_schema.columns
        WHERE table_name = 'namespace' AND column_name IN (
          'max_sync_snapshot_nodes', 'max_snapshot_bytes', 'max_retained_snapshot_nodes',
          'max_retained_snapshot_bytes', 'retained_snapshot_node_count', 'retained_snapshot_byte_count')
      `);
      expect(columns).toHaveLength(6);
      const namespace = await dataSource.getRepository(NamespaceEntity).save({ name: 'snapshot-limits-pg' });
      const usage = await dataSource.query(
        `SELECT retained_snapshot_node_count, retained_snapshot_byte_count
        FROM namespace WHERE id = $1`,
        [namespace.id],
      );
      expect(usage[0]).toMatchObject({ retained_snapshot_node_count: 0, retained_snapshot_byte_count: '0' });
      for (const column of [
        'max_sync_snapshot_nodes',
        'max_snapshot_bytes',
        'max_retained_snapshot_nodes',
        'max_retained_snapshot_bytes',
      ]) {
        await expect(
          dataSource.query(`UPDATE namespace SET ${column} = 0 WHERE id = $1`, [namespace.id]),
        ).rejects.toThrow();
      }
      for (const column of ['retained_snapshot_node_count', 'retained_snapshot_byte_count']) {
        await expect(
          dataSource.query(`UPDATE namespace SET ${column} = -1 WHERE id = $1`, [namespace.id]),
        ).rejects.toThrow();
      }
    });
  });

  it('creates the fenced VFS receipt table without changing namespace idempotency keys', async () => {
    const columns: { column_name: string; data_type: string }[] = await dataSource.query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'vfs_mutation_receipt'
    `);
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column_name: 'namespace_id', data_type: 'uuid' }),
        expect.objectContaining({ column_name: 'idempotency_key', data_type: 'uuid' }),
        expect.objectContaining({ column_name: 'generation', data_type: 'integer' }),
        expect.objectContaining({ column_name: 'expires_at', data_type: 'timestamp with time zone' }),
      ]),
    );
    const oldTable = await dataSource.query(`SELECT to_regclass('idempotency_key') AS name`);
    expect(oldTable[0].name).toBe('idempotency_key');
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

  describe('접근 정책 컬럼', () => {
    it('access_policy 기본값은 PRIVATE이다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);
      const saved = await repo.save(repo.create({ name: 'access-default-ns' }));

      const found = await repo.findOneByOrFail({ id: saved.id });

      expect(found.accessPolicy).toBe('PRIVATE');
    });

    it('access_policy에 PUBLIC을 허용한다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);
      const saved = await repo.save(repo.create({ name: 'public-ns-owner', accessPolicy: 'PUBLIC' }));

      expect(saved.accessPolicy).toBe('PUBLIC');
    });

    it('access_policy에 정의되지 않은 값은 CHECK 제약 위반으로 거부된다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);

      await expect(
        repo.save(repo.create({ name: 'invalid-access-owner', accessPolicy: 'OPEN' as never })),
      ).rejects.toThrow();
    });

    it('ENCRYPTED namespace를 PUBLIC으로 저장하면 CHECK 제약 위반으로 거부된다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);

      await expect(
        repo.save(
          repo.create({ name: 'encrypted-public-ns', encryptionPolicy: 'ENCRYPTED', accessPolicy: 'PUBLIC' }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('암호화 정책 및 blob.encryption_iv 컬럼', () => {
    it('encryption_policy에 ENCRYPTED를 허용한다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);
      const saved = await repo.save(
        repo.create({ name: 'encrypted-ns-owner', encryptionPolicy: 'ENCRYPTED' }),
      );

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

  describe('audit_log 테이블', () => {
    it('필수 필드만으로 row를 생성할 수 있고 나머지는 NULL이다', async () => {
      const repo = dataSource.getRepository(AuditLogEntity);
      const saved = await repo.save(
        repo.create({ requestId: 'req-minimal', operation: 'FsController.ls', status: 200 }),
      );

      const found = await repo.findOneByOrFail({ id: saved.id });

      expect(found.namespaceId).toBeNull();
      expect(found.path).toBeNull();
      expect(found.detail).toBeNull();
      expect(found.caller).toBeNull();
      expect(found.createdAt).toBeInstanceOf(Date);
    });

    it('존재하지 않는 namespace_id를 참조해도 저장된다(감사 로그는 FK로 namespace 존재를 검증하지 않는다 — 존재하지 않는 namespace 접근 시도 자체가 기록 대상)', async () => {
      const repo = dataSource.getRepository(AuditLogEntity);
      const unknownNamespaceId = randomUUID();

      const saved = await repo.save(
        repo.create({
          requestId: 'req-unknown-namespace',
          namespaceId: unknownNamespaceId,
          operation: 'FsController.mkdir',
          status: 404,
        }),
      );

      const found = await repo.findOneByOrFail({ id: saved.id });
      expect(found.namespaceId).toBe(unknownNamespaceId);
    });

    it('path/detail/caller를 채워 저장하고 그대로 조회한다', async () => {
      const namespaceRepo = dataSource.getRepository(NamespaceEntity);
      const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'audit-log-owner' }));
      const repo = dataSource.getRepository(AuditLogEntity);

      const saved = await repo.save(
        repo.create({
          requestId: 'req-full',
          namespaceId: namespace.id,
          operation: 'FsController.mv',
          path: '/a.txt',
          detail: { source: '/a.txt', destination: '/b.txt' },
          caller: 'billing-service',
          status: 200,
        }),
      );

      const found = await repo.findOneByOrFail({ id: saved.id });

      expect(found.path).toBe('/a.txt');
      expect(found.detail).toEqual({ source: '/a.txt', destination: '/b.txt' });
      expect(found.caller).toBe('billing-service');
    });
  });

  describe('gc_state 테이블', () => {
    it('id=1 행이 아닌 값은 CHECK 제약 위반으로 거부된다', async () => {
      await expect(
        dataSource.query('INSERT INTO gc_state (id, last_completed_at) VALUES (2, now())'),
      ).rejects.toThrow();
    });

    it('id=1 행은 upsert로 갱신할 수 있다', async () => {
      await dataSource.query(
        `INSERT INTO gc_state (id, last_completed_at) VALUES (1, now())
         ON CONFLICT (id) DO UPDATE SET last_completed_at = now()`,
      );

      const result = await dataSource.query('SELECT last_completed_at FROM gc_state WHERE id = 1');

      expect(result).toHaveLength(1);
      expect(result[0].last_completed_at).not.toBeNull();
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
      migrations: ALL_MIGRATIONS.slice(0, 2),
    });
    await preBackfillDataSource.initialize();
    await preBackfillDataSource.runMigrations();
  }, 120000);

  afterAll(async () => {
    await preBackfillDataSource.destroy();
    await container.stop();
  });

  it('reference_count=0인 기존 blob에 zero_since를 백필한다', async () => {
    // 백필 이전 스키마에는 최신 NamespaceEntity의 snapshot 컬럼이 없으므로 raw SQL을 쓴다.
    const namespaceId = randomUUID();
    await preBackfillDataSource.query(`INSERT INTO namespace (id, name) VALUES ($1, $2)`, [
      namespaceId,
      'backfill-test-ns',
    ]);

    // 마이그레이션 전에 reference_count=0인 blob을 삽입 — BlobEntity는 이 시점에
    // 아직 없는 zero_since 컬럼도 매핑하고 있어 repo.save()를 쓰면 그 컬럼까지
    // insert에 실려 실패하므로, zero_since를 뺀 raw SQL을 쓴다.
    const blobId = randomUUID();
    await preBackfillDataSource.query(
      `INSERT INTO blob (id, namespace_id, storage_key, size, mime_type, sha256, reference_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [blobId, namespaceId, 'blobs/ab/backfill-test', '100', 'application/octet-stream', 'e'.repeat(64), 0],
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
    const result = await preBackfillDataSource.query('SELECT zero_since FROM blob WHERE id = $1', [blobId]);

    expect(result).toHaveLength(1);
    expect(result[0].zero_since).not.toBeNull();
  });
});
