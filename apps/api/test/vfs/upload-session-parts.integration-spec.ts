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
      },
    };
  }

  async function bootstrap(enabled: boolean) {
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
          },
        }),
      );
      builder.overrideProvider(UPLOAD_SESSION_POLICY).useValue(policy());
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
    namespaceId = plain.body.id as string;
    encryptedId = encrypted.body.id as string;
    raceNamespaceId = race.body.id as string;
    failureNamespaceId = failure.body.id as string;
    await app.close();
    app = await bootstrap(true);
    second = await bootstrap(true);
  }, 180000);

  afterAll(async () => {
    if (second) await second.close();
    if (app) await app.close();
    if (migrations?.isInitialized) await migrations.destroy();
    await Promise.all([postgres?.stop(), s3Container?.stop()]);
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
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
