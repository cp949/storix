import { createHash, randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { startS3Container, StartedS3Container } from '../storage/s3-container.test-support.js';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestBucket, createTestS3Client } from '../storage/s3-client.test-support.js';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthModule } from '../../src/auth/auth.module.js';
import { CapabilityService } from '../../src/capability/capability.service.js';
import { configureBodyParsers } from '../../src/common/body-parser.js';
import { NamespaceModule } from '../../src/namespace/namespace.module.js';
import { GcJobModule } from '../../src/jobs/gc-job.module.js';
import { GcJob } from '../../src/jobs/gc.job.js';
import { ALL_MIGRATIONS } from '../../src/persistence/migrations/all-migrations.js';
import { VfsUploadUsageEntity } from '../../src/persistence/entities/vfs-upload-usage.entity.js';
import { VfsUploadSessionEntity } from '../../src/persistence/entities/vfs-upload-session.entity.js';
import { VfsUploadPartEntity } from '../../src/persistence/entities/vfs-upload-part.entity.js';
import { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { BLOB_STORAGE } from '../../src/storage/storage.constants.js';
import { UPLOAD_SESSION_POLICY, type UploadSessionPolicy } from '../../src/vfs/upload-session-config.js';
import { VfsModule } from '../../src/vfs/vfs.module.js';

const API_KEY = 'upload-parts-integration-key';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

describe('upload parts (PostgreSQL + S3)', () => {
  const previous = { ...process.env };
  let postgres: StartedPostgreSqlContainer;
  let s3Container: StartedS3Container;
  let migrations: DataSource;
  let app: INestApplication;
  let second: INestApplication;
  let namespaceId: string;
  let encryptedId: string;
  let raceNamespaceId: string;
  let failureNamespaceId: string;
  // X-Content-Sha256 테스트 전용. 앞선 테스트가 남긴 staged 사용량의 영향을 받지 않는다.
  let shaId: string;
  let shaEncryptedId: string;
  // uploadSessions 조회 테스트 전용: override 있음 / 전역 정책 사용 / capability 비활성.
  let viewOverrideId: string;
  let viewGlobalId: string;
  let viewDisabledId: string;
  let admissionGlobalId: string;
  let admissionOverrideId: string;
  let admissionFullId: string;
  let admissionHighPolicyApp: INestApplication;
  let admissionGlobalLowPolicyApp: INestApplication;

  function policy(): UploadSessionPolicy {
    return {
      global: {
        maxStagedBytes: 8n,
        maxActiveSessions: 8,
        partSizeBytes: 4,
        inactivitySeconds: 60,
        maxLifetimeSeconds: 120,
      },
      namespaces: {
        [namespaceId]: { maxStagedBytes: 8n, maxActiveSessions: 8 },
        [encryptedId]: { maxStagedBytes: 8n, maxActiveSessions: 8 },
        [raceNamespaceId]: { maxStagedBytes: 8n, maxActiveSessions: 8 },
        [failureNamespaceId]: { maxStagedBytes: 8n, maxActiveSessions: 8 },
        [shaId]: { maxStagedBytes: 8n, maxActiveSessions: 8 },
        [shaEncryptedId]: { maxStagedBytes: 8n, maxActiveSessions: 8 },
        [viewOverrideId]: { maxStagedBytes: 6n, maxActiveSessions: 3, partSizeBytes: 2 },
        [admissionOverrideId]: { maxStagedBytes: 6n, maxActiveSessions: 8 },
        [admissionFullId]: { maxStagedBytes: 8n, maxActiveSessions: 8 },
      },
    };
  }

  async function bootstrap(
    enabled: boolean,
    namespaceCaps: Record<string, bigint> = {},
    globalMaxStagedBytes?: bigint,
  ) {
    const builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        AuthModule,
        NamespaceModule,
        VfsModule,
        GcJobModule,
      ],
    });
    if (enabled) {
      builder.overrideProvider(CapabilityService).useValue(
        new CapabilityService({
          globalAllowedCapabilities: ['resumable-upload'],
          namespaceAllowedCapabilities: {
            [namespaceId]: ['resumable-upload'],
            [encryptedId]: ['resumable-upload'],
            [raceNamespaceId]: ['resumable-upload'],
            [failureNamespaceId]: ['resumable-upload'],
            [shaId]: ['resumable-upload'],
            [shaEncryptedId]: ['resumable-upload'],
            [viewOverrideId]: ['resumable-upload'],
            [viewGlobalId]: ['resumable-upload'],
            [admissionGlobalId]: ['resumable-upload'],
            [admissionOverrideId]: ['resumable-upload'],
            [admissionFullId]: ['resumable-upload'],
          },
        }),
      );
      const originalPolicy = policy();
      const basePolicy: UploadSessionPolicy =
        globalMaxStagedBytes === undefined
          ? originalPolicy
          : {
              ...originalPolicy,
              global: { ...originalPolicy.global, maxStagedBytes: globalMaxStagedBytes },
              namespaces: Object.fromEntries(
                Object.entries(originalPolicy.namespaces).map(([id, limits]) => [
                  id,
                  {
                    ...limits,
                    maxStagedBytes:
                      limits.maxStagedBytes < globalMaxStagedBytes
                        ? limits.maxStagedBytes
                        : globalMaxStagedBytes,
                  },
                ]),
              ),
            };
      const namespaces: Record<string, UploadSessionPolicy['namespaces'][string]> = {
        ...basePolicy.namespaces,
      };
      for (const [id, maxStagedBytes] of Object.entries(namespaceCaps)) {
        namespaces[id] = {
          ...(namespaces[id] ?? {
            maxActiveSessions: basePolicy.global.maxActiveSessions,
          }),
          maxStagedBytes,
        };
      }
      const uploadPolicy: UploadSessionPolicy = { ...basePolicy, namespaces };
      builder.overrideProvider(UPLOAD_SESSION_POLICY).useValue(uploadPolicy);
    }
    const moduleRef = await builder.compile();
    const next = moduleRef.createNestApplication({ bodyParser: false });
    configureBodyParsers(next);
    await next.init();
    return next;
  }

  function http(target = app) {
    return request(target.getHttpServer());
  }
  function base(ns = namespaceId) {
    return `/api/v2/namespaces/${ns}/fs/upload-sessions`;
  }
  async function create(path: string, size: string, ns = namespaceId) {
    const response = await http()
      .post(base(ns))
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('X-Mutation-Scope', 'parts')
      .set('Idempotency-Key', randomUUID())
      .send({ path, sizeBytes: size, mimeType: 'application/octet-stream', ifAbsent: true })
      .expect(201);
    return response.body.sessionId as string;
  }
  function put(id: string, index: number, body: string, target = app, ns = namespaceId) {
    return http(target)
      .put(`${base(ns)}/${id}/parts/${index}`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(body));
  }
  async function clear(id: string, ns: string, indices: number[]) {
    const repo = app.get(VfsUploadSessionRepository);
    expect(await repo.claimTerminalTransition(ns, id, 'CANCELLED', new Date())).toBe(true);
    for (const index of indices) {
      const part = await repo.findPart(id, index);
      if (!part || part.state !== 'STORED') continue;
      await app.get<BlobStorage>(BLOB_STORAGE).delete(part.stagingKey);
      expect(await repo.markStagingObjectDeleted(id, index, part.stagingKey, part.state)).toBe(true);
    }
  }

  beforeAll(async () => {
    [postgres, s3Container] = await Promise.all([
      new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start(),
      startS3Container(),
    ]);
    Object.assign(process.env, {
      STORIX_DB_HOST: postgres.getHost(),
      STORIX_DB_PORT: String(postgres.getPort()),
      STORIX_DB_USERNAME: postgres.getUsername(),
      STORIX_DB_PASSWORD: postgres.getPassword(),
      STORIX_DB_NAME: postgres.getDatabase(),
      STORIX_STORAGE_ENDPOINT: s3Container.getHost(),
      STORIX_STORAGE_PORT: String(s3Container.getPort()),
      STORIX_STORAGE_USE_SSL: 'false',
      STORIX_STORAGE_ACCESS_KEY: s3Container.getUsername(),
      STORIX_STORAGE_SECRET_KEY: s3Container.getPassword(),
      STORIX_STORAGE_BUCKET: 'storix-upload-parts',
      STORIX_ENCRYPTION_MASTER_KEY: 'a'.repeat(64),
      STORIX_API_KEY: API_KEY,
    });
    delete process.env.STORIX_VFS_CAPABILITIES_CONFIG_PATH;
    delete process.env.STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH;
    const client = createTestS3Client(s3Container);
    await createTestBucket(client, 'storix-upload-parts');
    migrations = new DataSource({
      type: 'postgres',
      url: postgres.getConnectionUri(),
      entities: [VfsUploadSessionEntity],
      migrations: ALL_MIGRATIONS,
    });
    await migrations.initialize();
    await migrations.runMigrations();
    app = await bootstrap(false);
    const plain = await http()
      .post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'upload-parts' })
      .expect(201);
    const encrypted = await http()
      .post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'upload-parts-encrypted', encryptionPolicy: 'ENCRYPTED' })
      .expect(201);
    const race = await http()
      .post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'upload-parts-race' })
      .expect(201);
    const failure = await http()
      .post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'upload-parts-failure' })
      .expect(201);
    const shaPlain = await http()
      .post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'upload-parts-sha' })
      .expect(201);
    const shaEncrypted = await http()
      .post('/api/v2/namespaces')
      .set('Authorization', `Bearer ${API_KEY}`)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'upload-parts-sha-encrypted', encryptionPolicy: 'ENCRYPTED' })
      .expect(201);
    const names = [
      'upload-parts-view-override',
      'upload-parts-view-global',
      'upload-parts-view-disabled',
      'upload-parts-admission-global',
      'upload-parts-admission-override',
      'upload-parts-admission-full',
    ];
    const viewIds: string[] = [];
    for (const name of names) {
      const created = await http()
        .post('/api/v2/namespaces')
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('Idempotency-Key', randomUUID())
        .send({ name })
        .expect(201);
      expect(created.body).not.toHaveProperty('uploadSessions');
      viewIds.push(created.body.id as string);
    }
    [viewOverrideId, viewGlobalId, viewDisabledId] = viewIds;
    [admissionGlobalId, admissionOverrideId, admissionFullId] = viewIds.slice(3);
    shaId = shaPlain.body.id as string;
    shaEncryptedId = shaEncrypted.body.id as string;
    namespaceId = plain.body.id as string;
    encryptedId = encrypted.body.id as string;
    raceNamespaceId = race.body.id as string;
    failureNamespaceId = failure.body.id as string;
    await app.close();
    app = await bootstrap(true);
    second = await bootstrap(true);
    admissionHighPolicyApp = await bootstrap(true, { [admissionOverrideId]: 8n });
    admissionGlobalLowPolicyApp = await bootstrap(true, {}, 4n);
  }, 180000);

  afterAll(async () => {
    if (second) await second.close();
    if (admissionHighPolicyApp) await admissionHighPolicyApp.close();
    if (admissionGlobalLowPolicyApp) await admissionGlobalLowPolicyApp.close();
    if (app) await app.close();
    if (migrations?.isInitialized) await migrations.destroy();
    await Promise.all([postgres?.stop(), s3Container?.stop()]);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });

  // 전역 staged 한도(8바이트)를 쓰므로 앞선 테스트가 남기는 사용량이 없도록 첫 테스트보다 앞에 둔다.

  // 실제 HTTP와 PostgreSQL 상태를 대조해 크기 초과 거절의 무변경·재생·공간 미예약을 고정한다.
  describe('세션 생성 staging 파일 크기 admission', () => {
    /** admission 요청 뒤 실제 세션·creation key·global/namespace usage 값을 읽는다. */
    async function snapshot(ns: string, key: string, target = app) {
      const dataSource = target.get(DataSource);
      const usage = dataSource.getRepository(VfsUploadUsageEntity);
      const [global, namespace] = await Promise.all([
        usage.findOneBy({ id: 'global' }),
        usage.findOneBy({ id: `ns:${ns}` }),
      ]);
      return {
        sessionCount: await dataSource.getRepository(VfsUploadSessionEntity).countBy({ namespaceId: ns }),
        keySessionId:
          (await target.get(VfsUploadSessionRepository).findByCreationKey(ns, 'admission', key))?.id ?? null,
        global: {
          activeSessions: String(global?.activeSessions ?? '0'),
          stagedBytes: String(global?.stagedBytes ?? '0'),
        },
        namespace: {
          activeSessions: String(namespace?.activeSessions ?? '0'),
          stagedBytes: String(namespace?.stagedBytes ?? '0'),
        },
      };
    }

    /** 같은 mutation scope로 지정한 서버의 세션 생성 정책을 호출한다. */
    function postCreate(ns: string, key: string, path: string, size: string, target = app) {
      return http(target)
        .post(base(ns))
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'admission')
        .set('Idempotency-Key', key)
        .send({ path, sizeBytes: size, mimeType: 'application/octet-stream', ifAbsent: true });
    }

    it('전역 한도에서 0·7·8바이트를 허용하고 9바이트는 상태 변경 없이 거절한다', async () => {
      const createdIds: string[] = [];
      for (const size of ['0', '7', '8']) {
        const key = randomUUID();
        const response = await postCreate(
          admissionGlobalId,
          key,
          `/admission-global-${size}.bin`,
          size,
        ).expect(201);
        createdIds.push(response.body.sessionId as string);
      }
      const key = randomUUID();
      const before = await snapshot(admissionGlobalId, key);
      const rejected = await postCreate(admissionGlobalId, key, '/admission-global-9.bin', '9').expect(413);
      expect(rejected.body).toMatchObject({
        code: 'VFS_UPLOAD_STAGING_FILE_TOO_LARGE',
        message: '파일 크기(9 bytes)가 staging 상한(8 bytes)을 초과함',
        requestId: expect.any(String),
      });
      expect(rejected.headers).not.toHaveProperty('retry-after');
      expect(await snapshot(admissionGlobalId, key)).toEqual(before);
      for (const id of createdIds) await clear(id, admissionGlobalId, []);
    });

    it('namespace override는 더 작은 6바이트 한도를 적용하고 override가 없으면 전역 한도를 쓴다', async () => {
      const six = await postCreate(
        admissionOverrideId,
        randomUUID(),
        '/admission-override-6.bin',
        '6',
      ).expect(201);
      const rejectedKey = randomUUID();
      const before = await snapshot(admissionOverrideId, rejectedKey);
      const rejected = await postCreate(
        admissionOverrideId,
        rejectedKey,
        '/admission-override-7.bin',
        '7',
      ).expect(413);
      expect(rejected.body.code).toBe('VFS_UPLOAD_STAGING_FILE_TOO_LARGE');
      expect(rejected.body.message).toBe('파일 크기(7 bytes)가 staging 상한(6 bytes)을 초과함');
      expect(rejected.headers).not.toHaveProperty('retry-after');
      expect(await snapshot(admissionOverrideId, rejectedKey)).toEqual(before);
      await clear(six.body.sessionId as string, admissionOverrideId, []);
    });

    it('정책 상향 재기동 뒤 거절된 key를 같은 요청으로 생성한다', async () => {
      const key = randomUUID();
      const before = await snapshot(admissionOverrideId, key);
      await postCreate(admissionOverrideId, key, '/admission-policy-raised.bin', '7').expect(413);
      expect(await snapshot(admissionOverrideId, key)).toEqual(before);
      const created = await postCreate(
        admissionOverrideId,
        key,
        '/admission-policy-raised.bin',
        '7',
        admissionHighPolicyApp,
      ).expect(201);
      await clear(created.body.sessionId as string, admissionOverrideId, []);
    });

    it('정책 하향 재기동 뒤 기존 요청은 재생하고 새 key의 같은 크기는 거절한다', async () => {
      const key = randomUUID();
      const original = await postCreate(
        admissionOverrideId,
        key,
        '/admission-policy-lowered.bin',
        '8',
        admissionHighPolicyApp,
      ).expect(201);
      const replay = await postCreate(admissionOverrideId, key, '/admission-policy-lowered.bin', '8').expect(
        201,
      );
      expect(replay.body.sessionId).toBe(original.body.sessionId);
      const rejectedKey = randomUUID();
      const before = await snapshot(admissionOverrideId, rejectedKey);
      const rejected = await postCreate(
        admissionOverrideId,
        rejectedKey,
        '/admission-policy-lowered-new.bin',
        '8',
      ).expect(413);
      expect(rejected.body.code).toBe('VFS_UPLOAD_STAGING_FILE_TOO_LARGE');
      expect(await snapshot(admissionOverrideId, rejectedKey)).toEqual(before);
      await clear(original.body.sessionId as string, admissionOverrideId, []);
    });

    it('기존 세션은 하향 정책에서 새 예약을 거부하고 정책 복원 뒤 이어서 저장한다', async () => {
      const id = (
        await postCreate(
          admissionOverrideId,
          randomUUID(),
          '/admission-existing-session.bin',
          '8',
          admissionHighPolicyApp,
        ).expect(201)
      ).body.sessionId as string;
      try {
        await put(id, 0, 'abcd', admissionHighPolicyApp, admissionOverrideId).expect(200);
        const status = await http()
          .get(`${base(admissionOverrideId)}/${id}`)
          .set('Authorization', `Bearer ${API_KEY}`)
          .expect(200);
        expect(status.body.staging).toEqual({ maxStagedBytes: '6', status: 'FILE_TOO_LARGE' });
        await put(id, 0, 'abcd', app, admissionOverrideId).expect(200);
        const beforeReject = await app
          .get(DataSource)
          .getRepository(VfsUploadSessionEntity)
          .findOneByOrFail({ id });
        const rejected = await put(id, 1, 'efgh', app, admissionOverrideId).expect(413);
        expect(rejected.body.code).toBe('VFS_UPLOAD_STAGING_FILE_TOO_LARGE');
        const after = await app.get(DataSource).getRepository(VfsUploadSessionEntity).findOneByOrFail({ id });
        expect(after.state).toBe(beforeReject.state);
        expect(after.expiresAt).toEqual(beforeReject.expiresAt);
        await put(id, 1, 'efgh', admissionHighPolicyApp, admissionOverrideId).expect(200);
        const storedStatus = await http()
          .get(`${base(admissionOverrideId)}/${id}`)
          .set('Authorization', `Bearer ${API_KEY}`)
          .expect(200);
        expect(storedStatus.body.staging.status).toBe('PARTS_STORED');
      } finally {
        const current = await app.get(DataSource).getRepository(VfsUploadSessionEntity).findOneBy({ id });
        if (current?.state === 'OPEN') await clear(id, admissionOverrideId, [0, 1]);
      }
    });

    it('전역 한도 하향은 namespace override가 커도 사용량이 0인 기존 세션을 거부한다', async () => {
      const id = await create('/admission-global-lowered.bin', '8', admissionGlobalId);
      const key = randomUUID();
      const before = await snapshot(admissionGlobalId, key);
      expect(before.global.stagedBytes).toBe('0');
      try {
        const status = await http(admissionGlobalLowPolicyApp)
          .get(`${base(admissionGlobalId)}/${id}`)
          .set('Authorization', `Bearer ${API_KEY}`)
          .expect(200);
        expect(status.body.staging).toEqual({ maxStagedBytes: '4', status: 'FILE_TOO_LARGE' });
        const rejected = await put(id, 0, 'abcd', admissionGlobalLowPolicyApp, admissionGlobalId).expect(413);
        expect(rejected.body.code).toBe('VFS_UPLOAD_STAGING_FILE_TOO_LARGE');
        expect(await snapshot(admissionGlobalId, key)).toEqual(before);
        await put(id, 0, 'abcd', app, admissionGlobalId).expect(200);
        await put(id, 1, 'efgh', app, admissionGlobalId).expect(200);
      } finally {
        const current = await app.get(DataSource).getRepository(VfsUploadSessionEntity).findOneBy({ id });
        if (current?.state === 'OPEN') await clear(id, admissionGlobalId, [0, 1]);
      }
    });

    it('파일 크기는 한도 이하여도 기존 사용량 초과는 사용량 오류로 유지한다', async () => {
      const occupied = await create('/admission-usage-5.bin', '5', admissionFullId);
      const next = await create('/admission-usage-next-4.bin', '6', admissionFullId);
      try {
        await put(occupied, 0, 'abcd', app, admissionFullId).expect(200);
        await put(occupied, 1, 'e', app, admissionFullId).expect(200);
        const before = await app
          .get(DataSource)
          .getRepository(VfsUploadUsageEntity)
          .findOneByOrFail({ id: `ns:${admissionFullId}` });
        expect(String(before.stagedBytes)).toBe('5');
        const rejected = await put(next, 0, 'wxyz', app, admissionFullId).expect(413);
        expect(rejected.body.code).toBe('VFS_UPLOAD_STAGING_LIMIT_EXCEEDED');
        expect(rejected.body.code).not.toBe('VFS_UPLOAD_STAGING_FILE_TOO_LARGE');
      } finally {
        await clear(occupied, admissionFullId, [0, 1]);
        await clear(next, admissionFullId, []);
      }
    });

    it('staging 사용량이 가득 차도 새 세션 생성은 공간을 예약하지 않는다', async () => {
      const full = await postCreate(admissionFullId, randomUUID(), '/admission-full.bin', '8').expect(201);
      try {
        await put(full.body.sessionId as string, 0, 'abcd', app, admissionFullId).expect(200);
        await put(full.body.sessionId as string, 1, 'efgh', app, admissionFullId).expect(200);
        const before = await snapshot(admissionFullId, randomUUID());
        expect(before.global.stagedBytes).toBe('8');
        expect(before.namespace.stagedBytes).toBe('8');
        const created = await postCreate(
          admissionFullId,
          randomUUID(),
          '/admission-full-small.bin',
          '1',
        ).expect(201);
        const after = await snapshot(admissionFullId, randomUUID());
        expect(BigInt(after.global.activeSessions)).toBe(BigInt(before.global.activeSessions) + 1n);
        expect(BigInt(after.namespace.activeSessions)).toBe(BigInt(before.namespace.activeSessions) + 1n);
        expect(after.global.stagedBytes).toBe(before.global.stagedBytes);
        expect(after.namespace.stagedBytes).toBe(before.namespace.stagedBytes);
        await clear(created.body.sessionId as string, admissionFullId, []);
      } finally {
        await clear(full.body.sessionId as string, admissionFullId, [0, 1]);
      }
    });
  });

  describe('조각 X-Content-Sha256', () => {
    /** 조각 본문과 SHA-256 헤더를 함께 전송한다. */
    function putWithSha(id: string, index: number, body: string, header: string, ns = shaId) {
      return put(id, index, body, app, ns).set('X-Content-Sha256', header);
    }
    /** DB에 반영된 namespace staging 사용량을 읽는다. */
    async function stagedBytes(ns: string) {
      const usage = await app
        .get(DataSource)
        .getRepository(VfsUploadUsageEntity)
        .findOneByOrFail({ namespaceId: ns });
      return BigInt(usage.stagedBytes);
    }

    it('헤더가 다르면 422로 거부하고 staging 객체·예약량을 해제한 뒤 같은 index를 올바른 내용으로 재전송할 수 있다', async () => {
      const id = await create('/part-sha-mismatch.bin', '4', shaId);
      const storage = app.get<BlobStorage>(BLOB_STORAGE);
      const putSpy = jest.spyOn(storage, 'put');
      const before = await stagedBytes(shaId);
      try {
        const rejected = await putWithSha(id, 0, 'abcd', sha('wxyz')).expect(422);
        expect(rejected.body.code).toBe('VFS_PART_CHECKSUM_MISMATCH');
        const stagingKey = putSpy.mock.calls[0][0];
        await expect(storage.get(stagingKey)).rejects.toBeDefined();
        expect(await app.get(VfsUploadSessionRepository).findPart(id, 0)).toBeNull();
        expect(await stagedBytes(shaId)).toBe(before);
        const stored = await putWithSha(id, 0, 'abcd', sha('abcd')).expect(200);
        expect(stored.body).toMatchObject({ index: 0, sha256: sha('abcd'), replayed: false });
      } finally {
        putSpy.mockRestore();
        await clear(id, shaId, [0]);
      }
    });

    it('헤더 형식이 틀리면 본문을 저장하지 않고 400이다', async () => {
      const id = await create('/part-sha-format.bin', '4', shaId);
      try {
        const rejected = await putWithSha(id, 0, 'abcd', sha('abcd').toUpperCase()).expect(400);
        expect(rejected.body.code).toBe('VFS_INVALID_CHECKSUM');
        expect(await app.get(VfsUploadSessionRepository).findPart(id, 0)).toBeNull();
      } finally {
        await clear(id, shaId, [0]);
      }
    });

    it('재생 경로는 헤더 불일치 422, 조각 불일치 409, 모두 일치 재생 순서로 판정한다', async () => {
      const id = await create('/part-sha-replay.bin', '4', shaId);
      try {
        await putWithSha(id, 0, 'abcd', sha('abcd')).expect(200);
        const mismatch = await putWithSha(id, 0, 'abcd', sha('wxyz')).expect(422);
        expect(mismatch.body.code).toBe('VFS_PART_CHECKSUM_MISMATCH');
        const conflict = await putWithSha(id, 0, 'wxyz', sha('wxyz')).expect(409);
        expect(conflict.body.code).toBe('VFS_UPLOAD_PART_CONFLICT');
        const both = await putWithSha(id, 0, 'wxyz', sha('abcd')).expect(422);
        expect(both.body.code).toBe('VFS_PART_CHECKSUM_MISMATCH');
        expect((await putWithSha(id, 0, 'abcd', sha('abcd')).expect(200)).body.replayed).toBe(true);
      } finally {
        await clear(id, shaId, [0]);
      }
    });

    it('암호화 namespace는 평문 해시로 비교한다', async () => {
      const id = await create('/part-sha-encrypted.bin', '4', shaEncryptedId);
      try {
        await putWithSha(id, 0, 'data', sha('wxyz'), shaEncryptedId).expect(422);
        const stored = await putWithSha(id, 0, 'data', sha('data'), shaEncryptedId).expect(200);
        expect(stored.body.sha256).toBe(sha('data'));
      } finally {
        await clear(id, shaEncryptedId, [0]);
      }
    });
  });

  // GET namespaces/{id}의 uploadSessions 블록. 전역 staged 한도를 쓰는 PUT이 있으므로 앞선 테스트의 잔여 사용량이 없도록 앞에 둔다.
  // 각 전용 namespace의 정책과 사용량을 HTTP 응답으로 검증한다.
  describe('namespace 조회의 uploadSessions', () => {
    /** 전역 서비스 key로 namespace 단건 조회를 요청한다. */
    function getNamespace(ns: string) {
      return http().get(`/api/v2/namespaces/${ns}`).set('Authorization', `Bearer ${API_KEY}`).expect(200);
    }

    it('namespace override가 없으면 전역 정책과 현재 사용량을 돌려주고 조각 업로드 뒤 사용량이 반영된다', async () => {
      const empty = await getNamespace(viewGlobalId);
      expect(empty.body.uploadSessions).toEqual({
        partSizeBytes: 4,
        inactivitySeconds: 60,
        maxLifetimeSeconds: 120,
        maxStagedBytes: '8',
        maxActiveSessions: 8,
        stagedBytes: '0',
        activeSessions: 0,
      });
      const id = await create('/view-usage.bin', '4', viewGlobalId);
      try {
        expect((await getNamespace(viewGlobalId)).body.uploadSessions).toMatchObject({
          stagedBytes: '0',
          activeSessions: 1,
        });
        await put(id, 0, 'abcd', app, viewGlobalId).expect(200);
        expect((await getNamespace(viewGlobalId)).body.uploadSessions).toMatchObject({
          stagedBytes: '4',
          activeSessions: 1,
        });
      } finally {
        await clear(id, viewGlobalId, [0]);
      }
      expect((await getNamespace(viewGlobalId)).body.uploadSessions).toMatchObject({
        stagedBytes: '0',
        activeSessions: 0,
      });
    });

    it('namespace override가 있으면 조각 크기와 한도가 그 값이고 새 세션의 조각 크기와 같다', async () => {
      const { uploadSessions } = (await getNamespace(viewOverrideId)).body;
      expect(uploadSessions).toMatchObject({
        partSizeBytes: 2,
        maxStagedBytes: '6',
        maxActiveSessions: 3,
        inactivitySeconds: 60,
        maxLifetimeSeconds: 120,
      });
      const created = await http()
        .post(base(viewOverrideId))
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'parts')
        .set('Idempotency-Key', randomUUID())
        .send({
          path: '/view-part-size.bin',
          sizeBytes: '4',
          mimeType: 'application/octet-stream',
          ifAbsent: true,
        })
        .expect(201);
      expect(created.body.partSizeBytes).toBe(uploadSessions.partSizeBytes);
      await clear(created.body.sessionId, viewOverrideId, []);
    });

    it('resumable-upload가 비활성인 namespace는 uploadSessions를 생략한다', async () => {
      const response = await getNamespace(viewDisabledId);
      expect(response.body).not.toHaveProperty('uploadSessions');
    });

    it('목록 조회의 항목에는 uploadSessions가 없다', async () => {
      const list = await http()
        .get('/api/v2/namespaces')
        .set('Authorization', `Bearer ${API_KEY}`)
        .expect(200);
      for (const item of list.body as object[]) expect(item).not.toHaveProperty('uploadSessions');
    });
  });

  it('does not renew an expired session after waiting for its PostgreSQL row lock', async () => {
    const id = await create('/renew-lock-expiry.bin', '4', raceNamespaceId);
    const sessionRows = migrations.getRepository(VfsUploadSessionEntity);
    const lockedUntil = new Date(Date.now() + 300);
    await sessionRows.update({ id }, { expiresAt: lockedUntil, maxExpiresAt: lockedUntil });
    const lockHeld = migrations.transaction(async (manager) => {
      await manager
        .getRepository(VfsUploadSessionEntity)
        .createQueryBuilder('session')
        .setLock('pessimistic_write')
        .where('session.id = :id', { id })
        .getOneOrFail();
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const renewal = app.get(VfsUploadSessionRepository).renewSession(raceNamespaceId, id, new Date(), 60);
    await lockHeld;
    expect(await renewal).toBeNull();
  });

  it('조각 저장·재전송 응답의 expiresAt은 DB 만료와 같고 최대 수명을 넘지 않으며 복구 조회는 저장 확정 조각만 돌려준다', async () => {
    const id = await create('/part-expiry.bin', '6');
    const rows = app.get(DataSource).getRepository(VfsUploadSessionEntity);
    const repo = app.get(VfsUploadSessionRepository);
    const first = await put(id, 0, 'abcd').expect(200);
    expect(first.body.expiresAt).toBe((await rows.findOneByOrFail({ id })).expiresAt.toISOString());
    const replay = await put(id, 0, 'abcd').expect(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.expiresAt).toBe((await rows.findOneByOrFail({ id })).expiresAt.toISOString());

    const stored = (await repo.findPart(id, 0))!;
    const recovered = await repo.findStoredPartWithExpiry(id, 0, stored.stagingKey);
    expect(recovered?.part.digest).toBe(sha('abcd'));
    expect(recovered?.expiresAt).toEqual((await rows.findOneByOrFail({ id })).expiresAt);
    expect(await repo.findStoredPartWithExpiry(id, 0, 'upload-staging/other')).toBeNull();
    expect(await repo.findStoredPartWithExpiry(id, 1, stored.stagingKey)).toBeNull();

    // 최대 수명에 가까운 PUT은 최대 수명으로 제한된 값을 응답한다.
    const maxExpiresAt = new Date(Date.now() + 5000);
    await rows.update({ id }, { expiresAt: new Date(Date.now() + 2000), maxExpiresAt });
    const near = await put(id, 1, 'xy').expect(200);
    expect(near.body.expiresAt).toBe(maxExpiresAt.toISOString());

    // 만료된 세션의 PUT은 기존처럼 거부한다.
    await rows.update({ id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await put(id, 0, 'abcd').expect(409)).body.code).toBe('VFS_UPLOAD_SESSION_CLOSED');
    await clear(id, namespaceId, [0, 1]);
  });

  // 실제 commit 뒤 ACK만 잃게 한다. 다른 앱의 PUT가 갱신한 만료와 기존 staging 보존을 함께 검증한다.
  it('commit ACK 유실 뒤 다른 조각이 갱신한 만료로 PUT를 복구하고 저장 조각과 과금을 보존한다', async () => {
    const id = await create('/part-ack-lost.bin', '6');
    const repo = app.get(VfsUploadSessionRepository);
    const rows = app.get(DataSource).getRepository(VfsUploadSessionEntity);
    const storage = app.get<BlobStorage>(BLOB_STORAGE);
    const commit = repo.commitPart.bind(repo);
    let committedExpiry!: Date;
    let observedExpiry!: string;
    const recovery = jest.spyOn(repo, 'findStoredPartWithExpiry');
    const deletion = jest.spyOn(storage, 'delete');
    const ackLoss = jest.spyOn(repo, 'commitPart').mockImplementationOnce(async (...args) => {
      // 첫 갱신만 30초로 제한해 다른 PUT의 60초 갱신값과 구분한다. 실제 commit 트랜잭션은 실행한다.
      args[5] = 30;
      const committed = await commit(...args);
      if (!committed) throw new Error('first part commit missing');
      committedExpiry = committed.expiresAt;
      const other = await put(id, 1, 'xy', second).expect(200);
      observedExpiry = other.body.expiresAt as string;
      throw new Error('commit acknowledgement lost');
    });
    try {
      const recovered = await put(id, 0, 'abcd').expect(200);
      expect(recovered.body).toEqual({
        index: 0,
        sizeBytes: '4',
        sha256: sha('abcd'),
        replayed: false,
        expiresAt: observedExpiry,
      });
      const session = await rows.findOneByOrFail({ id });
      expect(Date.parse(observedExpiry)).toBeGreaterThan(committedExpiry.getTime());
      expect(recovered.body.expiresAt).toBe(session.expiresAt.toISOString());
      expect(Date.parse(observedExpiry)).toBeLessThanOrEqual(session.maxExpiresAt.getTime());
      const part = await repo.findPart(id, 0);
      expect(part).toMatchObject({ state: 'STORED', digest: sha('abcd') });
      expect(recovery).toHaveBeenCalledWith(id, 0, part!.stagingKey);
      expect(deletion).not.toHaveBeenCalled();
      const chunks: Buffer[] = [];
      for await (const chunk of await storage.get(part!.stagingKey)) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(Buffer.from('abcd'));
      const usage = await app
        .get(DataSource)
        .getRepository(VfsUploadUsageEntity)
        .findOneByOrFail({ namespaceId });
      expect(BigInt(usage.stagedBytes)).toBe(6n);
    } finally {
      ackLoss.mockRestore();
      recovery.mockRestore();
      deletion.mockRestore();
      await clear(id, namespaceId, [0, 1]);
    }
  });

  it('streams exact parts, replays plaintext identity, and keeps staging hidden', async () => {
    const id = await create('/parts.bin', '6');
    const maxExpiresAt = new Date(Date.now() + 30_000);
    const sessionRows = app.get(DataSource).getRepository(VfsUploadSessionEntity);
    await sessionRows.update({ id }, { expiresAt: new Date(Date.now() + 5000), maxExpiresAt });
    const [firstPart, finalPart] = await Promise.all([put(id, 0, 'abcd'), put(id, 1, 'xy')]);
    expect(firstPart.status).toBe(200);
    expect(finalPart.status).toBe(200);
    expect(firstPart.body).toMatchObject({ index: 0, sizeBytes: '4', sha256: sha('abcd'), replayed: false });
    expect(finalPart.body).toMatchObject({ index: 1, sizeBytes: '2', sha256: sha('xy') });
    expect((await sessionRows.findOneByOrFail({ id })).expiresAt).toEqual(maxExpiresAt);
    expect((await put(id, 0, 'abcd').expect(200)).body.replayed).toBe(true);
    expect((await sessionRows.findOneByOrFail({ id })).expiresAt).toEqual(maxExpiresAt);
    expect((await put(id, 0, 'wxyz').expect(409)).body.code).toBe('VFS_UPLOAD_PART_CONFLICT');
    const status = await http().get(`${base()}/${id}`).set('Authorization', `Bearer ${API_KEY}`).expect(200);
    expect(status.body.parts).toEqual([
      { index: 0, sizeBytes: '4' },
      { index: 1, sizeBytes: '2' },
    ]);
    await http()
      .get(`/api/v2/namespaces/${namespaceId}/fs/stat`)
      .set('Authorization', `Bearer ${API_KEY}`)
      .query({ path: '/parts.bin' })
      .expect(404);
    expect((await app.get(VfsUploadSessionRepository).findPart(id, 0))?.stagingKey).toMatch(
      /^upload-staging\/[0-9a-f-]{36}$/,
    );
    await clear(id, namespaceId, [0, 1]);
  });

  it('한도 축소 뒤에도 기존 예약 worker와 사용량을 유지하고 같은 snapshot으로 진단한다', async () => {
    const id = (
      await http(admissionHighPolicyApp)
        .post(base(admissionOverrideId))
        .set('Authorization', `Bearer ${API_KEY}`)
        .set('X-Mutation-Scope', 'parts')
        .set('Idempotency-Key', randomUUID())
        .send({
          path: '/diagnosis-progress-lowered.bin',
          sizeBytes: '8',
          mimeType: 'application/octet-stream',
          ifAbsent: true,
        })
        .expect(201)
    ).body.sessionId as string;
    await put(id, 0, 'abcd', admissionHighPolicyApp, admissionOverrideId).expect(200);
    const storage = admissionHighPolicyApp.get<BlobStorage>(BLOB_STORAGE);
    const originalPut = storage.put.bind(storage);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const spy = jest
      .spyOn(storage, 'put')
      .mockImplementationOnce(async (key, stream, type) => {
        entered();
        await released;
        await originalPut(key, stream, type);
      })
      .mockImplementation(originalPut);
    let pending: Promise<{ status: number }> | undefined;
    try {
      pending = put(id, 1, 'efgh', admissionHighPolicyApp, admissionOverrideId).then((response) => response);
      await started;
      const repo = app.get(VfsUploadSessionRepository);
      const reserved = await repo.findPart(id, 1);
      expect(reserved?.state).toBe('RESERVED');
      const usage = await app
        .get(DataSource)
        .getRepository(VfsUploadUsageEntity)
        .findOneByOrFail({ id: `ns:${admissionOverrideId}` });
      expect(String(usage.stagedBytes)).toBe('8');
      const inProgress = await http()
        .get(`${base(admissionOverrideId)}/${id}`)
        .set('Authorization', `Bearer ${API_KEY}`)
        .expect(200);
      expect(inProgress.body.staging).toEqual({ maxStagedBytes: '6', status: 'PARTS_IN_PROGRESS' });
      expect(inProgress.body.parts).toEqual([{ index: 0, sizeBytes: '4' }]);
      const retry = await put(id, 1, 'efgh', app, admissionOverrideId).expect(409);
      expect(retry.body.code).toBe('VFS_UPLOAD_PART_IN_PROGRESS');
      expect(await repo.findPart(id, 1)).toEqual(reserved);
      const afterRetry = await app
        .get(DataSource)
        .getRepository(VfsUploadUsageEntity)
        .findOneByOrFail({ id: `ns:${admissionOverrideId}` });
      expect(String(afterRetry.stagedBytes)).toBe('8');
      resume();
      expect((await pending).status).toBe(200);
      const stored = await http()
        .get(`${base(admissionOverrideId)}/${id}`)
        .set('Authorization', `Bearer ${API_KEY}`)
        .expect(200);
      expect(stored.body.staging).toEqual({ maxStagedBytes: '6', status: 'PARTS_STORED' });
      expect(stored.body.parts).toEqual([
        { index: 0, sizeBytes: '4' },
        { index: 1, sizeBytes: '4' },
      ]);
      expect((await repo.findPart(id, 1))?.stagingKey).toBe(reserved?.stagingKey);
      const afterStored = await app
        .get(DataSource)
        .getRepository(VfsUploadUsageEntity)
        .findOneByOrFail({ id: `ns:${admissionOverrideId}` });
      expect(String(afterStored.stagedBytes)).toBe('8');
    } finally {
      resume();
      await pending;
      spy.mockRestore();
      await clear(id, admissionOverrideId, [0, 1]);
    }
  });

  it('enforces one shared byte cap across app instances and preserves the accepted same-index object', async () => {
    const first = await create('/race-a.bin', '4', raceNamespaceId);
    const secondId = await create('/race-b.bin', '4', raceNamespaceId);
    const third = await create('/race-c.bin', '4', raceNamespaceId);
    const results = await Promise.all([
      put(first, 0, 'aaaa', app, raceNamespaceId),
      put(secondId, 0, 'bbbb', second, raceNamespaceId),
      put(third, 0, 'cccc', app, raceNamespaceId),
    ]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(2);
    expect(results.filter((result) => result.status === 413)).toHaveLength(1);
    const rejected = results.findIndex((result) => result.status === 413);
    const rejectedId = [first, secondId, third][rejected];
    expect((await put(rejectedId, 0, 'dddd', app, raceNamespaceId)).status).toBe(413);
    const accepted = [first, secondId, third][results.findIndex((result) => result.status === 200)];
    expect((await put(accepted, 0, 'zzzz', second, raceNamespaceId)).status).toBe(409);
    for (let index = 0; index < results.length; index++) {
      await clear([first, secondId, third][index], raceNamespaceId, [0]);
    }

    const globalIds = [
      await create('/global-a.bin', '4', namespaceId),
      await create('/global-b.bin', '4', raceNamespaceId),
      await create('/global-c.bin', '4', encryptedId),
    ];
    const globalResults = await Promise.all([
      put(globalIds[0], 0, 'aaaa', app, namespaceId),
      put(globalIds[1], 0, 'bbbb', second, raceNamespaceId),
      put(globalIds[2], 0, 'cccc', app, encryptedId),
    ]);
    expect(globalResults.filter((result) => result.status === 200)).toHaveLength(2);
    expect(globalResults.filter((result) => result.status === 413)).toHaveLength(1);
    for (let index = 0; index < globalIds.length; index++) {
      await clear(globalIds[index], [namespaceId, raceNamespaceId, encryptedId][index], [0]);
    }

    const sameIndex = await create('/same-index.bin', '4', raceNamespaceId);
    const sameResults = await Promise.all([
      put(sameIndex, 0, 'left', app, raceNamespaceId),
      put(sameIndex, 0, 'rite', second, raceNamespaceId),
    ]);
    expect(sameResults.map((result) => result.status).sort()).toEqual([200, 409]);
    const acceptedResponse = sameResults.find((result) => result.status === 200)!;
    expect((await app.get(VfsUploadSessionRepository).findPart(sameIndex, 0))?.digest).toBe(
      acceptedResponse.body.sha256,
    );
    await clear(sameIndex, raceNamespaceId, [0]);
  });

  it('refuses a new reservation after the inactivity expiry', async () => {
    const id = await create('/expired-at-reserve.bin', '4', raceNamespaceId);
    const sessions = app.get(DataSource).getRepository(VfsUploadSessionEntity);
    await sessions.update({ id }, { expiresAt: new Date(Date.now() - 1000) });
    const result = await app
      .get(VfsUploadSessionRepository)
      .reservePart(id, 0, '4', `upload-staging/${randomUUID()}`, {
        global: policy().global,
        namespace: policy().namespaces[raceNamespaceId],
      });
    expect(result.kind).toBe('closed');
    expect(await app.get(VfsUploadSessionRepository).findPart(id, 0)).toBeNull();
  });

  it('rejects a part expiring during storage write and releases its staged quota', async () => {
    const id = await create('/expired-during-put.bin', '4', raceNamespaceId);
    const storage = app.get<BlobStorage>(BLOB_STORAGE);
    const originalPut = storage.put.bind(storage);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const spy = jest
      .spyOn(storage, 'put')
      .mockImplementationOnce(async (key, stream, type) => {
        entered();
        await released;
        await originalPut(key, stream, type);
      })
      .mockImplementation(originalPut);
    try {
      const pending = put(id, 0, 'data', app, raceNamespaceId).then((response) => response);
      await started;
      await app
        .get(DataSource)
        .getRepository(VfsUploadSessionEntity)
        .update({ id }, { expiresAt: new Date(Date.now() - 1000) });
      resume();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('VFS_UPLOAD_SESSION_CLOSED');
      expect(await app.get(VfsUploadSessionRepository).findPart(id, 0)).toBeNull();
      const usage = app.get(DataSource).getRepository(VfsUploadUsageEntity);
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('0');
    } finally {
      resume();
      spy.mockRestore();
    }
  });

  it('keeps a late PUT charged after GC retires its expired reservation', async () => {
    const id = await create('/gc-late-put.bin', '4', raceNamespaceId);
    const storage = app.get<BlobStorage>(BLOB_STORAGE);
    const repo = app.get(VfsUploadSessionRepository);
    const usage = app.get(DataSource).getRepository(VfsUploadUsageEntity);
    const originalPut = storage.put.bind(storage);
    const originalDelete = storage.delete.bind(storage);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const putSpy = jest
      .spyOn(storage, 'put')
      .mockImplementationOnce(async (key, stream, type) => {
        entered();
        await released;
        await originalPut(key, stream, type);
      })
      .mockImplementation(originalPut);
    let deleteSpy: ReturnType<typeof jest.spyOn> | undefined;
    try {
      const pending = put(id, 0, 'data', app, raceNamespaceId).then((response) => response);
      await started;
      const reserved = await repo.findPart(id, 0);
      expect(reserved?.state).toBe('RESERVED');
      await app
        .get(DataSource)
        .getRepository(VfsUploadSessionEntity)
        .update({ id }, { expiresAt: new Date(Date.now() - 1000) });
      await app
        .get(DataSource)
        .getRepository(VfsUploadPartEntity)
        .update({ sessionId: id, partIndex: 0 }, { leaseExpiresAt: new Date(Date.now() - 1000) });
      const gcResult = await app.get(GcJob).run();
      expect(gcResult.deletedStagingObjects).toBeGreaterThanOrEqual(1);
      expect(await repo.findPart(id, 0)).toBeNull();
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('4');
      deleteSpy = jest
        .spyOn(storage, 'delete')
        .mockImplementationOnce(async () => {
          throw new Error('cleanup unavailable');
        })
        .mockImplementation(originalDelete);
      resume();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await repo.findPart(id, 0)).toBeNull();
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('4');
      expect(await repo.releasePartReservation(id, 0, true, `upload-staging/${randomUUID()}`)).toBe(false);
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('4');
      deleteSpy.mockRestore();
      deleteSpy = undefined;
      const retried = await app.get(GcJob).run();
      expect(retried.deletedStagingObjects).toBeGreaterThanOrEqual(1);
      expect(await repo.findPart(id, 0)).toBeNull();
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('0');
      await expect(storage.get(reserved!.stagingKey)).rejects.toThrow();
    } finally {
      resume();
      putSpy.mockRestore();
      deleteSpy?.mockRestore();
    }
  });

  it('keeps a retired key charged until its late PUT settles and deletion succeeds', async () => {
    const id = await create('/gc-stale-mark.bin', '4', raceNamespaceId);
    const storage = app.get<BlobStorage>(BLOB_STORAGE);
    const repo = app.get(VfsUploadSessionRepository);
    const usage = app.get(DataSource).getRepository(VfsUploadUsageEntity);
    const originalPut = storage.put.bind(storage);
    const originalDelete = storage.delete.bind(storage);
    let putEntered!: () => void;
    const putStarted = new Promise<void>((resolve) => {
      putEntered = resolve;
    });
    let resumePut!: () => void;
    const putReleased = new Promise<void>((resolve) => {
      resumePut = resolve;
    });
    const putSpy = jest
      .spyOn(storage, 'put')
      .mockImplementationOnce(async (key, stream, type) => {
        putEntered();
        await putReleased;
        await originalPut(key, stream, type);
      })
      .mockImplementation(originalPut);
    let gcDeleteEntered!: () => void;
    const gcDeleteStarted = new Promise<void>((resolve) => {
      gcDeleteEntered = resolve;
    });
    let resumeGcDelete!: () => void;
    const gcDeleteReleased = new Promise<void>((resolve) => {
      resumeGcDelete = resolve;
    });
    const deleteSpy = jest
      .spyOn(storage, 'delete')
      .mockImplementationOnce(async (key) => {
        await originalDelete(key);
        gcDeleteEntered();
        await gcDeleteReleased;
      })
      .mockImplementationOnce(async () => {
        throw new Error('service cleanup unavailable');
      })
      .mockImplementation(originalDelete);
    try {
      const pending = put(id, 0, 'data', app, raceNamespaceId).then((response) => response);
      await putStarted;
      const reserved = await repo.findPart(id, 0);
      expect(reserved?.state).toBe('RESERVED');
      await app
        .get(DataSource)
        .getRepository(VfsUploadSessionEntity)
        .update({ id }, { expiresAt: new Date(Date.now() - 1000) });
      await app
        .get(DataSource)
        .getRepository(VfsUploadPartEntity)
        .update({ sessionId: id, partIndex: 0 }, { leaseExpiresAt: new Date(Date.now() - 1000) });
      const gcPending = app.get(GcJob).run();
      await gcDeleteStarted;
      expect(await repo.markStagingObjectDeleted(id, 0, reserved!.stagingKey, 'RESERVED')).toBe(false);
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('4');
      resumePut();
      expect((await pending).status).toBe(409);
      expect(await repo.findPart(id, 0)).toBeNull();
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('4');
      resumeGcDelete();
      expect((await gcPending).deletedStagingObjects).toBeGreaterThanOrEqual(1);
      expect(await repo.findPart(id, 0)).toBeNull();
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('4');
      (await storage.get(reserved!.stagingKey)).destroy();
      await app.get(GcJob).run();
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('0');
      await expect(storage.get(reserved!.stagingKey)).rejects.toThrow();
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('0');
    } finally {
      resumePut();
      resumeGcDelete();
      putSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('keeps an uncertain write charged until key-specific cleanup, then retries with a fresh key', async () => {
    const id = await create('/retry.bin', '4', failureNamespaceId);
    const storage = app.get<BlobStorage>(BLOB_STORAGE);
    const repo = app.get(VfsUploadSessionRepository);
    const originalPut = storage.put.bind(storage);
    const originalDelete = storage.delete.bind(storage);
    const putSpy = jest
      .spyOn(storage, 'put')
      .mockImplementationOnce(async () => {
        throw new Error('put unavailable');
      })
      .mockImplementation(originalPut);
    const deleteSpy = jest
      .spyOn(storage, 'delete')
      .mockImplementationOnce(async () => {
        throw new Error('delete unavailable');
      })
      .mockImplementation(originalDelete);
    try {
      await put(id, 0, 'data', app, failureNamespaceId).expect(500);
      const failed = await repo.findPart(id, 0);
      expect(failed?.state).toBe('CLEANUP');
      const usage = app.get(DataSource).getRepository(VfsUploadUsageEntity);
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('4');
      expect((await put(id, 0, 'data', app, failureNamespaceId)).status).toBe(409);
      await storage.delete(failed!.stagingKey);
      expect(await repo.markStagingObjectDeleted(id, 0, failed!.stagingKey, 'CLEANUP')).toBe(true);
      expect(String((await usage.findOneByOrFail({ id: 'global' })).stagedBytes)).toBe('0');
      await put(id, 0, 'data', app, failureNamespaceId).expect(200);
      const accepted = await repo.findPart(id, 0);
      expect(accepted?.digest).toBe(sha('data'));
      expect(accepted?.stagingKey).not.toBe(failed?.stagingKey);
      expect(await repo.markStagingObjectDeleted(id, 0, failed!.stagingKey, 'CLEANUP')).toBe(false);
    } finally {
      putSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('keeps encrypted staging ciphertext and records plaintext digest and IV', async () => {
    const id = await create('/encrypted.bin', '4', encryptedId);
    await put(id, 0, 'data', app, encryptedId).expect(200);
    const part = await app.get(VfsUploadSessionRepository).findPart(id, 0);
    expect(part?.digest).toBe(sha('data'));
    expect(part?.encryptionIv).toMatch(/^[0-9a-f]{32}$/);
    const storage = app.get<BlobStorage>(BLOB_STORAGE);
    const chunks: Buffer[] = [];
    for await (const chunk of await storage.get(part!.stagingKey)) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).equals(Buffer.from('data'))).toBe(false);
  });
});
