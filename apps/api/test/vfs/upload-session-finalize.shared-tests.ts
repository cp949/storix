import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { jest } from '@jest/globals';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { GcJob } from '../../src/jobs/gc.job.js';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsUploadSessionEntity } from '../../src/persistence/entities/vfs-upload-session.entity.js';
import { VfsUploadUsageEntity } from '../../src/persistence/entities/vfs-upload-usage.entity.js';
import { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { BLOB_STORAGE } from '../../src/storage/storage.constants.js';
import { UploadSessionFinalizeService } from '../../src/vfs/upload-session-finalize.service.js';

export interface FinalizeContext {
  app(): INestApplication;
  namespace(): string;
  encryptedNamespace(): string;
  restartDisabled(): Promise<void>;
  restartEnabled(): Promise<void>;
}

export function registerFinalizeTests(context: FinalizeContext): void {
  const api = () => request(context.app().getHttpServer());
  const base = (ns = context.namespace()) => `/api/v2/namespaces/${ns}/fs/upload-sessions`;
  const auth = (call: request.Test) => call.set('Authorization', 'Bearer upload-finalize-integration-key');
  async function create(
    path: string,
    size: string,
    ns = context.namespace(),
    condition: { ifAbsent: true } | { ifRevision: string } = { ifAbsent: true },
  ) {
    const result = await auth(api().post(base(ns)))
      .set('X-Mutation-Scope', 'finalize')
      .set('Idempotency-Key', randomUUID())
      .send({ path, sizeBytes: size, mimeType: 'application/octet-stream', ...condition })
      .expect(201);
    return result.body.sessionId as string;
  }
  async function put(id: string, index: number, body: string, ns = context.namespace()) {
    return auth(api().put(`${base(ns)}/${id}/parts/${index}`))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from(body))
      .expect(200);
  }
  const complete = (id: string, ns = context.namespace()) => auth(api().post(`${base(ns)}/${id}/complete`));

  it('returns 404 for an unknown session without creating usage rows', async () => {
    const missing = randomUUID();
    expect((await complete(missing, randomUUID()).expect(404)).body.code).toBe(
      'VFS_UPLOAD_SESSION_NOT_FOUND',
    );
  });

  it('rejects incomplete parts and publishes ordered content once with restart replay after disable', async () => {
    const id = await create('/final-ordered.bin', '6');
    expect((await complete(id).expect(409)).body.code).toBe('VFS_UPLOAD_PARTS_INCOMPLETE');
    await put(id, 1, 'xy');
    await put(id, 0, 'abcd');
    await context.restartDisabled();
    const first = await complete(id).expect(201);
    const replay = await complete(id).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
    const content = await auth(api().get(`/api/v2/namespaces/${context.namespace()}/fs/content`))
      .query({ path: '/final-ordered.bin' })
      .expect(200);
    expect(content.body.toString()).toBe('abcdxy');
    const blobs = await context.app().get(DataSource).getRepository(BlobEntity).find();
    expect(blobs.filter((blob) => Number(blob.referenceCount) === 1)).toHaveLength(1);
    await context.restartEnabled();
  });

  it('keeps files published by resumable upload readable after disabling the capability', async () => {
    const path = '/final-readable-after-disable.bin';
    const id = await create(path, '9');
    await put(id, 0, 'reta');
    await put(id, 1, 'ined');
    await put(id, 2, '!');
    const published = await complete(id).expect(201);
    const resourceId = published.body.resource.id as string;
    const revision = published.body.resource.revision as string;

    await context.restartDisabled();

    const capabilities = await auth(api().get(`/api/v2/namespaces/${context.namespace()}/capabilities`))
      .expect(200);
    expect(capabilities.body).toEqual({ capabilities: [] });
    const stat = await auth(api().get(`/api/v2/namespaces/${context.namespace()}/fs/stat`))
      .query({ path })
      .expect(200);
    expect(stat.body.id).toBe(resourceId);
    expect(stat.body.revision).toBe(revision);
    const content = await auth(api().get(`/api/v2/namespaces/${context.namespace()}/fs/content`))
      .query({ path })
      .expect(200);
    expect(content.body.toString()).toBe('retained!');

    await context.restartEnabled();
  });

  it('keeps creation and completion request IDs separate across both replay routes', async () => {
    const key = randomUUID();
    const body = { path: '/final-dual-replay-id.bin', sizeBytes: '0', mimeType: 'application/octet-stream', ifAbsent: true };
    const createCall = (requestId: string) => auth(api().post(base()))
      .set('X-Mutation-Scope', 'finalize')
      .set('Idempotency-Key', key)
      .set('X-Request-Id', requestId)
      .send(body);
    const created = await createCall('creation-original').expect(201);
    const id = created.body.sessionId as string;
    const completed = await complete(id).set('X-Request-Id', 'completion-original').expect(201);
    const createReplay = await createCall('creation-retry').expect(201);
    const completeReplay = await complete(id).set('X-Request-Id', 'completion-retry').expect(201);
    expect(createReplay.body).toEqual(created.body);
    expect(createReplay.headers['x-request-id']).toBe('creation-original');
    expect(completeReplay.body).toEqual(completed.body);
    expect(completeReplay.headers['x-request-id']).toBe('completion-original');
  });

  it('rejects a changed target at finalization and keeps the losing session retryable', async () => {
    const loser = await create('/final-conflict.bin', '4');
    const winner = await create('/final-conflict.bin', '4');
    await put(loser, 0, 'lose');
    await put(winner, 0, 'wins');
    await complete(winner).expect(201);
    const conflict = await complete(loser).expect(412);
    expect(conflict.body.code).toBe('VFS_PRECONDITION_FAILED');
    const row = await context
      .app()
      .get(DataSource)
      .getRepository(VfsUploadSessionEntity)
      .findOneByOrFail({ id: loser });
    expect(row.state).toBe('OPEN');
  });

  it('uses the current revision for replacement and rejects a stale replacement', async () => {
    const original = await create('/final-revision.bin', '4');
    await put(original, 0, 'old!');
    const initial = await complete(original).expect(201);
    const revision = initial.body.resource.revision as string;
    const stale = await create('/final-revision.bin', '4', context.namespace(), { ifRevision: revision });
    const replacement = await create('/final-revision.bin', '4', context.namespace(), {
      ifRevision: revision,
    });
    await put(stale, 0, 'late');
    await put(replacement, 0, 'new!');
    const changed = await complete(replacement).expect(200);
    expect(changed.body.resource.revision).not.toBe(revision);
    expect((await complete(stale).expect(412)).body.code).toBe('VFS_PRECONDITION_FAILED');
  });

  it('rejects a target whose parent disappeared after creation', async () => {
    const root = `/api/v2/namespaces/${context.namespace()}/fs`;
    await auth(api().post(`${root}/mkdir`))
      .send({ path: '/final-parent', parents: false })
      .expect(201);
    const id = await create('/final-parent/child.bin', '0');
    await auth(api().post(`${root}/rmdir`))
      .query({ path: '/final-parent' })
      .expect(204);
    expect((await complete(id).expect(404)).body.code).toBe('VFS_NODE_NOT_FOUND');
    expect(
      (await context.app().get(DataSource).getRepository(VfsUploadSessionEntity).findOneByOrFail({ id }))
        .state,
    ).toBe('OPEN');
  });

  it('rolls back quota rejection without a Node or referenced Blob', async () => {
    const db = context.app().get(DataSource);
    await db
      .getRepository(NamespaceEntity)
      .update({ id: context.namespace() }, { maxTotalLogicalBytes: '3' });
    try {
      const id = await create('/final-quota.bin', '4');
      await put(id, 0, 'data');
      const failure = await complete(id).expect(413);
      expect(failure.body.code).toBe('VFS_QUOTA_EXCEEDED');
      expect((await db.getRepository(VfsUploadSessionEntity).findOneByOrFail({ id })).state).toBe('OPEN');
      await auth(api().get(`/api/v2/namespaces/${context.namespace()}/fs/stat`))
        .query({ path: '/final-quota.bin' })
        .expect(404);
    } finally {
      await db
        .getRepository(NamespaceEntity)
        .update({ id: context.namespace() }, { maxTotalLogicalBytes: null });
    }
  });

  it('releases a failed final object write and completes on retry', async () => {
    const id = await create('/final-storage-retry.bin', '4');
    await put(id, 0, 'data');
    const storage = context.app().get<BlobStorage>(BLOB_STORAGE);
    const originalPut = storage.put.bind(storage);
    const spy = jest
      .spyOn(storage, 'put')
      .mockImplementationOnce(async () => {
        throw new Error('final object unavailable');
      })
      .mockImplementation(originalPut);
    try {
      await complete(id).expect(500);
      expect(
        (await context.app().get(DataSource).getRepository(VfsUploadSessionEntity).findOneByOrFail({ id }))
          .state,
      ).toBe('OPEN');
      await auth(api().get(`/api/v2/namespaces/${context.namespace()}/fs/stat`))
        .query({ path: '/final-storage-retry.bin' })
        .expect(404);
    } finally {
      spy.mockRestore();
    }
    await complete(id).expect(201);
  });

  it('rolls back Node, Blob, revision, and session when result storage fails', async () => {
    const id = await create('/final-db-retry.bin', '0');
    const repo = context.app().get(VfsUploadSessionRepository);
    const original = repo.completeFinalize.bind(repo);
    const spy = jest
      .spyOn(repo, 'completeFinalize')
      .mockImplementationOnce(async () => {
        throw new Error('result write failed');
      })
      .mockImplementation(original);
    try {
      await complete(id).expect(500);
      expect(
        (await context.app().get(DataSource).getRepository(VfsUploadSessionEntity).findOneByOrFail({ id }))
          .state,
      ).toBe('OPEN');
      await auth(api().get(`/api/v2/namespaces/${context.namespace()}/fs/stat`))
        .query({ path: '/final-db-retry.bin' })
        .expect(404);
    } finally {
      spy.mockRestore();
    }
    await complete(id).expect(201);
  });

  it('publishes encrypted final content from encrypted staging parts', async () => {
    const ns = context.encryptedNamespace();
    const id = await create('/secret.bin', '6', ns);
    await put(id, 0, 'abcd', ns);
    await put(id, 1, 'xy', ns);
    await complete(id, ns).expect(201);
    const content = await auth(api().get(`/api/v2/namespaces/${ns}/fs/content`))
      .query({ path: '/secret.bin' })
      .expect(200);
    expect(content.body.toString()).toBe('abcdxy');
    const blob = await context
      .app()
      .get(DataSource)
      .getRepository(BlobEntity)
      .findOneByOrFail({ namespaceId: ns });
    expect(blob.encryptionIv).not.toBeNull();
  });

  it('fences a stale worker after lease recovery and accepts one new claim', async () => {
    const ns = context.namespace();
    const id = await create('/final-fenced.bin', '0');
    const repo = context.app().get(VfsUploadSessionRepository);
    const first = await repo.claimFinalize(ns, id, 60_000);
    expect(first.kind).toBe('claimed');
    if (first.kind !== 'claimed') throw new Error('first claim missing');
    await context
      .app()
      .get(DataSource)
      .getRepository(VfsUploadSessionEntity)
      .update({ id }, { leaseExpiresAt: new Date(Date.now() - 1000) });
    expect(await repo.renewFinalize(ns, id, first.token, new Date(), new Date(Date.now() + 60_000))).toBe(
      false,
    );
    expect(await repo.recoverStaleFinalizingLeases(new Date())).toBeGreaterThanOrEqual(1);
    const second = await repo.claimFinalize(ns, id, 60_000);
    expect(second.kind).toBe('claimed');
    if (second.kind !== 'claimed') throw new Error('second claim missing');
    expect(second.token).not.toBe(first.token);
    await expect(
      context
        .app()
        .get(DataSource)
        .transaction((manager) =>
          repo.fenceFinalize(manager, ns, id, first.token, new Date(), new Date(Date.now() + 60_000)),
        ),
    ).rejects.toThrow('claim lost');
    expect(await repo.releaseFinalize(ns, id, first.token)).toBe(false);
    expect(await repo.releaseFinalize(ns, id, second.token)).toBe(true);
    await complete(id).expect(201);
  });

  it.each(['expiresAt', 'maxExpiresAt'] as const)(
    'does not claim a session whose %s passes while waiting for the usage lock',
    async (expiryField) => {
      const ns = context.namespace();
      const id = await create('/final-wait-expiry.bin', '0');
      const db = context.app().get(DataSource);
      await db.getRepository(VfsUploadSessionEntity).update(
        { id },
        {
          [expiryField]: new Date(Date.now() + 150),
        },
      );
      let unlock!: () => void;
      const held = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      let entered!: () => void;
      const locked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const lock = db.transaction(async (manager) => {
        await manager.query(
          "UPDATE vfs_upload_usage SET active_sessions = active_sessions WHERE id = 'global'",
        );
        entered();
        await held;
      });
      await locked;
      const claim = context.app().get(VfsUploadSessionRepository).claimFinalize(ns, id, 60_000);
      await new Promise((resolve) => setTimeout(resolve, 350));
      unlock();
      await lock;
      expect((await claim).kind).toBe('closed');
    },
  );

  it('prevents a reclaimed worker from publishing after a newer completion', async () => {
    const ns = context.namespace();
    const id = await create('/final-reclaimed.bin', '0');
    const service = context.app().get(UploadSessionFinalizeService);
    const repo = context.app().get(VfsUploadSessionRepository);
    const storage = context.app().get<BlobStorage>(BLOB_STORAGE);
    const before = await context
      .app()
      .get(DataSource)
      .getRepository(BlobEntity)
      .count({
        where: {
          namespaceId: ns,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      });
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
      .mockImplementationOnce(async (key, stream, contentType) => {
        entered();
        await released;
        return originalPut(key, stream, contentType);
      })
      .mockImplementation(originalPut);
    try {
      const oldWorker = service.complete(ns, id, 'old-worker').then(
        () => 'published',
        (error: Error) => error.message,
      );
      await started;
      await context
        .app()
        .get(DataSource)
        .getRepository(VfsUploadSessionEntity)
        .update({ id }, { leaseExpiresAt: new Date(Date.now() - 1000) });
      expect(await repo.recoverStaleFinalizingLeases(new Date())).toBeGreaterThanOrEqual(1);
      const newer = await service.complete(ns, id, 'new-worker');
      expect(newer.status).toBe(201);
      resume();
      expect(await oldWorker).toContain('claim lost');
      const row = await context
        .app()
        .get(DataSource)
        .getRepository(VfsUploadSessionEntity)
        .findOneByOrFail({ id });
      expect(row.requestId).toBe('new-worker');
      const blobs = await context
        .app()
        .get(DataSource)
        .getRepository(BlobEntity)
        .find({ where: { namespaceId: ns } });
      expect(
        blobs.filter(
          (blob) =>
            Number(blob.referenceCount) === 1 &&
            blob.sha256 === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        ),
      ).toHaveLength(before + 1);
    } finally {
      resume();
      spy.mockRestore();
    }
  });

  it('lets only one of completion and cancellation become terminal', async () => {
    const id = await create('/final-race.bin', '0');
    const db = context.app().get(DataSource);
    const before = await db
      .getRepository(BlobEntity)
      .count({ where: { namespaceId: context.namespace(), referenceCount: 1 } });
    const [done, cancelled] = await Promise.all([complete(id), auth(api().delete(`${base()}/${id}`))]);
    expect([done.status, cancelled.status].sort()).toEqual(done.status === 201 ? [201, 409] : [200, 409]);
    const row = await context
      .app()
      .get(DataSource)
      .getRepository(VfsUploadSessionEntity)
      .findOneByOrFail({ id });
    expect(['COMPLETED', 'CANCELLED']).toContain(row.state);
    expect((done.status === 201) === (row.state === 'COMPLETED')).toBe(true);
    const nodes = await db
      .getRepository(VfsNodeEntity)
      .find({ where: { namespaceId: context.namespace(), name: 'final-race.bin' } });
    const published = row.state === 'COMPLETED' ? 1 : 0;
    expect(nodes).toHaveLength(published);
    if (published) {
      expect(nodes[0].version).toBe(1);
      expect(
        done.body.affectedRevisions.filter((item: { path: string }) => item.path === '/final-race.bin'),
      ).toHaveLength(1);
    }
    expect(
      await db
        .getRepository(BlobEntity)
        .count({ where: { namespaceId: context.namespace(), referenceCount: 1 } }),
    ).toBe(before + published);
  });

  it('claims concurrent completion only once and replays the winner afterward', async () => {
    const id = await create('/final-double.bin', '0');
    const db = context.app().get(DataSource);
    const before = await db
      .getRepository(BlobEntity)
      .count({ where: { namespaceId: context.namespace(), referenceCount: 1 } });
    const [a, b] = await Promise.all([complete(id), complete(id)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const first = a.status === 201 ? a : b;
    const replay = await complete(id).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
    const nodes = await db
      .getRepository(VfsNodeEntity)
      .find({ where: { namespaceId: context.namespace(), name: 'final-double.bin' } });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].version).toBe(1);
    expect(
      first.body.affectedRevisions.filter((item: { path: string }) => item.path === '/final-double.bin'),
    ).toHaveLength(1);
    expect(
      await db
        .getRepository(BlobEntity)
        .count({ where: { namespaceId: context.namespace(), referenceCount: 1 } }),
    ).toBe(before + 1);
  });

  it.each([false, true])('verifies the full plaintext checksum in %s encryption mode', async (encrypted) => {
    const ns = encrypted ? context.encryptedNamespace() : context.namespace();
    const path = `/checksum-good-${randomUUID()}.bin`;
    const sha256 = createHash('sha256').update('abcdxy').digest('hex');
    const created = await auth(api().post(base(ns)))
      .set('X-Mutation-Scope', 'checksum').set('Idempotency-Key', randomUUID())
      .send({ path, sizeBytes: '6', mimeType: 'application/octet-stream', ifAbsent: true, sha256 })
      .expect(201);
    const id = created.body.sessionId as string;
    await put(id, 0, 'abcd', ns);
    await put(id, 1, 'xy', ns);
    await complete(id, ns).expect(201);
    const content = await auth(api().get(`/api/v2/namespaces/${ns}/fs/content`))
      .query({ path }).expect(200);
    expect(content.body.toString()).toBe('abcdxy');
  });

  it.each([false, true])('persists mismatch as FAILED, replays 422, and cleans charged parts in %s encryption mode', async (encrypted) => {
    const ns = encrypted ? context.encryptedNamespace() : context.namespace();
    const path = `/checksum-bad-${randomUUID()}.bin`;
    const originalBytes = Buffer.from('original target');
    const original = await auth(api().post(`/api/v2/namespaces/${ns}/fs/content/conditional`))
      .query({ path })
      .set('X-Mutation-Scope', 'checksum-original')
      .set('Idempotency-Key', randomUUID())
      .set('X-If-Absent', 'true')
      .set('Content-Type', 'application/octet-stream')
      .send(originalBytes)
      .expect(201);
    const originalRevision = original.body.resource.revision as string;
    const key = randomUUID();
    const body = { path, sizeBytes: '4', mimeType: 'application/octet-stream',
      sha256: createHash('sha256').update('other').digest('hex') };
    const createCall = (value: Record<string, unknown>) => auth(api().post(base(ns)))
      .set('X-Mutation-Scope', 'checksum').set('Idempotency-Key', key).send(value);
    const sessionBody = { ...body, ifRevision: originalRevision };
    const invalid = await createCall({ ...sessionBody, sha256: 'A'.repeat(64) }).expect(400);
    expect(invalid.body.code).toBe('VFS_INVALID_CHECKSUM');
    const created = await createCall(sessionBody).expect(201);
    const id = created.body.sessionId as string;
    expect((await createCall({ ...sessionBody, sha256: 'b'.repeat(64) }).expect(409)).body.code)
      .toBe('MUTATION_KEY_REUSED');
    await put(id, 0, 'data', ns);
    const repo = context.app().get(VfsUploadSessionRepository);
    const part = await repo.findPart(id, 0);
    if (!part) throw new Error('stored part missing');
    const db = context.app().get(DataSource);
    const storage = context.app().get<BlobStorage>(BLOB_STORAGE);
    const originalDelete = storage.delete.bind(storage);
    let failedCount = 0;
    const deleteSpy = jest.spyOn(storage, 'delete').mockImplementation(async (stagingKey) => {
      if (stagingKey === part.stagingKey && failedCount < 2) {
        failedCount++;
        throw new Error('temporary staging deletion failure');
      }
      return originalDelete(stagingKey);
    });
    try {
      const first = await complete(id, ns).set('X-Request-Id', 'mismatch-first').expect(422);
      expect(first.body.code).toBe('VFS_CHECKSUM_MISMATCH');
      expect(failedCount).toBe(1); // immediate cleanup attempted
      const replay = await complete(id, ns).set('X-Request-Id', 'mismatch-retry').expect(422);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
      const creationReplay = await createCall(sessionBody).expect(201);
      expect(creationReplay.body).toEqual(created.body);
      expect(creationReplay.headers['x-request-id']).toBe(created.headers['x-request-id']);
      const status = await auth(api().get(`${base(ns)}/${id}`)).expect(200);
      expect(status.body).toMatchObject({ state: 'FAILED', failure: { code: 'VFS_CHECKSUM_MISMATCH' } });
      expect(JSON.stringify(status.body)).not.toMatch(new RegExp(body.sha256));
      const stat = await auth(api().get(`/api/v2/namespaces/${ns}/fs/stat`)).query({ path }).expect(200);
      expect(stat.body.revision).toBe(originalRevision);
      const content = await auth(api().get(`/api/v2/namespaces/${ns}/fs/content`)).query({ path }).expect(200);
      expect(content.body).toEqual(originalBytes);
      const row = await db.getRepository(VfsUploadSessionEntity).findOneByOrFail({ id });
      expect(row.terminalAt).not.toBeNull();
      expect(row.responseStatus).toBe(422);
      const usageBefore = await db.getRepository(VfsUploadUsageEntity)
        .findOneByOrFail({ id: `ns:${ns.toLowerCase()}` });
      expect(BigInt(usageBefore.stagedBytes)).toBeGreaterThanOrEqual(4n);
      expect((await repo.findCleanupParts()).some((candidate) => candidate.stagingKey === part.stagingKey))
        .toBe(true);
      await context.app().get(GcJob).run();
      expect(failedCount).toBe(2);
      expect(BigInt((await db.getRepository(VfsUploadUsageEntity)
        .findOneByOrFail({ id: `ns:${ns.toLowerCase()}` })).stagedBytes)).toBeGreaterThanOrEqual(4n);
      await context.app().get(GcJob).run();
      expect((await repo.findCleanupParts()).some((candidate) => candidate.stagingKey === part.stagingKey))
        .toBe(false);
      expect(BigInt((await db.getRepository(VfsUploadUsageEntity)
        .findOneByOrFail({ id: `ns:${ns.toLowerCase()}` })).stagedBytes))
        .toBeLessThan(BigInt(usageBefore.stagedBytes));
    } finally {
      deleteSpy.mockRestore();
    }
    expect((await repo.findForStatus(ns, id))?.session.state).toBe('FAILED');
    expect(await repo.pruneTerminalSessions(new Date(Date.now() - 30 * 24 * 3600_000)))
      .toBe(0);
    await db.getRepository(VfsUploadSessionEntity).update({ id }, {
      terminalAt: new Date(Date.now() - 31 * 24 * 3600_000),
    });
    expect(await repo.pruneTerminalSessions(new Date(Date.now() - 30 * 24 * 3600_000)))
      .toBeGreaterThanOrEqual(1);
    await auth(api().get(`${base(ns)}/${id}`)).expect(404);
  });
}
