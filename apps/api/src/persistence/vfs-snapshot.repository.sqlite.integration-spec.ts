import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { BlobRepository } from './blob.repository.js';
import { BlobEntity } from './entities/blob.entity.js';
import { NamespaceEntity } from './entities/namespace.entity.js';
import { VfsNodeEntity } from './entities/vfs-node.entity.js';
import { VfsSnapshotEntity } from './entities/vfs-snapshot.entity.js';
import { VfsSnapshotEntryEntity } from './entities/vfs-snapshot-entry.entity.js';
import { ALL_MIGRATIONS } from './migrations/all-migrations.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import { VfsSnapshotRepository } from './vfs-snapshot.repository.js';
import { runSnapshotRepositoryTests } from './vfs-snapshot.repository.shared-tests.js';

describe.each(['memory', 'file'])('VfsSnapshotRepository (SQLite %s)', (storage) => {
  let dataSource: DataSource;
  let nodes: VfsNodeRepository;
  let snapshots: VfsSnapshotRepository;

  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'storix-snapshot-repo-'));
    if (process.env.STORIX_DB_DRIVER !== 'sqlite') throw new Error('STORIX_DB_DRIVER=sqlite required');
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: storage === 'memory' ? ':memory:' : join(directory, 'snapshot.sqlite'),
      migrationsTransactionMode: 'each',
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, VfsSnapshotEntity, VfsSnapshotEntryEntity],
      migrations: ALL_MIGRATIONS,
      synchronize: false,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    const blobs = new BlobRepository(dataSource);
    nodes = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      blobs,
    );
    snapshots = new VfsSnapshotRepository(dataSource, blobs);
  }, 120000);
  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  runSnapshotRepositoryTests(() => ({ dataSource, nodes, snapshots }));
  if (storage === 'file') {
    it('preserves immutable manifests, usage and pins across connection restart', async () => {
      const beforeSnapshots = await dataSource
        .getRepository(VfsSnapshotEntity)
        .find({ order: { id: 'ASC' } });
      const beforeEntries = await dataSource
        .getRepository(VfsSnapshotEntryEntity)
        .find({ order: { id: 'ASC' } });
      const beforeNamespaces = await dataSource.getRepository(NamespaceEntity).find({ order: { id: 'ASC' } });
      const beforeBlobs = await dataSource.getRepository(BlobEntity).find({ order: { id: 'ASC' } });
      expect(beforeSnapshots.length).toBeGreaterThan(0);
      await dataSource.destroy();
      await dataSource.initialize();
      expect(await dataSource.getRepository(VfsSnapshotEntity).find({ order: { id: 'ASC' } })).toEqual(
        beforeSnapshots,
      );
      expect(await dataSource.getRepository(VfsSnapshotEntryEntity).find({ order: { id: 'ASC' } })).toEqual(
        beforeEntries,
      );
      expect(await dataSource.getRepository(NamespaceEntity).find({ order: { id: 'ASC' } })).toEqual(
        beforeNamespaces,
      );
      expect(await dataSource.getRepository(BlobEntity).find({ order: { id: 'ASC' } })).toEqual(beforeBlobs);
    });
  }
});
