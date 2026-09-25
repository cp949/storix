import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';
import { AddNamespaceLogicalQuota1791400000000 } from './migrations/1791400000000-AddNamespaceLogicalQuota.js';

describe('namespace logical quota migration (SQLite)', () => {
  it('backfills live FILE bytes and initializes namespace quota settings', async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
      throw new Error('STORIX_DB_DRIVER=sqlite is required for this migration spec');
    }

    const quotaMigration = ALL_MIGRATIONS.find(
      (Migration) => Migration === AddNamespaceLogicalQuota1791400000000,
    );
    expect(quotaMigration).toBeDefined();
    if (!quotaMigration) return;

    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS.filter((Migration) => Migration !== quotaMigration),
    });

    await dataSource.initialize();
    try {
      await dataSource.runMigrations();

      const namespaceId = randomUUID();
      const rootId = randomUUID();
      const fileId = randomUUID();
      const blobId = randomUUID();
      await dataSource.query('INSERT INTO namespace (id, name) VALUES (?, ?)', [namespaceId, 'quota-backfill']);
      await dataSource.query(
        `INSERT INTO blob (id, namespace_id, storage_key, size, mime_type, sha256, reference_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [blobId, namespaceId, `blobs/${blobId}`, '17', 'application/octet-stream', 'a'.repeat(64), 1],
      );
      await dataSource.query(
        `INSERT INTO vfs_node (id, namespace_id, parent_id, type, name)
         VALUES (?, ?, NULL, 'DIRECTORY', '')`,
        [rootId, namespaceId],
      );
      await dataSource.query(
        `INSERT INTO vfs_node (id, namespace_id, parent_id, type, name, blob_id, size, mime_type)
         VALUES (?, ?, ?, 'FILE', ?, ?, ?, ?)`,
        [fileId, namespaceId, rootId, 'file.bin', blobId, '17', 'application/octet-stream'],
      );

      const migration = new quotaMigration();
      const queryRunner = dataSource.createQueryRunner();
      try {
        await migration.up(queryRunner);
      } finally {
        await queryRunner.release();
      }

      const [namespace] = await dataSource.query(
        `SELECT live_file_byte_count, max_total_logical_bytes
         FROM namespace WHERE id = ?`,
        [namespaceId],
      );
      expect(namespace).toEqual({ live_file_byte_count: 17, max_total_logical_bytes: null });

      const rollbackRunner = dataSource.createQueryRunner();
      try {
        await migration.down(rollbackRunner);
      } finally {
        await rollbackRunner.release();
      }
      const columns = (await dataSource.query('PRAGMA table_info(namespace)')) as { name: string }[];
      expect(columns.map(({ name }) => name)).not.toEqual(
        expect.arrayContaining(['live_file_byte_count', 'max_total_logical_bytes']),
      );
    } finally {
      await dataSource.destroy();
    }
  });
});
