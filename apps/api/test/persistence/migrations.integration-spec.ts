import { randomUUID } from 'node:crypto';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, IsNull, QueryDeepPartialEntity } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { AuditLogEntity } from '../../src/persistence/entities/audit-log.entity.js';
import { AddBlobZeroSince1788800000000 } from '../../src/persistence/migrations/1788800000000-AddBlobZeroSince.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { AddVfsSnapshotListIndex1791500000000 } from '../../src/persistence/migrations/1791500000000-AddVfsSnapshotListIndex.js';
import { AddAuditLogSnapshotId1791600000000 } from '../../src/persistence/migrations/1791600000000-AddAuditLogSnapshotId.js';
import { AddVfsChangeFeed1791700000006 } from '../../src/persistence/migrations/1791700000006-AddVfsChangeFeed.js';
import { AddFolderFileCount1791700000018 } from '../../src/persistence/migrations/1791700000018-AddFolderFileCount.js';
import { AddLiveNodeCount1791700000019 } from '../../src/persistence/migrations/1791700000019-AddLiveNodeCount.js';
import { NamespaceProvisioningRepository } from '../../src/persistence/namespace-provisioning.repository.js';
import { AddVfsTrash1791700000007 } from '../../src/persistence/migrations/1791700000007-AddVfsTrash.js';
import { AddNamespaceTrashEnabled1791700000009 } from '../../src/persistence/migrations/1791700000009-AddNamespaceTrashEnabled.js';
import { AddFileExpiry1791700000010 } from '../../src/persistence/migrations/1791700000010-AddFileExpiry.js';
import { ConvertNamespaceIdToString1791700000016 } from '../../src/persistence/migrations/1791700000016-ConvertNamespaceIdToString.js';
import { MakeNamespaceNameNullable1791700000017 } from '../../src/persistence/migrations/1791700000017-MakeNamespaceNameNullable.js';
import { WidenUploadSessionRequestId1791700000021 } from '../../src/persistence/migrations/1791700000021-WidenUploadSessionRequestId.js';

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

  // namespace_deletion 테이블을 지웠다 되살리는 아래 테스트보다 먼저 실행해야 이 인덱스가 남아 있다.
  it('삭제 완료 namespace 보존 인덱스를 만들고 down에서 제거한다', async () => {
    const runner = dataSource.createQueryRunner();
    try {
      const names = async () =>
        (await runner.getTable('namespace_deletion'))!.indices.map((index) => index.name);
      expect(await names()).toContain('idx_namespace_deletion_completed');
      const Migration = ALL_MIGRATIONS.find(
        (migration) => migration.name === 'AddNamespaceDeletionCompletedIndex1791700000015',
      )!;
      const migration = new Migration();
      await migration.down(runner);
      expect(await names()).not.toContain('idx_namespace_deletion_completed');
      await migration.up(runner);
      expect(await names()).toContain('idx_namespace_deletion_completed');
    } finally {
      await runner.release();
    }
  });

  it('namespace 삭제 테이블을 만들고 down에서 제거한다', async () => {
    const runner = dataSource.createQueryRunner();
    try {
      expect(await runner.hasTable('namespace_deletion')).toBe(true);
      expect(await runner.hasTable('namespace_deletion_receipt')).toBe(true);
      expect((await runner.getTable('namespace_deletion'))!.columns.map((column) => column.name)).toContain(
        'updated_at',
      );
      expect((await runner.getTable('namespace_deletion'))!.indices.map((index) => index.name)).toContain(
        'idx_namespace_deletion_open',
      );
      expect(
        await runner.query(
          "SELECT data_type FROM information_schema.columns WHERE table_name = 'namespace_deletion_receipt' AND column_name = 'response_body'",
        ),
      ).toEqual([{ data_type: 'jsonb' }]);

      const Migration = ALL_MIGRATIONS.find(
        (migration) => migration.name === 'AddNamespaceDeletion1791700000011',
      )!;
      const migration = new Migration();
      await migration.down(runner);
      expect(await runner.hasTable('namespace_deletion')).toBe(false);
      expect(await runner.hasTable('namespace_deletion_receipt')).toBe(false);
      await migration.up(runner);
      expect(await runner.hasTable('namespace_deletion')).toBe(true);
      expect(await runner.hasTable('namespace_deletion_receipt')).toBe(true);
    } finally {
      await runner.release();
    }
  });

  it('ENCRYPTED namespace 부분 인덱스를 만들고 down에서 제거한다', async () => {
    const runner = dataSource.createQueryRunner();
    try {
      const names = async () => (await runner.getTable('namespace'))!.indices.map((index) => index.name);
      expect(await names()).toContain('idx_namespace_encrypted');
      const Migration = ALL_MIGRATIONS.find(
        (migration) => migration.name === 'AddNamespaceEncryptedIndex1791700000013',
      )!;
      const migration = new Migration();
      await migration.down(runner);
      expect(await names()).not.toContain('idx_namespace_encrypted');
      await migration.up(runner);
      expect(await names()).toContain('idx_namespace_encrypted');
    } finally {
      await runner.release();
    }
  });

  it('idempotency_key created_at 인덱스를 만들고 down에서 제거한다', async () => {
    const runner = dataSource.createQueryRunner();
    try {
      const names = async () =>
        (await runner.getTable('idempotency_key'))!.indices.map((index) => index.name);
      expect(await names()).toContain('idx_idempotency_key_created_at');
      const Migration = ALL_MIGRATIONS.find(
        (migration) => migration.name === 'AddIdempotencyKeyCreatedAtIndex1791700000014',
      )!;
      const migration = new Migration();
      await migration.down(runner);
      expect(await names()).not.toContain('idx_idempotency_key_created_at');
      await migration.up(runner);
      expect(await names()).toContain('idx_idempotency_key_created_at');
    } finally {
      await runner.release();
    }
  });

  it('GC cursor 테이블을 만들고 down에서 제거한다', async () => {
    const runner = dataSource.createQueryRunner();
    try {
      expect(await runner.hasTable('gc_cursor')).toBe(true);
      expect((await runner.getTable('gc_cursor'))!.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(['name', 'position', 'updated_at']),
      );
      const Migration = ALL_MIGRATIONS.find((migration) => migration.name === 'AddGcCursor1791700000012')!;
      const migration = new Migration();
      await migration.down(runner);
      expect(await runner.hasTable('gc_cursor')).toBe(false);
      await migration.up(runner);
      expect(await runner.hasTable('gc_cursor')).toBe(true);
    } finally {
      await runner.release();
    }
  });

  it('기존 트리의 폴더 FILE·namespace live node counter를 backfill한다', async () => {
    const namespace = await new NamespaceProvisioningRepository(dataSource).createWithRoot(
      randomUUID(),
      `counter-backfill-${randomUUID()}`,
    );
    const root = await dataSource.getRepository(VfsNodeEntity).findOneByOrFail({
      namespaceId: namespace.id,
      parentId: IsNull(),
    });
    const folderId = randomUUID();
    const blobId = randomUUID();
    const folderMigration = new AddFolderFileCount1791700000018();
    const nodeMigration = new AddLiveNodeCount1791700000019();
    const runner = dataSource.createQueryRunner();
    try {
      await nodeMigration.down(runner);
      await folderMigration.down(runner);
      await runner.query(
        `INSERT INTO vfs_node (id, namespace_id, parent_id, type, name) VALUES ($1, $2, $3, 'DIRECTORY', 'dir')`,
        [folderId, namespace.id, root.id],
      );
      await runner.query(
        `INSERT INTO blob (id, namespace_id, storage_key, size, mime_type, sha256, reference_count)
         VALUES ($1, $2, $3, 0, 'application/octet-stream', $4, 1)`,
        [blobId, namespace.id, `backfill/${blobId}`, '0'.repeat(64)],
      );
      for (const [parentId, name] of [
        [folderId, 'in-dir'],
        [root.id, 'in-root'],
      ]) {
        await runner.query(
          `INSERT INTO vfs_node (id, namespace_id, parent_id, type, name, blob_id, size)
           VALUES ($1, $2, $3, 'FILE', $4, $5, 0)`,
          [randomUUID(), namespace.id, parentId, name, blobId],
        );
      }
      await folderMigration.up(runner);
      await nodeMigration.up(runner);
      const rows = await runner.query(
        'SELECT id, child_file_count FROM vfs_node WHERE namespace_id = $1 AND type = $2',
        [namespace.id, 'DIRECTORY'],
      );
      expect(
        Object.fromEntries(
          rows.map((row: { id: string; child_file_count: string }) => [row.id, row.child_file_count]),
        ),
      ).toEqual({
        [root.id]: '1',
        [folderId]: '1',
      });
      const [stored] = await runner.query('SELECT live_node_count FROM namespace WHERE id = $1', [
        namespace.id,
      ]);
      expect(String(stored.live_node_count)).toBe('3');
    } finally {
      await nodeMigration.up(runner).catch(() => undefined);
      await folderMigration.up(runner).catch(() => undefined);
      await runner.release();
    }
  });

  it('trash migration initializes counters, preserves existing namespaces, and reverses its own schema', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(
      namespaceRepo.create({ name: `trash-migration-${randomUUID()}` }),
    );
    const migration = new AddVfsTrash1791700000007();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      expect(await runner.query('SELECT id FROM namespace WHERE id = $1', [namespace.id])).toEqual([
        { id: namespace.id },
      ]);
      expect(
        await runner.query(
          "SELECT to_regclass('vfs_trash') AS trash, to_regclass('vfs_trash_entry') AS entry",
        ),
      ).toEqual([{ trash: null, entry: null }]);
      await migration.up(runner);
      expect(
        await runner.query(
          'SELECT retained_trash_node_count, retained_trash_byte_count FROM namespace WHERE id = $1',
          [namespace.id],
        ),
      ).toEqual([{ retained_trash_node_count: '0', retained_trash_byte_count: '0' }]);
      const columns =
        await runner.query(`SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_name IN ('vfs_trash', 'vfs_trash_entry')`);
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table_name: 'vfs_trash',
            column_name: 'node_count',
            data_type: 'bigint',
          }),
          expect.objectContaining({ table_name: 'vfs_trash', column_name: 'id', data_type: 'uuid' }),
          expect.objectContaining({
            table_name: 'vfs_trash',
            column_name: 'deleted_at',
            data_type: 'timestamp with time zone',
          }),
          expect.objectContaining({
            table_name: 'vfs_trash',
            column_name: 'expires_at',
            data_type: 'timestamp with time zone',
          }),
          expect.objectContaining({
            table_name: 'vfs_trash_entry',
            column_name: 'source_node_id',
            data_type: 'uuid',
          }),
          expect.objectContaining({
            table_name: 'vfs_trash_entry',
            column_name: 'blob_id',
            data_type: 'uuid',
          }),
        ]),
      );
      expect(
        await runner.query(`SELECT data_type FROM information_schema.columns
        WHERE table_name = 'namespace' AND column_name = 'retained_trash_node_count'`),
      ).toEqual([{ data_type: 'bigint' }]);
      await runner.query('UPDATE namespace SET retained_trash_node_count = $1 WHERE id = $2', [
        Number.MAX_SAFE_INTEGER.toString(),
        namespace.id,
      ]);
      expect(
        await runner.query('SELECT retained_trash_node_count FROM namespace WHERE id = $1', [namespace.id]),
      ).toEqual([{ retained_trash_node_count: Number.MAX_SAFE_INTEGER.toString() }]);
      const indexes = await runner.query(
        "SELECT indexname FROM pg_indexes WHERE tablename IN ('vfs_trash', 'vfs_trash_entry')",
      );
      expect(indexes.map((row: { indexname: string }) => row.indexname)).toEqual(
        expect.arrayContaining([
          'idx_vfs_trash_namespace_expiry',
          'idx_vfs_trash_namespace_list',
          'idx_vfs_trash_entry_trash_id',
        ]),
      );
      await expect(
        runner.query('UPDATE namespace SET retained_trash_node_count = -1 WHERE id = $1', [namespace.id]),
      ).rejects.toThrow();
      await expect(
        runner.query('UPDATE namespace SET retained_trash_byte_count = -1 WHERE id = $1', [namespace.id]),
      ).rejects.toThrow();
    } finally {
      await runner.release();
    }
  });

  it('namespace trash policy migration defaults existing and new namespaces to OFF and reverses its column', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(
      namespaceRepo.create({ name: `trash-policy-migration-${randomUUID()}` }),
    );
    const migration = new AddNamespaceTrashEnabled1791700000009();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      expect(
        await runner.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'namespace' AND column_name = 'trash_enabled'",
        ),
      ).toEqual([]);
      await migration.up(runner);
      expect(await runner.query('SELECT trash_enabled FROM namespace WHERE id = $1', [namespace.id])).toEqual(
        [{ trash_enabled: false }],
      );
      await runner.query('INSERT INTO namespace (id, name) VALUES ($1, $2)', [
        randomUUID(),
        `trash-policy-new-${randomUUID()}`,
      ]);
      expect(
        await runner.query('SELECT trash_enabled FROM namespace WHERE name LIKE $1', ['trash-policy-new-%']),
      ).toEqual([{ trash_enabled: false }]);
    } finally {
      await runner.release();
    }
  });

  it('파일 만료 migration은 기존 node를 NULL로 두고 부분 인덱스와 세션 컬럼을 가역적으로 만든다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(
      namespaceRepo.create({ name: `file-expiry-migration-${randomUUID()}` }),
    );
    const nodeId = randomUUID();
    const migration = new AddFileExpiry1791700000010();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      expect(
        await runner.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'vfs_node' AND column_name = 'expires_at'",
        ),
      ).toEqual([]);
      await runner.query(
        `INSERT INTO vfs_node (id, namespace_id, parent_id, type, name, blob_id, size, mime_type)
         VALUES ($1, $2, NULL, 'DIRECTORY', '', NULL, NULL, NULL)`,
        [nodeId, namespace.id],
      );
      await migration.up(runner);
      expect(await runner.query('SELECT id, expires_at FROM vfs_node WHERE id = $1', [nodeId])).toEqual([
        { id: nodeId, expires_at: null },
      ]);
      expect(
        await runner.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_vfs_node_expires_at'"),
      ).toEqual([{ indexdef: expect.stringContaining('WHERE (expires_at IS NOT NULL)') }]);
      expect(
        await runner.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'vfs_upload_session' AND column_name = 'file_expires_in_seconds'",
        ),
      ).toEqual([{ column_name: 'file_expires_in_seconds' }]);
    } finally {
      await runner.release();
    }
  });

  it('trash entries belong to their namespace and cascade when the trash item is removed', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: `trash-owner-${randomUUID()}` }));
    const other = await namespaceRepo.save(namespaceRepo.create({ name: `trash-other-${randomUUID()}` }));
    const trashId = randomUUID();
    const entryId = randomUUID();
    await dataSource.query(
      `INSERT INTO vfs_trash
      (id, namespace_id, root_type, original_path, root_node_id, root_revision, node_count, logical_bytes, expires_at)
      VALUES ($1, $2, 'DIRECTORY', '/old', $3, 'r1', 1, 0, CURRENT_TIMESTAMP + INTERVAL '30 days')`,
      [trashId, namespace.id, randomUUID()],
    );
    const addEntry = (owner: string) =>
      dataSource.query(
        `INSERT INTO vfs_trash_entry
      (id, namespace_id, trash_id, relative_path, path_key, type, source_node_id, source_revision)
      VALUES ($1, $2, $3, '', '', 'DIRECTORY', $4, 'r1')`,
        [entryId, owner, trashId, randomUUID()],
      );
    await expect(addEntry(other.id)).rejects.toThrow();
    await addEntry(namespace.id);
    await dataSource.query('DELETE FROM vfs_trash WHERE id = $1', [trashId]);
    expect(await dataSource.query('SELECT id FROM vfs_trash_entry WHERE id = $1', [entryId])).toEqual([]);
  });

  it('change feed migration down/up은 기존 VFS 노드를 보존한다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'feed-migration-pg' }));
    const node = await dataSource.getRepository(VfsNodeEntity).save({
      namespaceId: namespace.id,
      parentId: null,
      type: 'DIRECTORY',
      name: '',
    });
    const migration = new AddVfsChangeFeed1791700000006();
    const runner = dataSource.createQueryRunner();
    try {
      const columns = await runner.query(`SELECT table_name, column_name, data_type
        FROM information_schema.columns WHERE table_name IN ('vfs_change_feed_state', 'vfs_change_event')`);
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table_name: 'vfs_change_feed_state',
            column_name: 'namespace_id',
            data_type: 'character varying',
          }),
          expect.objectContaining({
            table_name: 'vfs_change_feed_state',
            column_name: 'signing_secret',
            data_type: 'character varying',
          }),
          expect.objectContaining({
            table_name: 'vfs_change_event',
            column_name: 'occurred_at',
            data_type: 'timestamp with time zone',
          }),
        ]),
      );
      await runner.query(
        'INSERT INTO vfs_change_feed_state (namespace_id, has_checkpoint, signing_secret) VALUES ($1, true, $2)',
        [namespace.id, 'a'.repeat(64)],
      );
      await runner.query(
        `INSERT INTO vfs_change_event
        (namespace_id, sequence, operation_id, operation_index, operation_count, kind, node_id, node_type, path, revision)
        VALUES ($1, 1, $2, 0, 1, 'created', $3, 'DIRECTORY', '/', 'r1')`,
        [namespace.id, node.id, node.id],
      );
      await migration.down(runner);
      expect(
        await runner.query(
          `SELECT to_regclass('vfs_change_event') AS event, to_regclass('vfs_change_feed_state') AS state`,
        ),
      ).toEqual([{ event: null, state: null }]);
      expect(await dataSource.getRepository(VfsNodeEntity).findOneBy({ id: node.id })).not.toBeNull();
      await migration.up(runner);
      const indexes = await runner.query(
        `SELECT indexname FROM pg_indexes WHERE tablename = 'vfs_change_event'`,
      );
      expect(indexes).toEqual(
        expect.arrayContaining([expect.objectContaining({ indexname: 'idx_vfs_change_event_occurred_at' })]),
      );
    } finally {
      await runner.release();
    }
  });

  it('change feed FK는 namespace 삭제 시 event와 signing secret 상태를 함께 제거한다', async () => {
    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: `feed-fk-${randomUUID()}` }));
    await dataSource.query(
      `INSERT INTO vfs_change_feed_state
      (namespace_id, last_sequence, has_checkpoint, signing_secret) VALUES ($1, 1, true, $2)`,
      [namespace.id, 'b'.repeat(64)],
    );
    await dataSource.query(
      `INSERT INTO vfs_change_event
      (namespace_id, sequence, operation_id, operation_index, operation_count,
       kind, node_id, node_type, path, revision)
      VALUES ($1, 1, $2, 0, 1, 'created', $3, 'DIRECTORY', '/', 'r1')`,
      [namespace.id, randomUUID(), randomUUID()],
    );
    await dataSource.getRepository(NamespaceEntity).delete({ id: namespace.id });
    expect(
      await dataSource.query('SELECT * FROM vfs_change_feed_state WHERE namespace_id = $1', [namespace.id]),
    ).toEqual([]);
    expect(
      await dataSource.query('SELECT * FROM vfs_change_event WHERE namespace_id = $1', [namespace.id]),
    ).toEqual([]);
  });

  it('snapshot 목록 인덱스 migration은 up/down이 가역이다', async () => {
    const migration = new AddVfsSnapshotListIndex1791500000000();
    const runner = dataSource.createQueryRunner();
    await migration.down(runner);
    const absent = await dataSource.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'vfs_snapshot'`,
    );
    expect(absent).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ indexname: 'IDX_vfs_snapshot_file_list' })]),
    );
    await migration.up(runner);
    const present = await dataSource.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'vfs_snapshot'`,
    );
    expect(present).toEqual(
      expect.arrayContaining([expect.objectContaining({ indexname: 'IDX_vfs_snapshot_file_list' })]),
    );
    await runner.release();
  });

  it('감사 snapshot_id 컬럼은 기존 행을 허용하고 nullable이며 up/down이 가역이다', async () => {
    const migration = new AddAuditLogSnapshotId1791600000000();
    const runner = dataSource.createQueryRunner();
    await dataSource.query(`INSERT INTO audit_log (request_id, operation, status)
      VALUES ('before-snapshot-id-migration', 'migration.test', 200)`);
    await migration.down(runner);
    await migration.up(runner);
    const columns: { column_name: string; is_nullable: string; data_type: string }[] =
      await dataSource.query(`SELECT column_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'audit_log' AND column_name = 'snapshot_id'`);
    expect(columns).toEqual([{ column_name: 'snapshot_id', is_nullable: 'YES', data_type: 'uuid' }]);
    const priorRows = await dataSource.query(`SELECT snapshot_id FROM audit_log
      WHERE request_id = 'before-snapshot-id-migration'`);
    expect(priorRows).toEqual([{ snapshot_id: null }]);
    await runner.release();
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
            data_type: 'character varying',
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
            data_type: 'character varying',
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
      const namespaceRepo = dataSource.getRepository(NamespaceEntity);
      const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'snapshot-limits-pg' }));
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
        expect.objectContaining({ column_name: 'namespace_id', data_type: 'character varying' }),
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
      expect(saved.maxSyncMoveNodes).toBeNull();
    });

    it('값을 채워 넣고 조회할 수 있다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);
      const saved = await repo.save(
        repo.create({
          name: 'limits-set-owner',
          maxFileSizeBytes: '1000',
          maxSyncDeleteNodes: 5,
          maxSyncCopyNodes: 5,
          maxSyncMoveNodes: 5,
        }),
      );

      const found = await repo.findOneByOrFail({ id: saved.id });

      expect(found.maxFileSizeBytes).toBe('1000');
      expect(found.maxSyncDeleteNodes).toBe(5);
      expect(found.maxSyncCopyNodes).toBe(5);
      expect(found.maxSyncMoveNodes).toBe(5);
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

    it('동기 이동 노드 상한이 0이면 CHECK 제약 위반으로 거부된다', async () => {
      const repo = dataSource.getRepository(NamespaceEntity);

      await expect(
        repo.save(repo.create({ name: 'limits-invalid-move-nodes', maxSyncMoveNodes: 0 })),
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

  it('기존 namespace ID와 참조를 보존하고 비 UUID ID가 있으면 down을 거부한다', async () => {
    const runner = dataSource.createQueryRunner();
    const migration = new ConvertNamespaceIdToString1791700000016();
    try {
      const before = await runner.query('SELECT count(*)::text AS count FROM namespace');
      await migration.up(runner);

      const types = await runner.query(`
        SELECT table_name, data_type, collation_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'namespace' AND column_name = 'id')
            OR (table_name = 'vfs_node' AND column_name = 'namespace_id')
            OR (table_name = 'audit_log' AND column_name = 'namespace_id'))
        ORDER BY table_name
      `);
      expect(types).toEqual([
        { table_name: 'audit_log', data_type: 'character varying', collation_name: 'C' },
        { table_name: 'namespace', data_type: 'character varying', collation_name: 'C' },
        { table_name: 'vfs_node', data_type: 'character varying', collation_name: 'C' },
      ]);
      expect(await runner.query('SELECT count(*)::text AS count FROM namespace')).toEqual(before);
      expect(
        await runner.query(`SELECT count(*)::text AS count FROM pg_constraint
          WHERE contype = 'f' AND conrelid = 'vfs_node'::regclass`),
      ).toEqual([{ count: '3' }]);
      expect(
        await runner.query(`SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname IN ('UQ_vfs_node_child_name', 'IDX_blob_namespace_id') ORDER BY indexname`),
      ).toEqual([{ indexname: 'IDX_blob_namespace_id' }, { indexname: 'UQ_vfs_node_child_name' }]);
      expect(
        await runner.query(`SELECT character_maximum_length FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'vfs_upload_usage' AND column_name = 'id'`),
      ).toEqual([{ character_maximum_length: 64 }]);

      const prefixedId = `tenant_${'a'.repeat(32)}`;
      await runner.query('INSERT INTO namespace (id, name) VALUES ($1, $2)', [
        prefixedId,
        'migration-prefix-test',
      ]);
      await expect(migration.down(runner)).rejects.toThrow(
        'namespace ID를 UUID로 변환할 수 없어 migration down을 거부합니다',
      );
      await runner.query('DELETE FROM namespace WHERE id = $1', [prefixedId]);
      await runner.query(
        `INSERT INTO audit_log (request_id, namespace_id, operation, status)
         VALUES ('migration-non-uuid-reference', $1, 'migration.test', 200)`,
        [prefixedId],
      );
      await expect(migration.down(runner)).rejects.toThrow(
        'namespace 참조 값을 UUID로 변환할 수 없어 migration down을 거부합니다',
      );
      await runner.query('DELETE FROM audit_log WHERE request_id = $1', ['migration-non-uuid-reference']);

      await migration.down(runner);
      await migration.up(runner);
      expect(await runner.query('SELECT count(*)::text AS count FROM namespace')).toEqual(before);
    } finally {
      await runner.release();
    }
  });

  it('이름 없는 행이 있으면 down을 거부하고 제거한 뒤 가역 migration을 수행한다', async () => {
    const runner = dataSource.createQueryRunner();
    const migration = new MakeNamespaceNameNullable1791700000017();
    const id = randomUUID();
    try {
      await runner.query('INSERT INTO namespace (id, name) VALUES ($1, NULL)', [id]);
      await expect(migration.down(runner)).rejects.toThrow(
        '이름 없는 namespace가 있어 migration down을 거부합니다',
      );
      await runner.query('DELETE FROM namespace WHERE id = $1', [id]);
      await migration.down(runner);
      await migration.up(runner);
      const columns = await runner.query(`SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'namespace' AND column_name = 'name'`);
      expect(columns).toEqual([{ is_nullable: 'YES' }]);
    } finally {
      await runner.release();
    }
  });

  it('업로드 세션 request_id 컬럼을 200자로 넓히고, 129자 이상 값이 있으면 down을 거부한다', async () => {
    const runner = dataSource.createQueryRunner();
    const migration = new WidenUploadSessionRequestId1791700000021();
    const namespaceId = randomUUID();
    const sessionId = randomUUID();
    const lengths = async () =>
      runner.query(`SELECT column_name, character_maximum_length FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'vfs_upload_session'
          AND column_name IN ('request_id', 'creation_request_id') ORDER BY column_name`);
    try {
      expect(await lengths()).toEqual([
        { column_name: 'creation_request_id', character_maximum_length: 200 },
        { column_name: 'request_id', character_maximum_length: 200 },
      ]);

      await runner.query('INSERT INTO namespace (id, name) VALUES ($1, $2)', [
        namespaceId,
        'widen-request-id',
      ]);
      await runner.query(
        `INSERT INTO vfs_upload_session (id, namespace_id, scope, creation_key, fingerprint, target_path,
           size_bytes, mime_type, condition_type, part_size_bytes, part_count, state, expires_at,
           max_expires_at, request_id, creation_request_id, created_at, updated_at)
         VALUES ($1, $2, 's', $3, 'f', '/a', 0, 'text/plain', 'ABSENT', 1, 0, 'OPEN', now(), now(), $4, $4, now(), now())`,
        [sessionId, namespaceId, randomUUID(), 'r'.repeat(200)],
      );

      await expect(migration.down(runner)).rejects.toMatchObject({ code: '22001' });
      expect(await lengths()).toEqual([
        { column_name: 'creation_request_id', character_maximum_length: 200 },
        { column_name: 'request_id', character_maximum_length: 200 },
      ]);

      await runner.query('DELETE FROM vfs_upload_session WHERE id = $1', [sessionId]);
      await runner.query('DELETE FROM namespace WHERE id = $1', [namespaceId]);
      await migration.down(runner);
      expect(await lengths()).toEqual([
        { column_name: 'creation_request_id', character_maximum_length: 128 },
        { column_name: 'request_id', character_maximum_length: 128 },
      ]);
      await migration.up(runner);
      expect(await lengths()).toEqual([
        { column_name: 'creation_request_id', character_maximum_length: 200 },
        { column_name: 'request_id', character_maximum_length: 200 },
      ]);
    } finally {
      await runner.release();
    }
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
