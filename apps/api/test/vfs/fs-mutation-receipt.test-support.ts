import type { FsHttpContext } from './fs-http-fixture.test-support.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { IsNull } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import { encodeRevision } from '../../src/vfs/revision.js';
import { withoutStatHash } from './fs-http-fixture.test-support.js';

export function registerFsMutationReceiptContract(ctx: FsHttpContext) {
  describe('conditional mutation receipts', () => {
    it.each(['move', 'copy'] as const)(
      '%s exact 목적지 충돌·receipt 재생·기존 배치 유지를 HTTP 경계에서 지킨다',
      async (kind) => {
        const namespaceId = await ctx.createNamespace(`exact-http-${kind}-${randomUUID()}`);
        const base = `/api/v2/namespaces/${namespaceId}/fs`;
        await request(ctx.httpServer)
          .post(`${base}/content`)
          .query({ path: '/source' })
          .set('Content-Type', 'text/plain')
          .send('source')
          .expect(201);
        await request(ctx.httpServer)
          .post(`${base}/content`)
          .query({ path: '/file' })
          .set('Content-Type', 'text/plain')
          .send('occupied')
          .expect(201);
        await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/directory' }).expect(201);
        const revision = async (path: string) =>
          (await request(ctx.httpServer).get(`${base}/revision`).query({ path }).expect(200)).body
            .revision as string;
        const sourceRevision = await revision('/source');
        const mutate = (body: Record<string, unknown>, key = randomUUID()) =>
          request(ctx.httpServer)
            .post(`${base}/mutations`)
            .set('Idempotency-Key', key)
            .set('X-Mutation-Scope', 'exact-target')
            .send(body);
        const command = {
          kind,
          source: '/source',
          destination: '/file',
          sourceRevision,
          destinationAbsent: true,
          destinationResolution: 'exact',
        };
        for (const path of ['/', '/file', '/directory']) {
          const stat = (await request(ctx.httpServer).get(`${base}/stat`).query({ path }).expect(200)).body;
          const currentRevision = await revision(path);
          const failed = await mutate({ ...command, destination: path }).expect(412);
          expect(failed.body).toMatchObject({
            code: 'VFS_PRECONDITION_FAILED',
            path,
            current: { id: stat.id, path, revision: currentRevision },
          });
        }
        const key = randomUUID();
        const failed = await mutate(command, key).expect(412);
        await request(ctx.httpServer)
          .post(`${base}/content`)
          .query({ path: '/file', force: true })
          .set('Content-Type', 'text/plain')
          .send('changed')
          .expect(200);
        const replay = await mutate(command, key).expect(412);
        expect(replay.body).toEqual(failed.body);
        expect(replay.headers['x-request-id']).toBe(failed.headers['x-request-id']);
        expect(
          (await mutate({ ...command, destinationResolution: undefined }, key).expect(409)).body.code,
        ).toBe('MUTATION_KEY_REUSED');
        for (const value of ['placement', false, null]) {
          expect((await mutate({ ...command, destinationResolution: value }).expect(400)).body.code).toBe(
            'VFS_INVALID_MUTATION_REQUEST',
          );
        }
        const stale = await mutate({
          ...command,
          sourceRevision: encodeRevision({ id: randomUUID(), version: 1 }),
        }).expect(412);
        expect(stale.body.path).toBe('/source');
        expect(stale.body.current.revision).toBe(sourceRevision);
        const exact = await mutate({ ...command, destination: '/directory/leaf' }).expect(
          kind === 'move' ? 200 : 201,
        );
        expect(exact.body.resource.path).toBe('/directory/leaf');
        if (kind === 'move') {
          await request(ctx.httpServer)
            .post(`${base}/content`)
            .query({ path: '/legacy-source' })
            .set('Content-Type', 'text/plain')
            .send('legacy')
            .expect(201);
        }
        const legacySource = kind === 'move' ? '/legacy-source' : '/source';
        const legacy = await mutate({
          ...command,
          source: legacySource,
          sourceRevision: await revision(legacySource),
          destination: '/directory',
          destinationResolution: undefined,
        }).expect(kind === 'move' ? 200 : 201);
        expect(legacy.body.resource.path).toBe(`/directory/${legacySource.slice(1)}`);
      },
    );

    it('같은 부재 exact 목적지로 동시 copy하면 하나만 생성하고 나머지는 412다', async () => {
      const namespaceId = await ctx.createNamespace(`exact-race-${randomUUID()}`);
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      for (const path of ['/one', '/two']) {
        await request(ctx.httpServer)
          .post(`${base}/content`)
          .query({ path })
          .set('Content-Type', 'text/plain')
          .send(path)
          .expect(201);
      }
      const copy = async (source: string) =>
        request(ctx.httpServer)
          .post(`${base}/mutations`)
          .set('Idempotency-Key', randomUUID())
          .set('X-Mutation-Scope', 'exact-race')
          .send({
            kind: 'copy',
            source,
            destination: '/target',
            sourceRevision: (
              await request(ctx.httpServer).get(`${base}/revision`).query({ path: source }).expect(200)
            ).body.revision,
            destinationAbsent: true,
            destinationResolution: 'exact',
          });
      const responses = await Promise.all([copy('/one'), copy('/two')]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 412]);
      expect(
        (await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/target' }).expect(200)).body.path,
      ).toBe('/target');
      const listing = await request(ctx.httpServer).get(`${base}/ls`).query({ path: '/' }).expect(200);
      expect(listing.body.items.filter((item: { name: string }) => item.name === 'target')).toHaveLength(1);
    });

    it('NFD path 거부를 receipt로 재생하고 같은 key의 NFC 요청은 key 재사용으로 거부한다', async () => {
      const namespaceId = await ctx.createNamespace('conditional-nfd-retry-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/mutations`;
      const key = randomUUID();
      const send = (path: string, idempotencyKey = key) =>
        request(ctx.httpServer)
          .post(base)
          .set('Idempotency-Key', idempotencyKey)
          .set('X-Mutation-Scope', 'caller-a')
          .send({ kind: 'mkdir', path, ifAbsent: true });
      const rejected = await send('/e\u0301').expect(400);
      expect(rejected.body.code).toBe('VFS_INVALID_PATH');
      expect(
        await ctx.migrationDataSource.getRepository(VfsMutationReceiptEntity).findBy({ namespaceId }),
      ).toMatchObject([{ state: 'COMPLETE', responseStatus: 400 }]);
      const replay = await send('/e\u0301').expect(400);
      expect(replay.body).toEqual(rejected.body);
      expect(replay.headers['x-request-id']).toBe(rejected.headers['x-request-id']);
      expect((await send('/é').expect(409)).body.code).toBe('MUTATION_KEY_REUSED');
      const accepted = await send('/é', randomUUID()).expect(201);
      expect(accepted.body.resource.path).toBe('/é');
    });

    it('rejects decomposed delete, move, and copy paths while accepting their NFC forms', async () => {
      const namespaceId = await ctx.createNamespace('conditional-path-operations-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const mutate = (body: Record<string, unknown>) =>
        request(ctx.httpServer)
          .post(`${base}/mutations`)
          .set('Idempotency-Key', randomUUID())
          .set('X-Mutation-Scope', 'path-contract')
          .send(body);
      const revision = async (path: string): Promise<string> =>
        (await request(ctx.httpServer).get(`${base}/revision`).query({ path }).expect(200)).body
          .revision as string;

      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/é' }).expect(201);
      const deleteRevision = await revision('/é');
      expect(
        (await mutate({ kind: 'delete', path: '/e\u0301', ifRevision: deleteRevision }).expect(400)).body
          .code,
      ).toBe('VFS_INVALID_PATH');
      await mutate({ kind: 'delete', path: '/é', ifRevision: deleteRevision }).expect(200);

      for (const kind of ['move', 'copy'] as const) {
        const source = `/é-${kind}`;
        const destination = `/é-${kind}-result`;
        await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: source }).expect(201);
        const sourceRevision = await revision(source);
        const command = { kind, source, destination, sourceRevision, destinationAbsent: true };
        for (const invalid of [
          { ...command, source: `/e\u0301-${kind}` },
          { ...command, destination: `/e\u0301-${kind}-result` },
        ]) {
          expect((await mutate(invalid).expect(400)).body.code).toBe('VFS_INVALID_PATH');
        }
        expect((await mutate(command).expect(kind === 'move' ? 200 : 201)).body.resource.path).toBe(
          destination,
        );
      }
    });

    it('keeps tree, revisions, bytes, and Blob references after failed conditions', async () => {
      const namespaceId = await ctx.createNamespace('conditional-failure-state-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/parent' }).expect(201);
      await request(ctx.httpServer)
        .post(`${base}/content/conditional`)
        .query({ path: '/parent/file' })
        .set('Content-Type', 'text/plain')
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'state-contract')
        .set('X-If-Absent', 'true')
        .send('original')
        .expect(201);
      const read = async () => ({
        root: (await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/' }).expect(200)).body,
        parent: (await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/parent' }).expect(200))
          .body,
        file: (
          await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/parent/file' }).expect(200)
        ).body,
        tree: (
          await request(ctx.httpServer)
            .get(`${base}/ls`)
            .query({ path: '/parent', consistency: 'revision' })
            .expect(200)
        ).body,
        blobs: (await ctx.migrationDataSource.getRepository(BlobEntity).findBy({ namespaceId }))
          .map((blob) => ({ id: blob.id, referenceCount: blob.referenceCount }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
      const before = await read();
      const failedCopy = await request(ctx.httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'state-contract')
        .send({
          kind: 'copy',
          source: '/parent/file',
          destination: '/parent/copied',
          sourceRevision: before.root.revision,
          destinationAbsent: true,
        })
        .expect(412);
      expect(failedCopy.body.code).toBe('VFS_PRECONDITION_FAILED');
      const failedUpload = await request(ctx.httpServer)
        .post(`${base}/content/conditional`)
        .query({ path: '/parent/file' })
        .set('Content-Type', 'text/plain')
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'state-contract')
        .set('X-If-Revision', before.root.revision)
        .send('replacement')
        .expect(412);
      expect(failedUpload.body.code).toBe('VFS_PRECONDITION_FAILED');
      expect(await read()).toEqual(before);
      expect(
        (await request(ctx.httpServer).get(`${base}/content`).query({ path: '/parent/file' }).expect(200))
          .text,
      ).toBe('original');
      await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/parent/copied' }).expect(404);
    });

    it('matches move and copy affectedRevisions to reads and invalidates changed directory cursors', async () => {
      const namespaceId = await ctx.createNamespace('conditional-move-copy-revisions-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      for (const path of [
        '/src',
        '/dst',
        '/src/a',
        '/src/a/child',
        '/src/a/child/grandchild',
        '/src/b',
        '/src/c',
        '/dst/a',
        '/dst/b',
      ]) {
        await request(ctx.httpServer).post(`${base}/mkdir`).send({ path }).expect(201);
      }
      const revision = async (path: string): Promise<string> =>
        (await request(ctx.httpServer).get(`${base}/revision`).query({ path }).expect(200)).body
          .revision as string;
      const cursor = async (path: string): Promise<string> => {
        const page = await request(ctx.httpServer)
          .get(`${base}/ls`)
          .query({ path, consistency: 'revision', limit: 1 })
          .expect(200);
        expect(page.body.nextCursor).toMatch(/^rc1\./);
        return page.body.nextCursor as string;
      };
      const expectStale = async (path: string, previousCursor: string): Promise<void> => {
        expect(
          (
            await request(ctx.httpServer)
              .get(`${base}/ls`)
              .query({ path, consistency: 'revision', limit: 1, cursor: previousCursor })
              .expect(412)
          ).body.code,
        ).toBe('VFS_PRECONDITION_FAILED');
      };
      const expectAffected = async (
        response: { affectedRevisions: { path: string; revision: string }[] },
        paths: string[],
      ): Promise<void> => {
        expect(response.affectedRevisions.map((entry) => entry.path).sort()).toEqual(paths);
        for (const path of paths) {
          const affected = response.affectedRevisions.find((entry) => entry.path === path);
          expect(affected).toEqual({ path, revision: await revision(path) });
        }
      };

      const sourceCursor = await cursor('/src');
      const destinationCursor = await cursor('/dst');
      const movedChildBefore = await revision('/src/a/child');
      const moved = await request(ctx.httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'revision-contract')
        .send({
          kind: 'move',
          source: '/src/a',
          destination: '/dst/moved',
          sourceRevision: await revision('/src/a'),
          destinationAbsent: true,
        })
        .expect(200);
      expect(moved.body.resource.path).toBe('/dst/moved');
      await expectAffected(moved.body, [
        '/',
        '/dst',
        '/dst/moved',
        '/dst/moved/child',
        '/dst/moved/child/grandchild',
        '/src',
      ]);
      expect(await revision('/dst/moved/child')).not.toBe(movedChildBefore);
      await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/src/a' }).expect(404);
      await expectStale('/src', sourceCursor);
      await expectStale('/dst', destinationCursor);

      const copiedSourceRevision = await revision('/dst/moved');
      const copiedSourceChildRevision = await revision('/dst/moved/child');
      const nextSourceCursor = await cursor('/src');
      const copied = await request(ctx.httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'revision-contract')
        .send({
          kind: 'copy',
          source: '/dst/moved',
          destination: '/src/copied',
          sourceRevision: copiedSourceRevision,
          destinationAbsent: true,
        })
        .expect(201);
      expect(copied.body.resource.path).toBe('/src/copied');
      await expectAffected(copied.body, [
        '/',
        '/src',
        '/src/copied',
        '/src/copied/child',
        '/src/copied/child/grandchild',
      ]);
      expect(await revision('/dst/moved')).toBe(copiedSourceRevision);
      expect(await revision('/dst/moved/child')).toBe(copiedSourceChildRevision);
      await expectStale('/src', nextSourceCursor);
    });

    it('replays the exact JSON request without increasing revisions again', async () => {
      const namespaceId = await ctx.createNamespace('conditional-mkdir-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/mutations`;
      const key = randomUUID();
      const body = '{"kind":"mkdir","path":"/a","ifAbsent":true}';
      const send = (raw: string) =>
        request(ctx.httpServer)
          .post(base)
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .send(raw);
      const first = await send(body).expect(201);
      expect(first.body).toMatchObject({ resource: { path: '/a' } });
      expect(first.body.affectedRevisions.map((item: { path: string }) => item.path)).toEqual(['/', '/a']);
      const replay = await send(body).expect(201);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
      const changed = await send('{"kind":"mkdir", "path":"/a","ifAbsent":true}').expect(409);
      expect(changed.body.code).toBe('MUTATION_KEY_REUSED');
    });

    it('replays deterministic 428 and 400 responses with the original request ID', async () => {
      const namespaceId = await ctx.createNamespace('conditional-errors-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/mutations`;
      const key = randomUUID();
      const send = (body: string) =>
        request(ctx.httpServer)
          .post(base)
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .send(body);
      const first = await send('{"kind":"mkdir","path":"/a"}').expect(428);
      expect(first.body.code).toBe('VFS_PRECONDITION_REQUIRED');
      const replay = await send('{"kind":"mkdir","path":"/a"}').expect(428);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
      const changed = await send('{"kind":"mkdir","path":"/a","ifAbsent":true}').expect(409);
      expect(changed.body.code).toBe('MUTATION_KEY_REUSED');

      const brokenKey = randomUUID();
      const badRequest = () =>
        request(ctx.httpServer)
          .post(base)
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', brokenKey)
          .set('X-Mutation-Scope', 'caller-a')
          .send('{broken');
      const broken = await badRequest().expect(400);
      expect((await badRequest().expect(400)).body).toEqual(broken.body);
    });

    it('조건 불일치 412를 최초 body(current 포함)로 재생하고 이후 변경에도 current를 고정한다', async () => {
      const namespaceId = await ctx.createNamespace('conditional-stale-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/a' }).expect(201);
      const root = await ctx.migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });
      const old = await ctx.migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: root.id, name: 'a' });
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/a/child' }).expect(201);
      const key = randomUUID();
      const send = (revision: string) =>
        request(ctx.httpServer)
          .post(`${base}/mutations`)
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .send({ kind: 'delete', path: '/a', ifRevision: revision, recursive: true });
      const statAt412 = (await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/a' }).expect(200))
        .body;
      const revisionAt412 = (
        await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/a' }).expect(200)
      ).body.revision as string;
      const failed = await send(encodeRevision(old)).expect(412);
      expect(failed.body).toMatchObject({
        code: 'VFS_PRECONDITION_FAILED',
        path: '/a',
        current: { ...withoutStatHash(statAt412), revision: revisionAt412 },
      });
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/a/later' }).expect(201);
      const statLater = (await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/a' }).expect(200))
        .body;
      expect(statLater).not.toEqual(statAt412);
      // 자식 추가로 현재 revision이 바뀌어도 재생되는 current.revision은 충돌 시점 값이다.
      const revisionLater = (
        await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/a' }).expect(200)
      ).body.revision as string;
      expect(revisionLater).not.toBe(revisionAt412);
      const replay = await send(encodeRevision(old)).expect(412);
      expect(replay.body).toEqual(failed.body);
      expect(replay.body.current.revision).toBe(revisionAt412);
      expect(replay.headers['x-request-id']).toBe(failed.headers['x-request-id']);
      const current = await ctx.migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ id: old.id });
      expect((await send(encodeRevision(current)).expect(409)).body.code).toBe('MUTATION_KEY_REUSED');
      const accepted = await request(ctx.httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'caller-a')
        .send({ kind: 'delete', path: '/a', ifRevision: encodeRevision(current), recursive: true })
        .expect(200);
      expect(accepted.body).toMatchObject({ resource: null });
      expect(accepted.body.affectedRevisions.map((item: { path: string }) => item.path)).toEqual(['/']);
    });

    it('requires UUID identity and bounded scope, and reports an active lease with Retry-After', async () => {
      const namespaceId = await ctx.createNamespace('conditional-identity-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/mutations`;
      const body = { kind: 'mkdir', path: '/a', ifAbsent: true };
      expect(
        (await request(ctx.httpServer).post(base).set('X-Mutation-Scope', 'caller-a').send(body).expect(400))
          .body.code,
      ).toBe('VFS_INVALID_MUTATION_REQUEST');
      expect(
        (
          await request(ctx.httpServer)
            .post(base)
            .set('Idempotency-Key', 'bad')
            .set('X-Mutation-Scope', 'caller-a')
            .send(body)
            .expect(400)
        ).body.code,
      ).toBe('VFS_INVALID_MUTATION_REQUEST');
      expect(
        (
          await request(ctx.httpServer)
            .post(base)
            .set('Idempotency-Key', randomUUID())
            .set('X-Mutation-Scope', 'x'.repeat(129))
            .send(body)
            .expect(400)
        ).body.code,
      ).toBe('VFS_INVALID_MUTATION_REQUEST');
      const key = randomUUID();
      await ctx.app
        .get(VfsMutationReceiptRepository)
        .claim({ namespaceId, scope: 'caller-a', key }, new Date());
      const busy = await request(ctx.httpServer)
        .post(base)
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', 'caller-a')
        .send(body)
        .expect(409);
      expect(busy.body.code).toBe('MUTATION_IN_PROGRESS');
      expect(Number(busy.headers['retry-after'])).toBeGreaterThan(0);
    });
  });
}
