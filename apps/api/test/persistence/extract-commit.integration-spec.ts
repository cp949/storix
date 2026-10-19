// 실제 PostgreSQL과 migration으로 applyExtract 공용 시나리오를 실행한다.
// 행 잠금 아래의 overwrite·clean 커밋, 카운터, 롤백을 확인한다. 시나리오 본문은 extract-commit.shared-tests.ts다.
import { ConfigService } from '@nestjs/config';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { BlobRepository } from '../../src/persistence/blob.repository.js';
import { ALL_ENTITIES } from '../../src/persistence/entities/all-entities.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { runExtractCommitSharedTests } from './extract-commit.shared-tests.js';

describe('applyExtract (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;
  let repository: VfsNodeRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: ALL_ENTITIES,
      migrations: ALL_MIGRATIONS,
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
    repository = new VfsNodeRepository(
      dataSource.getRepository(NamespaceEntity),
      dataSource.getRepository(VfsNodeEntity),
      dataSource.getRepository(BlobEntity),
      dataSource,
      new BlobRepository(dataSource),
      new ConfigService(),
    );
  }, 120000);

  afterAll(async () => {
    await dataSource?.destroy();
    await container?.stop();
  });

  runExtractCommitSharedTests(() => ({ dataSource, repository }));
});
