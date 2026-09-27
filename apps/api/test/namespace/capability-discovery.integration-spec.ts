import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module.js';
import { CapabilityService } from '../../src/capability/capability.service.js';
import type { CapabilityDefinition } from '../../src/capability/capability-registry.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { IdempotencyKeyEntity } from '../../src/persistence/entities/idempotency-key.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';

const API_KEY = 'capability-discovery-integration-key';
const CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    id: 'zed-feature',
    scope: 'namespace',
    defaultEnabled: false,
    precedence: 'global-ceiling-then-namespace-opt-in',
    dependencies: ['alpha-feature'],
    disabledBehavior: 'VFS_FEATURE_DISABLED',
    dataHandling: 'preserve-query-export-recover-delete',
    discoveryVisibility: 'effective-state',
  },
  {
    id: 'alpha-feature',
    scope: 'namespace',
    defaultEnabled: false,
    precedence: 'global-ceiling-then-namespace-opt-in',
    dependencies: [],
    disabledBehavior: 'VFS_FEATURE_DISABLED',
    dataHandling: 'preserve-query-export-recover-delete',
    discoveryVisibility: 'effective-state',
  },
];

describe('Capability discovery HTTP contract (PostgreSQL)', () => {
  let container: StartedPostgreSqlContainer;
  let migrationDataSource: DataSource;
  let app: INestApplication;
  let namespaceId: string;
  let otherNamespaceId: string;
  const previousEnv = { ...process.env };

  async function bootstrap(capabilityService?: CapabilityService): Promise<INestApplication> {
    const builder = Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule, NamespaceModule],
    });
    if (capabilityService) builder.overrideProvider(CapabilityService).useValue(capabilityService);
    const moduleRef = await builder.compile();
    const next = moduleRef.createNestApplication();
    await next.init();
    return next;
  }

  async function createNamespace(name: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', `capability-discovery-${name}`)
      .send({ name })
      .expect(201);
    return response.body.id as string;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    process.env.STORIX_DB_HOST = container.getHost();
    process.env.STORIX_DB_PORT = String(container.getPort());
    process.env.STORIX_DB_USERNAME = container.getUsername();
    process.env.STORIX_DB_PASSWORD = container.getPassword();
    process.env.STORIX_DB_NAME = container.getDatabase();
    process.env.STORIX_ENCRYPTION_MASTER_KEY = 'a'.repeat(64);
    process.env.STORIX_API_KEY = API_KEY;
    delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;

    migrationDataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      entities: [NamespaceEntity, VfsNodeEntity, BlobEntity, IdempotencyKeyEntity],
      migrations: ALL_MIGRATIONS,
    });
    await migrationDataSource.initialize();
    await migrationDataSource.runMigrations();
    app = await bootstrap();
    namespaceId = await createNamespace('capability-discovery-active');
    otherNamespaceId = await createNamespace('capability-discovery-other');
  }, 120000);

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      try {
        if (migrationDataSource?.isInitialized) await migrationDataSource.destroy();
      } finally {
        await container.stop();
        for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
        Object.assign(process.env, previousEnv);
      }
    }
  });

  it('서비스 key 누락과 잘못된 key를 namespace 조회보다 먼저 거부한다', async () => {
    const path = '/api/v2/namespaces/not-a-uuid/capabilities';
    await request(app.getHttpServer()).get(path).expect(401);
    const invalid = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', 'Bearer wrong-key')
      .expect(401);
    expect(invalid.body.code).toBe('UNAUTHORIZED');
  });

  it('ACTIVE namespace는 등록된 선택 기능이 기본 비활성일 때 빈 배열과 no-store를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${namespaceId}/capabilities`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .expect(200);
    expect(response.body).toEqual({ capabilities: [] });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('production registry의 두 기능이 전역·namespace 허용 시에만 조회된다', async () => {
    await app.close();
    app = await bootstrap(
      new CapabilityService({
        globalAllowedCapabilities: ['resumable-upload', 'change-feed'],
        namespaceAllowedCapabilities: { [namespaceId]: ['resumable-upload', 'change-feed'] },
      }),
    );
    const enabled = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${namespaceId}/capabilities`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .expect(200);
    expect(enabled.body).toEqual({ capabilities: ['change-feed', 'resumable-upload'] });
    const other = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${otherNamespaceId}/capabilities`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .expect(200);
    expect(other.body).toEqual({ capabilities: [] });
  });

  it.each([
    ['잘못된 UUID', 'not-a-uuid'],
    ['없는 namespace', '11111111-1111-4111-8111-111111111111'],
  ])('%s는 NAMESPACE_NOT_FOUND를 반환한다', async (_label, id) => {
    const response = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${id}/capabilities`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .expect(404);
    expect(response.body.code).toBe('NAMESPACE_NOT_FOUND');
  });

  it.each(['DELETING', 'DELETED'] as const)(
    '%s namespace는 capability 조회에서 숨기고 기존 단건 조회 정책은 유지한다',
    async (status) => {
      await migrationDataSource.query('UPDATE namespace SET status = $1 WHERE id = $2', [
        status,
        namespaceId,
      ]);
      try {
        const hidden = await request(app.getHttpServer())
          .get(`/api/v2/namespaces/${namespaceId}/capabilities`)
          .set('Authorization', `Bearer ${API_KEY}`)
          .expect(404);
        expect(hidden.body.code).toBe('NAMESPACE_NOT_FOUND');
        const existing = await request(app.getHttpServer())
          .get(`/api/v2/namespaces/${namespaceId}`)
          .set('Authorization', `Bearer ${API_KEY}`)
          .expect(200);
        expect(existing.body.status).toBe(status);
      } finally {
        // 실패해도 이후 양성 사례가 같은 namespace를 쓰므로 상태를 되돌린다
        await migrationDataSource.query('UPDATE namespace SET status = $1 WHERE id = $2', [
          'ACTIVE',
          namespaceId,
        ]);
      }
    },
  );

  it('test registry의 전역·namespace 허용 기능과 활성 의존성을 정렬해 반환한다', async () => {
    await app.close();
    const testService = new CapabilityService(
      {
        globalAllowedCapabilities: ['alpha-feature', 'zed-feature'],
        namespaceAllowedCapabilities: { [namespaceId]: ['alpha-feature', 'zed-feature'] },
      },
      CAPABILITIES,
    );
    app = await bootstrap(testService);

    const enabled = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${namespaceId}/capabilities`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .expect(200);
    expect(enabled.body).toEqual({ capabilities: ['alpha-feature', 'zed-feature'] });
    const other = await request(app.getHttpServer())
      .get(`/api/v2/namespaces/${otherNamespaceId}/capabilities`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .expect(200);
    expect(other.body).toEqual({ capabilities: [] });
  });
});
