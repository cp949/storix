import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { AuditLogRepository } from '../../src/persistence/audit-log.repository.js';
import { AuditLogEntity } from '../../src/persistence/entities/audit-log.entity.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';

describe('AuditLogRepository', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: AuditLogRepository;
  let namespaceId: string;

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
    repository = new AuditLogRepository(dataSource);

    const namespaceRepo = dataSource.getRepository(NamespaceEntity);
    const namespace = await namespaceRepo.save(namespaceRepo.create({ name: 'audit-repo-owner' }));
    namespaceId = namespace.id;
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  it('필수 필드와 선택 필드를 모두 채워 저장한다', async () => {
    await repository.record({
      requestId: 'req-record-full',
      namespaceId,
      snapshotId: null,
      operation: 'FsController.mv',
      path: '/a.txt',
      detail: { source: '/a.txt', destination: '/b.txt' },
      caller: 'billing-service',
      status: 200,
    });

    const rows = await dataSource.getRepository(AuditLogEntity).find({ where: { requestId: 'req-record-full' } });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      namespaceId,
      operation: 'FsController.mv',
      path: '/a.txt',
      detail: { source: '/a.txt', destination: '/b.txt' },
      caller: 'billing-service',
      status: 200,
    });
  });

  it('선택 필드가 없으면 NULL로 저장한다', async () => {
    await repository.record({
      requestId: 'req-record-minimal',
      namespaceId: null,
      snapshotId: null,
      operation: 'NamespaceController.findAll',
      path: null,
      detail: null,
      caller: null,
      status: 200,
    });

    const rows = await dataSource
      .getRepository(AuditLogEntity)
      .find({ where: { requestId: 'req-record-minimal' } });

    expect(rows).toHaveLength(1);
    expect(rows[0].namespaceId).toBeNull();
    expect(rows[0].path).toBeNull();
    expect(rows[0].detail).toBeNull();
    expect(rows[0].caller).toBeNull();
  });

  it('snapshot ID와 null을 선택 필드로 저장한다', async () => {
    const snapshotId = '0195f6a0-7c1b-7d3e-8a4f-1234567890ab';
    await repository.record({
      requestId: 'req-record-snapshot', namespaceId, operation: 'SnapshotController.get',
      path: null, detail: null, caller: null, status: 200, snapshotId,
    });
    await repository.record({
      requestId: 'req-record-no-snapshot', namespaceId, operation: 'NamespaceController.findAll',
      path: null, detail: null, caller: null, status: 200, snapshotId: null,
    });
    const rows = await dataSource.getRepository(AuditLogEntity).findBy([
      { requestId: 'req-record-snapshot' }, { requestId: 'req-record-no-snapshot' },
    ]);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'req-record-snapshot', snapshotId }),
      expect.objectContaining({ requestId: 'req-record-no-snapshot', snapshotId: null }),
    ]));
  });

  it('trash ID를 저장하고 NULL 기본값을 유지한다', async () => {
    const trashId = '0195f6a0-7c1b-7d3e-8a4f-1234567890ab';
    await repository.record({ requestId: 'req-trash', namespaceId, snapshotId: null, trashId,
      operation: 'VfsTrashController.restore', path: null, detail: null, caller: null, status: 200 });
    await repository.record({ requestId: 'req-no-trash', namespaceId, snapshotId: null,
      operation: 'VfsTrashController.list', path: null, detail: null, caller: null, status: 200 });
    const rows = await dataSource.getRepository(AuditLogEntity).findBy([
      { requestId: 'req-trash' }, { requestId: 'req-no-trash' },
    ]);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: 'req-trash', trashId }),
      expect.objectContaining({ requestId: 'req-no-trash', trashId: null }),
    ]));
  });
});
