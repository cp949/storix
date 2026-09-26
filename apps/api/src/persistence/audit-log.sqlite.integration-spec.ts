import { DataSource } from 'typeorm';
import { AuditLogRepository } from './audit-log.repository.js';
import { AuditLogEntity } from './entities/audit-log.entity.js';
import { BlobEntity } from './entities/blob.entity.js';
import { IdempotencyKeyEntity } from './entities/idempotency-key.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';

describe('AuditLogRepository (SQLite)', () => {
  let dataSource: DataSource;
  let repository: AuditLogRepository;

  beforeAll(async () => {
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('STORIX_DB_DRIVER=sqlite가 필요합니다');
    dataSource = new DataSource({
      type: 'better-sqlite3', database: ':memory:', synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity, AuditLogEntity],
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    repository = new AuditLogRepository(dataSource);
  });

  afterAll(async () => { await dataSource.destroy(); });

  it('snapshot ID와 null을 저장하고 읽는다', async () => {
    const snapshotId = '0195f6a0-7c1b-7d3e-8a4f-1234567890ab';
    await repository.record({ requestId: 'sqlite-snapshot', namespaceId: null, snapshotId,
      operation: 'GET /snapshots/id', path: '/snapshots/id', detail: null, caller: null, status: 200 });
    await repository.record({ requestId: 'sqlite-no-snapshot', namespaceId: null, snapshotId: null,
      operation: 'GET /snapshots', path: '/snapshots', detail: null, caller: null, status: 200 });
    const rows = await dataSource.getRepository(AuditLogEntity).find();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'sqlite-snapshot', snapshotId }),
      expect.objectContaining({ requestId: 'sqlite-no-snapshot', snapshotId: null }),
    ]));
  });
});
