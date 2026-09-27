import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuditLogEntity } from '../../src/persistence/entities/audit-log.entity.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { AddVfsChangeFeed1791700000006 } from '../../src/persistence/migrations/1791700000006-AddVfsChangeFeed.js';
import { AddVfsSnapshotListIndex1791500000000 } from '../../src/persistence/migrations/1791500000000-AddVfsSnapshotListIndex.js';
import { AddAuditLogSnapshotId1791600000000 } from '../../src/persistence/migrations/1791600000000-AddAuditLogSnapshotId.js';
import { AddVfsTrash1791700000007 } from '../../src/persistence/migrations/1791700000007-AddVfsTrash.js';

// 이 파일은 STORIX_DB_DRIVER=sqlite를 얹은 별도 jest 실행으로만 돌린다
// (Task 6 Step 6 참고) — 전체 test:integration에 포함시키면 같은 워커의
// Postgres 테스트가 dialect-column-types 상수 오염으로 깨진다.
describe('마이그레이션 체인 (SQLite)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error(
        'STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행하면 엔티티의 bytea/timestamptz 대체 상수가 postgres 값으로 고정돼 의미가 없다',
      );
    }
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('trash migration initializes counters, preserves existing namespaces, and reverses its own schema', async () => {
    const namespace = await dataSource.getRepository(NamespaceEntity).save({ name: `trash-migration-${randomUUID()}` });
    const migration = new AddVfsTrash1791700000007();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      expect(await runner.query('SELECT id FROM namespace WHERE id = ?', [namespace.id])).toEqual([{ id: namespace.id }]);
      expect(await runner.query("SELECT name FROM sqlite_master WHERE name IN ('vfs_trash', 'vfs_trash_entry')"))
        .toEqual([]);
      await migration.up(runner);
      expect(await runner.query('SELECT retained_trash_node_count, retained_trash_byte_count FROM namespace WHERE id = ?', [namespace.id]))
        .toEqual([{ retained_trash_node_count: 0, retained_trash_byte_count: 0 }]);
      expect(await runner.query('PRAGMA table_info(vfs_trash)')).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'id', type: 'varchar(36)' }),
        expect.objectContaining({ name: 'node_count', type: 'bigint' }),
        expect.objectContaining({ name: 'deleted_at', type: 'datetime' }),
        expect.objectContaining({ name: 'expires_at', type: 'datetime' }),
      ]));
      expect(await runner.query('PRAGMA table_info(namespace)')).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'retained_trash_node_count', type: 'bigint' }),
      ]));
      await runner.query('UPDATE namespace SET retained_trash_node_count = ? WHERE id = ?',
        [Number.MAX_SAFE_INTEGER.toString(), namespace.id]);
      expect(await runner.query('SELECT retained_trash_node_count FROM namespace WHERE id = ?', [namespace.id]))
        .toEqual([{ retained_trash_node_count: Number.MAX_SAFE_INTEGER }]);
      expect(await runner.query('PRAGMA table_info(vfs_trash_entry)')).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'source_node_id', type: 'varchar(36)' }),
        expect.objectContaining({ name: 'blob_id', type: 'varchar(36)' }),
      ]));
      expect(await runner.query('PRAGMA foreign_key_list(vfs_trash)')).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'namespace', on_delete: 'CASCADE' }),
      ]));
      expect(await runner.query('PRAGMA foreign_key_list(vfs_trash_entry)')).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'vfs_trash', on_delete: 'CASCADE' }),
        expect.objectContaining({ table: 'blob', on_delete: 'RESTRICT' }),
      ]));
      await expect(runner.query('UPDATE namespace SET retained_trash_node_count = -1 WHERE id = ?', [namespace.id])).rejects.toThrow();
      await expect(runner.query('UPDATE namespace SET retained_trash_byte_count = -1 WHERE id = ?', [namespace.id])).rejects.toThrow();
    } finally {
      await runner.release();
    }
  });

  it('trash entries belong to their namespace and cascade when the trash item is removed', async () => {
    const namespace = await dataSource.getRepository(NamespaceEntity).save({ name: `trash-owner-${randomUUID()}` });
    const other = await dataSource.getRepository(NamespaceEntity).save({ name: `trash-other-${randomUUID()}` });
    const trashId = randomUUID();
    const entryId = randomUUID();
    await dataSource.query(`INSERT INTO vfs_trash
      (id, namespace_id, root_type, original_path, root_node_id, root_revision, node_count, logical_bytes, expires_at)
      VALUES (?, ?, 'DIRECTORY', '/old', ?, 'r1', 1, 0, datetime('now', '+30 days'))`,
    [trashId, namespace.id, randomUUID()]);
    const addEntry = (owner: string) => dataSource.query(`INSERT INTO vfs_trash_entry
      (id, namespace_id, trash_id, relative_path, path_key, type, source_node_id, source_revision)
      VALUES (?, ?, ?, '', '', 'DIRECTORY', ?, 'r1')`,
    [entryId, owner, trashId, randomUUID()]);
    await expect(addEntry(other.id)).rejects.toThrow();
    await addEntry(namespace.id);
    await dataSource.query('DELETE FROM vfs_trash WHERE id = ?', [trashId]);
    expect(await dataSource.query('SELECT id FROM vfs_trash_entry WHERE id = ?', [entryId])).toEqual([]);
  });

  it('change feed migration down/up은 기존 VFS 노드를 보존한다', async () => {
    const namespace = await dataSource.getRepository(NamespaceEntity).save({ name: 'feed-migration-sqlite' });
    const node = await dataSource.getRepository(VfsNodeEntity).save({
      namespaceId: namespace.id, parentId: null, type: 'DIRECTORY', name: '',
    });
    const migration = new AddVfsChangeFeed1791700000006();
    const runner = dataSource.createQueryRunner();
    try {
      const stateColumns = await runner.query('PRAGMA table_info(vfs_change_feed_state)');
      const eventColumns = await runner.query('PRAGMA table_info(vfs_change_event)');
      expect(stateColumns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'namespace_id', type: 'varchar(36)' }),
        expect.objectContaining({ name: 'signing_secret', type: 'varchar(64)' }),
      ]));
      expect(eventColumns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'occurred_at', type: 'datetime' }),
      ]));
      const foreignKeys = await runner.query('PRAGMA foreign_key_list(vfs_change_event)');
      expect(foreignKeys).toEqual(expect.arrayContaining([
        expect.objectContaining({ table: 'namespace', on_delete: 'CASCADE' }),
      ]));
      await runner.query('INSERT INTO vfs_change_feed_state (namespace_id, has_checkpoint, signing_secret) VALUES (?, 1, ?)', [namespace.id, 'a'.repeat(64)]);
      await migration.down(runner);
      expect(await runner.query(`SELECT name FROM sqlite_master WHERE name IN ('vfs_change_feed_state', 'vfs_change_event')`))
        .toEqual([]);
      expect(await dataSource.getRepository(VfsNodeEntity).findOneBy({ id: node.id })).not.toBeNull();
      await migration.up(runner);
      expect(await runner.query('PRAGMA index_list(vfs_change_event)')).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'idx_vfs_change_event_occurred_at' }),
      ]));
    } finally {
      await runner.release();
    }
  });

  it('change feed FK는 namespace 삭제 시 event와 signing secret 상태를 함께 제거한다', async () => {
    const namespace = await dataSource.getRepository(NamespaceEntity).save({ name: `feed-fk-${randomUUID()}` });
    await dataSource.query(`INSERT INTO vfs_change_feed_state
      (namespace_id, last_sequence, has_checkpoint, signing_secret) VALUES (?, 1, 1, ?)`,
    [namespace.id, 'b'.repeat(64)]);
    await dataSource.query(`INSERT INTO vfs_change_event
      (namespace_id, sequence, operation_id, operation_index, operation_count,
       kind, node_id, node_type, path, revision)
      VALUES (?, 1, ?, 0, 1, 'created', ?, 'DIRECTORY', '/', 'r1')`,
    [namespace.id, randomUUID(), randomUUID()]);
    await dataSource.getRepository(NamespaceEntity).delete({ id: namespace.id });
    expect(await dataSource.query('SELECT * FROM vfs_change_feed_state WHERE namespace_id = ?', [namespace.id]))
      .toEqual([]);
    expect(await dataSource.query('SELECT * FROM vfs_change_event WHERE namespace_id = ?', [namespace.id]))
      .toEqual([]);
  });

  it('18개 마이그레이션이 전부 적용된다', async () => {
    const applied = await dataSource.query('SELECT name FROM migrations ORDER BY id');
    expect(applied.map((row: { name: string }) => row.name)).toEqual([
      'InitSchema1788637362016',
      'AddIdempotencyKey1788700000000',
      'AddBlobZeroSince1788800000000',
      'AddAuditLog1789200000000',
      'AddGcState1789300000000',
      'AddVfsMutationReceipt1789400000000',
      'AddVfsSnapshots1790400000000',
      'AddNamespaceLogicalQuota1791400000000',
      'AddVfsSnapshotListIndex1791500000000',
      'AddAuditLogSnapshotId1791600000000',
      'AddVfsUploadSessions1791700000000',
      'AddUploadCreationExpiry1791700000001',
      'AddUploadFinalizeLeaseToken1791700000002',
      'AddUploadCreationRequestId1791700000003',
      'AddUploadPartLease1791700000004',
      'AddUploadChecksumFailure1791700000005',
      'AddVfsChangeFeed1791700000006',
      'AddVfsTrash1791700000007',
    ]);
  });

  it('감사 snapshot_id 컬럼은 nullable이며 up/down이 가역이다', async () => {
    const migration = new AddAuditLogSnapshotId1791600000000();
    const runner = dataSource.createQueryRunner();
    await dataSource.query(`INSERT INTO audit_log (request_id, operation, status)
      VALUES ('before-snapshot-id-migration', 'migration.test', 200)`);
    await migration.down(runner);
    await migration.up(runner);
    const columns = await dataSource.query("PRAGMA table_info('audit_log')");
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'snapshot_id', notnull: 0, type: 'varchar(36)' }),
    ]));
    expect(await dataSource.query(`SELECT snapshot_id FROM audit_log
      WHERE request_id = 'before-snapshot-id-migration'`)).toEqual([{ snapshot_id: null }]);
    await runner.release();
  });

  it('snapshot 목록 인덱스 migration은 up/down이 가역이다', async () => {
    const migration = new AddVfsSnapshotListIndex1791500000000();
    const runner = dataSource.createQueryRunner();
    await migration.down(runner);
    expect(await dataSource.query(`PRAGMA index_list('vfs_snapshot')`)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'IDX_vfs_snapshot_file_list' })]),
    );
    await migration.up(runner);
    expect(await dataSource.query(`PRAGMA index_list('vfs_snapshot')`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'IDX_vfs_snapshot_file_list' })]),
    );
    await runner.release();
  });

  describe('snapshot schema', () => {
    it('creates metadata and manifest columns, foreign keys, and a snapshot_id index', async () => {
      const snapshotColumns = await dataSource.query('PRAGMA table_info(vfs_snapshot)');
      const entryColumns = await dataSource.query('PRAGMA table_info(vfs_snapshot_entry)');
      expect(snapshotColumns.map((column: { name: string }) => column.name)).toEqual(
        expect.arrayContaining([
          'id',
          'namespace_id',
          'kind',
          'source_path',
          'root_node_id',
          'source_revision',
          'root_type',
          'node_count',
          'logical_bytes',
          'created_at',
        ]),
      );
      expect(entryColumns.map((column: { name: string }) => column.name)).toEqual(
        expect.arrayContaining([
          'id',
          'namespace_id',
          'snapshot_id',
          'relative_path',
          'path_key',
          'type',
          'source_node_id',
          'source_revision',
          'blob_id',
          'size',
          'mime_type',
        ]),
      );
      const snapshotFks = await dataSource.query('PRAGMA foreign_key_list(vfs_snapshot)');
      const entryFks = await dataSource.query('PRAGMA foreign_key_list(vfs_snapshot_entry)');
      expect(snapshotFks.map((fk: { table: string }) => fk.table)).toContain('namespace');
      expect(entryFks.map((fk: { table: string }) => fk.table)).toEqual(
        expect.arrayContaining(['namespace', 'vfs_snapshot', 'blob']),
      );
      expect(
        entryFks
          .filter((fk: { table: string; on_delete: string }) => fk.table === 'blob')
          .every((fk: { on_delete: string }) => fk.on_delete === 'RESTRICT'),
      ).toBe(true);
      const indexes = await dataSource.query('PRAGMA index_list(vfs_snapshot_entry)');
      expect(indexes.map((index: { name: string }) => index.name)).toContain(
        'idx_vfs_snapshot_entry_snapshot_id',
      );
      const snapshotIndex = await dataSource.query('PRAGMA index_info(idx_vfs_snapshot_entry_snapshot_id)');
      expect(snapshotIndex.map((column: { name: string }) => column.name)).toEqual(['snapshot_id']);
      const uniqueColumns = await Promise.all(
        indexes
          .filter((index: { unique: number }) => index.unique === 1)
          .map(async (index: { name: string }) => {
            const columns = await dataSource.query(`PRAGMA index_info("${index.name}")`);
            return columns.map((column: { name: string }) => column.name);
          }),
      );
      expect(
        uniqueColumns.some(
          (columns: string[]) => columns.includes('relative_path') || columns.includes('path_key'),
        ),
      ).toBe(false);
    });

    it('defaults retained usage to zero and rejects nonpositive overrides and negative usage', async () => {
      const namespace = await dataSource
        .getRepository(NamespaceEntity)
        .save({ name: 'snapshot-limits-sqlite' });
      const usage = await dataSource.query(
        `SELECT retained_snapshot_node_count, retained_snapshot_byte_count
        FROM namespace WHERE id = ?`,
        [namespace.id],
      );
      expect(usage[0]).toMatchObject({ retained_snapshot_node_count: 0, retained_snapshot_byte_count: 0 });
      for (const column of [
        'max_sync_snapshot_nodes',
        'max_snapshot_bytes',
        'max_retained_snapshot_nodes',
        'max_retained_snapshot_bytes',
      ]) {
        await expect(
          dataSource.query(`UPDATE namespace SET ${column} = 0 WHERE id = ?`, [namespace.id]),
        ).rejects.toThrow();
      }
      for (const column of ['retained_snapshot_node_count', 'retained_snapshot_byte_count']) {
        await expect(
          dataSource.query(`UPDATE namespace SET ${column} = -1 WHERE id = ?`, [namespace.id]),
        ).rejects.toThrow();
      }
    });

    it('rejects invalid manifest entry types and negative sizes', async () => {
      const namespace = await dataSource
        .getRepository(NamespaceEntity)
        .save({ name: 'snapshot-entry-sqlite' });
      const snapshotId = randomUUID();
      await dataSource.query(
        `INSERT INTO vfs_snapshot
        (id, namespace_id, kind, source_path, root_node_id, source_revision, root_type, node_count, logical_bytes)
        VALUES (?, ?, 'TREE', '/source', ?, 'r1.root', 'DIRECTORY', 1, 0)`,
        [snapshotId, namespace.id, randomUUID()],
      );
      const addEntry = (
        relativePath: string,
        pathKey: string,
        type = 'DIRECTORY',
        size: number | null = null,
      ) =>
        dataSource.query(
          `INSERT INTO vfs_snapshot_entry
          (id, namespace_id, snapshot_id, relative_path, path_key, type, source_node_id, source_revision, size)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'r1.entry', ?)`,
          [randomUUID(), namespace.id, snapshotId, relativePath, pathKey, type, randomUUID(), size],
        );
      await addEntry('a', '61');
      await expect(addEntry('b', '62', 'UNKNOWN')).rejects.toThrow();
      await expect(addEntry('b', '62', 'FILE', -1)).rejects.toThrow();
    });
  });

  it('VFS mutation receipt에 namespace FK와 expiry index를 생성한다', async () => {
    const columns = await dataSource.query('PRAGMA table_info(vfs_mutation_receipt)');
    expect(columns.map((column: { name: string }) => column.name)).toEqual(
      expect.arrayContaining([
        'namespace_id',
        'scope',
        'idempotency_key',
        'state',
        'generation',
        'lease_expires_at',
        'expires_at',
        'fingerprint',
        'response_status',
        'response_body',
        'response_headers',
        'request_body_bytes',
      ]),
    );
    const indexes = await dataSource.query('PRAGMA index_list(vfs_mutation_receipt)');
    expect(indexes.map((index: { name: string }) => index.name)).toEqual(
      expect.arrayContaining(['idx_vfs_mutation_receipt_lease', 'idx_vfs_mutation_receipt_expires']),
    );
    const foreignKeys = await dataSource.query('PRAGMA foreign_key_list(vfs_mutation_receipt)');
    expect(foreignKeys).toEqual(expect.arrayContaining([expect.objectContaining({ table: 'namespace' })]));
  });

  it('gc_state 테이블은 생성되지 않는다(AddGcState가 SQLite에서 no-op)', async () => {
    const tables = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='gc_state'`,
    );
    expect(tables).toHaveLength(0);
  });

  it('namespace를 생성하고 CHECK 제약이 걸린다', async () => {
    const repo = dataSource.getRepository(NamespaceEntity);
    const saved = await repo.save(repo.create({ name: 'acme' }));

    expect(saved.id).toBeDefined();
    expect(saved.encryptionPolicy).toBe('NONE');

    await expect(repo.save(repo.create({ name: 'ABC' }))).rejects.toThrow();
  });

  it('namespace 리소스 상한 CHECK가 걸린다', async () => {
    const repo = dataSource.getRepository(NamespaceEntity);

    await expect(repo.save(repo.create({ name: 'limit-test', maxSyncDeleteNodes: 0 }))).rejects.toThrow();

    const saved = await repo.save(repo.create({ name: 'limit-ok', maxSyncDeleteNodes: 5 }));
    expect(saved.maxSyncDeleteNodes).toBe(5);
  });

  it('encryption_policy를 ENCRYPTED로 저장하고 blob에 encryption_iv(blob)를 저장·조회한다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(
      namespaceRepo.create({ name: 'encrypted-ns', encryptionPolicy: 'ENCRYPTED' }),
    );

    const blobRepo = dataSource.getRepository(BlobEntity);
    const iv = Buffer.from('0123456789abcdef');
    const blob = await blobRepo.save(
      blobRepo.create({
        namespaceId: namespace.id,
        storageKey: `blobs/ab/${randomUUID()}`,
        size: '10',
        mimeType: 'application/octet-stream',
        sha256: 'a'.repeat(64),
        encryptionIv: iv,
      }),
    );

    const found = await blobRepo.findOneByOrFail({ id: blob.id });
    expect(found.encryptionIv).toEqual(iv);
    expect(found.createdAt).toBeInstanceOf(Date);
  });

  it('16바이트가 아닌 encryption_iv는 CHECK 제약 위반으로 거부된다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'bad-iv-ns' }));
    const blobRepo = dataSource.getRepository(BlobEntity);

    await expect(
      blobRepo.save(
        blobRepo.create({
          namespaceId: namespace.id,
          storageKey: `blobs/ab/${randomUUID()}`,
          size: '1',
          mimeType: 'application/octet-stream',
          sha256: 'b'.repeat(64),
          encryptionIv: Buffer.from('ab', 'hex'),
        }),
      ),
    ).rejects.toThrow();
  });

  it('idempotency_key를 jsonb 컬럼 그대로 저장·조회한다', async () => {
    const repo = dataSource.getRepository(IdempotencyKeyEntity);
    const saved = await repo.save(
      repo.create({
        key: 'sqlite-test-key',
        requestHash: 'c'.repeat(64),
        responseStatus: 201,
        responseBody: { id: 'x', nested: { ok: true } },
      }),
    );

    const found = await repo.findOneByOrFail({ key: saved.key });
    expect(found.responseBody).toEqual({ id: 'x', nested: { ok: true } });
  });

  it('audit_log를 생성하고 조회한다', async () => {
    const repo = dataSource.getRepository(AuditLogEntity);
    const saved = await repo.save(
      repo.create({ requestId: 'req-1', operation: 'FsController.ls', status: 200 }),
    );

    const found = await repo.findOneByOrFail({ id: saved.id });
    expect(found.createdAt).toBeInstanceOf(Date);
  });

  it('blob.zero_since를 백필하고 조회한다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'zero-since-ns' }));
    const blobRepo = dataSource.getRepository(BlobEntity);
    const blob = await blobRepo.save(
      blobRepo.create({
        namespaceId: namespace.id,
        storageKey: `blobs/ab/${randomUUID()}`,
        size: '1',
        mimeType: 'application/octet-stream',
        sha256: 'd'.repeat(64),
        referenceCount: 0,
      }),
    );

    // BlobEntity.zeroSince는 INSERT 시 자동으로 채워지지 않는다(migration의
    // 백필은 마이그레이션 실행 시점에 이미 존재하던 row 전용, 이후 갱신은
    // BlobRepository의 reference_count 감소 UPDATE 전용) — Postgres 통합
    // 테스트의 'zero_since를 채워 넣고 조회할 수 있다'와 동일하게 백필을
    // 명시적 UPDATE로 재현한다. sqlite에는 now()가 없어 datetime('now')를 쓴다.
    await dataSource.query(`UPDATE blob SET zero_since = datetime('now') WHERE id = '${blob.id}'`);

    const found = await blobRepo.findOneByOrFail({ id: blob.id });
    expect(found.zeroSince).toBeInstanceOf(Date);
  });
});
