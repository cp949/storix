import type { FsHttpContext } from './fs-http-fixture.test-support.js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

export function registerFsRevisionReadContract(ctx: FsHttpContext) {
  describe('revision reads and listing', () => {
    it('uses a read revision to conditionally delete a file', async () => {
      const namespaceId = await ctx.createNamespace('revision-delete-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(ctx.httpServer).post(`${base}/touch`).send({ path: '/code.py' }).expect(201);
      const read = await request(ctx.httpServer)
        .get(`${base}/revision`)
        .query({ path: '/code.py' })
        .expect(200);
      expect(read.body).toEqual({ path: '/code.py', revision: expect.stringMatching(/^r1\./) });
      await request(ctx.httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'revision-read-test')
        .send({ kind: 'delete', path: '/code.py', ifRevision: read.body.revision })
        .expect(200);
      expect(
        (await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/code.py' }).expect(404)).body
          .code,
      ).toBe('VFS_NODE_NOT_FOUND');
    });

    it('returns opaque revisions without changing the legacy listing shape', async () => {
      const namespaceId = await ctx.createNamespace('revision-read-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const rootBefore = await request(ctx.httpServer)
        .get(`${base}/revision`)
        .query({ path: '/' })
        .expect(200);
      expect(rootBefore.body).toMatchObject({ path: '/', revision: expect.stringMatching(/^r1\./) });
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/a' }).expect(201);
      const rootAfter = await request(ctx.httpServer)
        .get(`${base}/revision`)
        .query({ path: '/' })
        .expect(200);
      expect(rootAfter.body.revision).not.toBe(rootBefore.body.revision);
      const listing = await request(ctx.httpServer)
        .get(`${base}/ls`)
        .query({ path: '/', consistency: 'revision' })
        .expect(200);
      expect(listing.body.directoryRevision).toBe(rootAfter.body.revision);
      expect(listing.body.items[0]).toMatchObject({ path: '/a', revision: expect.stringMatching(/^r1\./) });
      const legacy = await request(ctx.httpServer).get(`${base}/ls`).query({ path: '/' }).expect(200);
      expect(legacy.body).not.toHaveProperty('directoryRevision');
      expect(legacy.body.items[0]).not.toHaveProperty('revision');
    });

    it('rejects a cursor after descendant change but keeps it after an independent change', async () => {
      const namespaceId = await ctx.createNamespace('revision-cursor-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      for (const path of ['/a', '/b', '/a/x', '/a/y']) {
        await request(ctx.httpServer).post(`${base}/mkdir`).send({ path }).expect(201);
      }
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/a/x/code.py' })
        .set('Content-Type', 'text/plain')
        .send('first')
        .expect(201);
      const first = await request(ctx.httpServer)
        .get(`${base}/ls`)
        .query({ path: '/a', consistency: 'revision', limit: 1 })
        .expect(200);
      expect(first.body.nextCursor).toMatch(/^rc1\./);
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/b/other' }).expect(201);
      const second = await request(ctx.httpServer)
        .get(`${base}/ls`)
        .query({ path: '/a', consistency: 'revision', limit: 1, cursor: first.body.nextCursor })
        .expect(200);
      expect(second.body.items.map((item: { path: string }) => item.path)).toEqual(['/a/y']);
      expect(
        (
          await request(ctx.httpServer)
            .get(`${base}/ls`)
            .query({ path: '/b', consistency: 'revision', cursor: first.body.nextCursor })
            .expect(400)
        ).body.code,
      ).toBe('VFS_INVALID_CURSOR');
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/a/x/code.py' })
        .set('Content-Type', 'text/plain')
        .set('If-Match', '1')
        .send('second')
        .expect(200);
      expect(
        (
          await request(ctx.httpServer)
            .get(`${base}/ls`)
            .query({ path: '/a', consistency: 'revision', limit: 1, cursor: first.body.nextCursor })
            .expect(412)
        ).body.code,
      ).toBe('VFS_PRECONDITION_FAILED');
    });

    it('rejects a malformed cursor and one from a deleted and recreated directory', async () => {
      const namespaceId = await ctx.createNamespace('revision-recreated-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      for (const path of ['/dir', '/dir/a', '/dir/b']) {
        await request(ctx.httpServer).post(`${base}/mkdir`).send({ path }).expect(201);
      }
      const first = await request(ctx.httpServer)
        .get(`${base}/ls`)
        .query({ path: '/dir', consistency: 'revision', limit: 1 })
        .expect(200);
      expect(
        (
          await request(ctx.httpServer)
            .get(`${base}/ls`)
            .query({ path: '/dir', consistency: 'revision', cursor: 'rc1.bad' })
            .expect(400)
        ).body.code,
      ).toBe('VFS_INVALID_CURSOR');
      await request(ctx.httpServer).post(`${base}/rm`).query({ path: '/dir', recursive: 'true' }).expect(204);
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
      expect(
        (
          await request(ctx.httpServer)
            .get(`${base}/ls`)
            .query({ path: '/dir', consistency: 'revision', cursor: first.body.nextCursor })
            .expect(400)
        ).body.code,
      ).toBe('VFS_INVALID_CURSOR');
    });

    it('name에 NUL이 든 위조 rc1 cursor는 400 VFS_INVALID_CURSOR다', async () => {
      const namespaceId = await ctx.createNamespace('revision-cursor-nul-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      for (const path of ['/dir', '/dir/a', '/dir/b']) {
        await request(ctx.httpServer).post(`${base}/mkdir`).send({ path }).expect(201);
      }
      const first = await request(ctx.httpServer)
        .get(`${base}/ls`)
        .query({ path: '/dir', consistency: 'revision', limit: 1 })
        .expect(200);
      // 서버가 만든 cursor에서 name만 바꿔 directoryId·directoryRevision 검사를 통과하게 한다.
      const position = JSON.parse(
        Buffer.from((first.body.nextCursor as string).slice(4), 'base64url').toString('utf8'),
      ) as Record<string, string>;
      const forged = `rc1.${Buffer.from(JSON.stringify({ ...position, name: 'a\u0000b' }), 'utf8').toString('base64url')}`;
      const response = await request(ctx.httpServer)
        .get(`${base}/ls`)
        .query({ path: '/dir', consistency: 'revision', cursor: forged })
        .expect(400);
      expect(response.body.code).toBe('VFS_INVALID_CURSOR');
    });
  });
}
