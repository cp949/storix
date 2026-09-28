import type { FsHttpContext } from './fs-http-fixture.test-support.js';
import { createHash, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import request from 'supertest';
import { IsNull } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import { BLOB_STORAGE } from '../../src/storage/storage.constants.js';
import type { BlobStorage } from '../../src/storage/blob-storage.js';
import { encodeRevision } from '../../src/vfs/revision.js';
import { MAX_FILE_SIZE_BYTES, postChunked, startHeldUpload } from './fs-http-fixture.test-support.js';

export function registerFsConditionalContentContract(ctx: FsHttpContext) {
  describe('conditional content upload', () => {
    it('조건부 copy 만료 오류는 receipt로 재생되고 레거시 cp의 만료 입력은 400이다', async () => {
      const namespaceId = await ctx.createNamespace('copy-expiry-http');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const created = await request(ctx.httpServer)
        .post(`${base}/content/conditional`)
        .query({ path: '/plain.bin' })
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'copy-expiry')
        .set('X-If-Absent', 'true')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('plain'))
        .expect(201);
      const key = randomUUID();
      const body = {
        kind: 'copy',
        source: '/plain.bin',
        destination: '/copy.bin',
        sourceRevision: created.body.resource.revision,
        destinationAbsent: true,
        expiresInSeconds: 59,
      };
      const send = (idempotencyKey: string, expiresInSeconds: number) =>
        request(ctx.httpServer)
          .post(`${base}/mutations`)
          .set('Idempotency-Key', idempotencyKey)
          .set('X-Mutation-Scope', 'copy-expiry')
          .send({ ...body, expiresInSeconds });
      const first = await send(key, 59).expect(400);
      expect(first.body.code).toBe('VFS_INVALID_EXPIRY');
      const replay = await send(key, 59).expect(400);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
      expect((await send(key, 600).expect(409)).body.code).toBe('MUTATION_KEY_REUSED');

      const okKey = randomUUID();
      const ok = await send(okKey, 600).expect(201);
      expect(ok.body.resource.expiresAt).toEqual(expect.any(String));
      expect((await send(okKey, 601).expect(409)).body.code).toBe('MUTATION_KEY_REUSED');

      const legacy = await request(ctx.httpServer)
        .post(`${base}/cp`)
        .send({ source: '/plain.bin', destination: '/legacy.bin', expiresInSeconds: 600 })
        .expect(400);
      expect(legacy.body.code).toBe('VFS_INVALID_EXPIRY');
      await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/legacy.bin' }).expect(404);
    });

    it('persist는 receipt로 재생되고 응답 유실 뒤 새 key 재시도는 412 current.expiresAt null로 완료를 판정한다', async () => {
      const namespaceId = await ctx.createNamespace('persist-http');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const created = await request(ctx.httpServer)
        .post(`${base}/content/conditional`)
        .query({ path: '/temp.bin' })
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'persist')
        .set('X-If-Absent', 'true')
        .set('X-Expires-In', '600')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('temp'))
        .expect(201);
      const persist = (key: string, ifRevision: string) =>
        request(ctx.httpServer)
          .post(`${base}/mutations`)
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'persist')
          .send({ kind: 'persist', path: '/temp.bin', ifRevision });

      const key = randomUUID();
      const first = await persist(key, created.body.resource.revision).expect(200);
      expect(first.body.resource).toMatchObject({ id: created.body.resource.id, expiresAt: null });
      const replay = await persist(key, created.body.resource.revision).expect(200);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);

      const retried = await persist(randomUUID(), created.body.resource.revision).expect(412);
      expect(retried.body.current).toMatchObject({ id: created.body.resource.id, expiresAt: null });

      const stat = (
        await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/temp.bin' }).expect(200)
      ).body;
      expect(stat.expiresAt).toBeNull();
      expect(stat.revision).not.toBe(created.body.resource.revision);
    });

    it('X-Expires-In 생성은 expiresAt을 응답·stat에 노출하고 만료 값은 fingerprint에 포함된다', async () => {
      const namespaceId = await ctx.createNamespace('conditional-expiry');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const key = randomUUID();
      const upload = (path: string, headers: Record<string, string>, idempotencyKey = randomUUID()) => {
        let call = request(ctx.httpServer)
          .post(`${base}/content/conditional`)
          .query({ path })
          .set('Idempotency-Key', idempotencyKey)
          .set('X-Mutation-Scope', 'expiry')
          .set('Content-Type', 'application/octet-stream');
        for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
        return call.send(Buffer.from('temp'));
      };

      const created = await upload('/temp.bin', { 'X-If-Absent': 'true', 'X-Expires-In': '600' }, key).expect(
        201,
      );
      expect(created.body.resource.expiresAt).toEqual(expect.any(String));
      const stat = (
        await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/temp.bin' }).expect(200)
      ).body;
      expect(stat.expiresAt).toBe(created.body.resource.expiresAt);
      const listed = (await request(ctx.httpServer).get(`${base}/ls`).query({ path: '/' }).expect(200)).body;
      expect(JSON.stringify(listed)).toContain(created.body.resource.expiresAt);

      expect(
        (await upload('/temp.bin', { 'X-If-Absent': 'true', 'X-Expires-In': '601' }, key).expect(409)).body
          .code,
      ).toBe('MUTATION_KEY_REUSED');

      const plain = await upload('/plain.bin', { 'X-If-Absent': 'true' }).expect(201);
      expect(plain.body.resource.expiresAt).toBeNull();
    });

    it.each([
      [{ 'X-If-Revision': 'r1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'X-Expires-In': '600' }],
      [{ 'X-If-Absent': 'true', 'X-Expires-In': '59' }],
      [{ 'X-If-Absent': 'true', 'X-Expires-In': '+600' }],
    ])('만료 입력 오류 %j는 400 VFS_INVALID_EXPIRY이고 파일을 만들지 않는다', async (headers) => {
      const namespaceId = await ctx.createNamespace('conditional-expiry-invalid');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      let call = request(ctx.httpServer)
        .post(`${base}/content/conditional`)
        .query({ path: '/bad.bin' })
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'expiry')
        .set('Content-Type', 'application/octet-stream');
      for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
      expect((await call.send(Buffer.from('x')).expect(400)).body.code).toBe('VFS_INVALID_EXPIRY');
      await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/bad.bin' }).expect(404);
    });

    it('POST /fs/content에 X-Expires-In을 보내면 400 VFS_INVALID_EXPIRY다', async () => {
      const namespaceId = await ctx.createNamespace('content-expiry-rejected');
      const response = await request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content`)
        .query({ path: '/a.bin' })
        .set('Content-Type', 'application/octet-stream')
        .set('X-Expires-In', '600')
        .send(Buffer.from('x'))
        .expect(400);
      expect(response.body.code).toBe('VFS_INVALID_EXPIRY');
    });

    it('경쟁 생성의 승자 ID와 revision을 receipt·stat에 보존하고 교체·이동·재생성의 ID 경계를 지킨다', async () => {
      const namespaceId = await ctx.createNamespace('conditional-stable-id');
      const otherNamespaceId = await ctx.createNamespace('conditional-stable-id-other');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const upload = (key: string, bytes: Buffer, condition: Record<string, string>, path = '/doc') => {
        let call = request(ctx.httpServer)
          .post(`${base}/content/conditional`)
          .query({ path })
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'stable-id')
          .set('Content-Type', 'application/octet-stream');
        for (const [name, value] of Object.entries(condition)) call = call.set(name, value);
        return call.send(bytes);
      };
      const firstKey = randomUUID();
      const secondKey = randomUUID();
      const [first, second] = await Promise.all([
        upload(firstKey, Buffer.from('first'), { 'X-If-Absent': 'true' }),
        upload(secondKey, Buffer.from('second'), { 'X-If-Absent': 'true' }),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 412]);
      const winner = first.status === 201 ? first : second;
      const winnerKey = first.status === 201 ? firstKey : secondKey;
      const winnerBytes = first.status === 201 ? Buffer.from('first') : Buffer.from('second');
      const stat = async (path: string) =>
        (await request(ctx.httpServer).get(`${base}/stat`).query({ path }).expect(200)).body;
      const original = await stat('/doc');
      expect(winner.body.resource).toMatchObject({ id: original.id, revision: original.revision });
      expect(original).toMatchObject({
        path: '/doc',
        type: 'FILE',
        size: winnerBytes.length,
        mimeType: 'application/octet-stream',
      });
      expect(original.sha256).toBe(createHash('sha256').update(winnerBytes).digest('hex'));
      expect((await upload(winnerKey, winnerBytes, { 'X-If-Absent': 'true' }).expect(201)).body).toEqual(
        winner.body,
      );

      const empty = await upload(randomUUID(), Buffer.alloc(0), {
        'X-If-Revision': original.revision,
      }).expect(200);
      const replaced = await stat('/doc');
      expect(empty.body.resource).toMatchObject({ id: original.id, revision: replaced.revision });
      expect(replaced).toMatchObject({
        id: original.id,
        size: 0,
        sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
      });
      expect(replaced.revision).not.toBe(original.revision);

      const moved = await request(ctx.httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'stable-id')
        .send({
          kind: 'move',
          source: '/doc',
          destination: '/renamed',
          sourceRevision: replaced.revision,
          destinationAbsent: true,
        })
        .expect(200);
      const movedStat = await stat('/renamed');
      expect(moved.body.resource).toMatchObject({ id: original.id, path: '/renamed' });
      expect(moved.body.affectedRevisions).toContainEqual({ path: '/renamed', revision: movedStat.revision });
      expect(movedStat.id).toBe(original.id);
      await request(ctx.httpServer)
        .post(`${base}/mutations`)
        .set('Idempotency-Key', randomUUID())
        .set('X-Mutation-Scope', 'stable-id')
        .send({ kind: 'delete', path: '/renamed', ifRevision: movedStat.revision })
        .expect(200);
      await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/renamed' }).expect(404);
      await request(ctx.httpServer)
        .get(`/api/v2/namespaces/${otherNamespaceId}/fs/stat`)
        .query({ path: '/renamed' })
        .expect(404);
      const recreatedBytes = Buffer.from('recreated');
      const recreated = await upload(
        randomUUID(),
        recreatedBytes,
        { 'X-If-Absent': 'true' },
        '/renamed',
      ).expect(201);
      const recreatedStat = await stat('/renamed');
      expect(recreated.body.resource).toMatchObject({
        id: recreatedStat.id,
        revision: recreatedStat.revision,
      });
      expect(recreatedStat).toMatchObject({
        type: 'FILE',
        size: recreatedBytes.length,
        sha256: createHash('sha256').update(recreatedBytes).digest('hex'),
      });
      expect(recreatedStat.id).not.toBe(original.id);
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/dir' }).expect(201);
      expect(await stat('/dir')).toMatchObject({ type: 'DIRECTORY', sha256: null });
    });

    it('NFD path 거부를 receipt로 재생하고 같은 key의 NFC upload는 key 재사용으로 거부한다', async () => {
      const namespaceId = await ctx.createNamespace('conditional-content-nfd-retry-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
      const key = randomUUID();
      const send = (path: string, idempotencyKey = key) =>
        request(ctx.httpServer)
          .post(base)
          .query({ path })
          .set('Idempotency-Key', idempotencyKey)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from('body'));
      const rejected = await send('/e\u0301').expect(400);
      expect(rejected.body.code).toBe('VFS_INVALID_PATH');
      expect(
        await ctx.migrationDataSource.getRepository(VfsMutationReceiptEntity).findBy({ namespaceId }),
      ).toMatchObject([{ state: 'COMPLETE', responseStatus: 400 }]);
      expect(await ctx.migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } })).toBe(
        0,
      );
      const replay = await send('/e\u0301').expect(400);
      expect(replay.body).toEqual(rejected.body);
      expect(replay.headers['x-request-id']).toBe(rejected.headers['x-request-id']);
      expect((await send('/é').expect(409)).body.code).toBe('MUTATION_KEY_REUSED');
      const accepted = await send('/é', randomUUID()).expect(201);
      expect(accepted.body.resource.path).toBe('/é');
    });

    it('replays an accepted upload after the namespace file-size limit is lowered', async () => {
      const namespaceId = await ctx.createNamespace('conditional-content-replay-limit-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
      const bytes = Buffer.from('accepted before the limit changed');
      const key = randomUUID();
      const send = () =>
        request(ctx.httpServer)
          .post(base)
          .query({ path: '/code.py' })
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .set('Content-Type', 'application/octet-stream')
          .send(bytes);
      const first = await send().expect(201);
      await ctx.migrationDataSource
        .getRepository(NamespaceEntity)
        .update(namespaceId, { maxFileSizeBytes: '1' });
      const replay = await send().expect(201);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers['x-request-id']).toBe(first.headers['x-request-id']);
    });

    it('stores binary bytes and replays the exact upload without another Blob row', async () => {
      const namespaceId = await ctx.createNamespace('conditional-content-http-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const key = randomUUID();
      const bytes = Buffer.from([0, 1, 2, 255, 0, 128]);
      const send = (value: Buffer) =>
        request(ctx.httpServer)
          .post(`${base}/content/conditional`)
          .query({ path: '/image.bin' })
          .set('Content-Type', 'application/octet-stream')
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .send(value);
      const first = await send(bytes).expect(201);
      expect(first.body).toMatchObject({ resource: { path: '/image.bin' } });
      const blobCount = await ctx.migrationDataSource
        .getRepository(BlobEntity)
        .count({ where: { namespaceId } });
      const storage = ctx.app.get<BlobStorage>(BLOB_STORAGE);
      const putSpy = jest.spyOn(storage, 'put');
      try {
        const replay = await send(bytes).expect(201);
        expect(replay.body).toEqual(first.body);
        expect(putSpy).not.toHaveBeenCalled();
      } finally {
        putSpy.mockRestore();
      }
      expect(await ctx.migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } })).toBe(
        blobCount,
      );
      const downloaded = await request(ctx.httpServer)
        .get(`${base}/content`)
        .query({ path: '/image.bin' })
        .expect(200);
      expect(downloaded.body).toEqual(bytes);
    });

    it('raw checksum contract validates before receipt, checks plaintext, and replays 422 without mutation', async () => {
      for (const policy of ['NONE', 'ENCRYPTED'] as const) {
        const namespace = await request(ctx.httpServer)
          .post('/api/v2/namespaces')
          .set('Idempotency-Key', `checksum-${policy}`)
          .send({ name: `checksum-${policy.toLowerCase()}`, encryptionPolicy: policy })
          .expect(201);
        const namespaceId = namespace.body.id as string;
        const base = `/api/v2/namespaces/${namespaceId}/fs`;
        const initial = Buffer.from('plaintext checksum payload');
        const next = Buffer.from('changed payload');
        const correct = createHash('sha256').update(initial).digest('hex');
        const nextHash = createHash('sha256').update(next).digest('hex');
        const bad = '0'.repeat(64);
        const createKey = randomUUID();
        const send = (key: string, bytes: Buffer, checksum: string | undefined, ifRevision?: string) => {
          let call = request(ctx.httpServer)
            .post(`${base}/content/conditional`)
            .query({ path: '/file' })
            .set('Content-Type', 'application/octet-stream')
            .set('Idempotency-Key', key)
            .set('X-Mutation-Scope', 'checksum-contract');
          call = ifRevision ? call.set('X-If-Revision', ifRevision) : call.set('X-If-Absent', 'true');
          if (checksum !== undefined) call = call.set('X-Content-Sha256', checksum);
          return call.send(bytes);
        };

        const malformed = await send(createKey, initial, correct.toUpperCase()).expect(400);
        expect(malformed.body.code).toBe('VFS_INVALID_CHECKSUM');
        expect(
          await ctx.migrationDataSource
            .getRepository(VfsMutationReceiptEntity)
            .count({ where: { namespaceId } }),
        ).toBe(0);
        const created = await send(createKey, initial, correct).expect(201);
        const revision = created.body.resource.revision as string;
        const replay = await send(createKey, initial, correct).expect(201);
        expect(replay.body).toEqual(created.body);
        expect(replay.headers['x-request-id']).toBe(created.headers['x-request-id']);
        expect((await send(createKey, next, correct).expect(409)).body.code).toBe('MUTATION_KEY_REUSED');
        expect((await send(createKey, initial, bad).expect(409)).body.code).toBe('MUTATION_KEY_REUSED');

        const mismatchKey = randomUUID();
        const mismatch = await send(mismatchKey, next, bad, revision).expect(422);
        expect(mismatch.body.code).toBe('VFS_CHECKSUM_MISMATCH');
        expect(JSON.stringify(mismatch.body)).not.toContain(bad);
        expect(JSON.stringify(mismatch.body)).not.toContain(nextHash);
        const repeated = await send(mismatchKey, next, bad, revision).expect(422);
        expect(repeated.body).toEqual(mismatch.body);
        expect(repeated.headers['x-request-id']).toBe(mismatch.headers['x-request-id']);
        expect((await send(mismatchKey, next, correct, revision).expect(409)).body.code).toBe(
          'MUTATION_KEY_REUSED',
        );
        expect((await send(mismatchKey, initial, bad, revision).expect(409)).body.code).toBe(
          'MUTATION_KEY_REUSED',
        );
        const after = await request(ctx.httpServer)
          .get(`${base}/revision`)
          .query({ path: '/file' })
          .expect(200);
        expect(after.body.revision).toBe(revision);
        expect(
          (await request(ctx.httpServer).get(`${base}/content`).query({ path: '/file' }).expect(200)).body,
        ).toEqual(initial);
        expect(
          await ctx.migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } }),
        ).toBe(1);
      }
    });

    it('교체는 정확한 revision을 요구하고 최초 412는 파일 교체 뒤에도 충돌 시점 current로 재생하며 fingerprint가 바뀐 재시도는 거부한다', async () => {
      const namespaceId = await ctx.createNamespace('conditional-content-replace-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
      const createKey = randomUUID();
      const put = (
        key: string,
        path: string,
        mime: string,
        bytes: Buffer,
        condition: Record<string, string>,
      ) => {
        let call = request(ctx.httpServer)
          .post(base)
          .query({ path })
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .set('Content-Type', mime);
        for (const [name, value] of Object.entries(condition)) call = call.set(name, value);
        return call.send(bytes);
      };
      const created = await put(createKey, '/x', 'text/plain', Buffer.from('first'), {
        'X-If-Absent': 'true',
      }).expect(201);
      const revision = created.body.affectedRevisions.find((item: { path: string }) => item.path === '/x')
        .revision as string;
      const root = await ctx.migrationDataSource
        .getRepository(VfsNodeEntity)
        .findOneByOrFail({ namespaceId, parentId: IsNull() });
      const staleKey = randomUUID();
      const sendStale = () =>
        put(staleKey, '/x', 'text/plain', Buffer.from('second'), {
          'X-If-Revision': encodeRevision(root),
        });
      const blobCount = () =>
        ctx.migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } });
      const storage = ctx.app.get<BlobStorage>(BLOB_STORAGE);
      const blobsBeforeStale = await blobCount();
      const putSpy = jest.spyOn(storage, 'put');
      const deleteSpy = jest.spyOn(storage, 'delete');
      let stale: request.Response;
      try {
        stale = await sendStale().expect(412);
        // 412로 롤백되면 업로드한 object를 지우고 Blob row도 남기지 않는다.
        expect(putSpy).toHaveBeenCalledTimes(1);
        expect(deleteSpy).toHaveBeenCalledWith(putSpy.mock.calls[0][0]);
      } finally {
        putSpy.mockRestore();
        deleteSpy.mockRestore();
      }
      expect(await blobCount()).toBe(blobsBeforeStale);
      expect(stale.body.code).toBe('VFS_PRECONDITION_FAILED');
      expect(stale.body.current).toMatchObject({ path: '/x', type: 'FILE', size: 5, revision });
      const replaceKey = randomUUID();
      const replaced = await put(replaceKey, '/x', 'text/plain', Buffer.from('second'), {
        'X-If-Revision': revision,
      }).expect(200);
      expect(replaced.body.resource.path).toBe('/x');
      expect(
        (
          await request(ctx.httpServer)
            .get(`/api/v2/namespaces/${namespaceId}/fs/content`)
            .query({ path: '/x' })
            .expect(200)
        ).text,
      ).toBe('second');
      const blobsBeforeReplay = await blobCount();
      const replayPutSpy = jest.spyOn(storage, 'put');
      let staleReplay: request.Response;
      try {
        staleReplay = await sendStale().expect(412);
        // 412 재생은 body를 hash만 하고 업로드하지 않는다.
        expect(replayPutSpy).not.toHaveBeenCalled();
      } finally {
        replayPutSpy.mockRestore();
      }
      expect(await blobCount()).toBe(blobsBeforeReplay);
      expect(staleReplay.body).toEqual(stale.body);
      // 파일이 교체된 뒤에도 재생된 current.revision은 충돌 시점 revision이다.
      expect(staleReplay.body.current.revision).toBe(revision);
      expect(
        (
          await request(ctx.httpServer)
            .get(`/api/v2/namespaces/${namespaceId}/fs/revision`)
            .query({ path: '/x' })
            .expect(200)
        ).body.revision,
      ).not.toBe(revision);
      expect(staleReplay.headers['x-request-id']).toBe(stale.headers['x-request-id']);
      expect(
        (
          await put(staleKey, '/x', 'text/plain', Buffer.from('second'), {
            'X-If-Revision': revision,
          }).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (
          await put(replaceKey, '/x', 'text/plain', Buffer.from('other'), {
            'X-If-Revision': revision,
          }).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (
          await put(replaceKey, '/x', 'application/octet-stream', Buffer.from('second'), {
            'X-If-Revision': revision,
          }).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (
          await put(replaceKey, '/y', 'text/plain', Buffer.from('second'), {
            'X-If-Revision': revision,
          }).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (
          await put(replaceKey, '/x', 'text/plain', Buffer.from('second'), { 'X-If-Absent': 'true' }).expect(
            409,
          )
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
    });

    it('부모 부재 404를 receipt로 재생해 부모 생성 뒤에도 같은 key는 404를 받는다', async () => {
      const namespaceId = await ctx.createNamespace('conditional-content-parent-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      const key = randomUUID();
      const send = (idempotencyKey = key) =>
        request(ctx.httpServer)
          .post(`${base}/content/conditional`)
          .query({ path: '/parent/x' })
          .set('Idempotency-Key', idempotencyKey)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .set('Content-Type', 'text/plain')
          .send(Buffer.from('content'));
      const missing = await send().expect(404);
      expect(missing.body.code).toBe('VFS_NODE_NOT_FOUND');
      expect(await ctx.migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } })).toBe(
        0,
      );
      await request(ctx.httpServer).post(`${base}/mkdir`).send({ path: '/parent' }).expect(201);
      const replay = await send().expect(404);
      expect(replay.body).toEqual(missing.body);
      expect(replay.headers['x-request-id']).toBe(missing.headers['x-request-id']);
      await send(randomUUID()).expect(201);
    });

    it('requires a condition and does not freeze a 413 response', async () => {
      const namespaceId = await ctx.createNamespace('conditional-content-limit-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
      const key = randomUUID();
      const missing = await request(ctx.httpServer)
        .post(base)
        .query({ path: '/x' })
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', 'caller-a')
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.from('small'))
        .expect(428);
      expect(missing.body.code).toBe('VFS_PRECONDITION_REQUIRED');
      const tooLargeKey = randomUUID();
      const send = (bytes: Buffer) =>
        request(ctx.httpServer)
          .post(base)
          .query({ path: '/big' })
          .set('Idempotency-Key', tooLargeKey)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .set('Content-Type', 'application/octet-stream')
          .send(bytes);
      expect((await send(Buffer.alloc(MAX_FILE_SIZE_BYTES + 1)).expect(413)).body.code).toBe(
        'VFS_FILE_TOO_LARGE',
      );
      expect((await send(Buffer.from('ok')).expect(201)).body.resource.path).toBe('/big');
      const chunkedKey = randomUUID();
      const chunked = await postChunked(
        ctx.serverPort,
        `${base}?path=/chunked`,
        [Buffer.alloc(MAX_FILE_SIZE_BYTES), Buffer.from([1])],
        { 'Idempotency-Key': chunkedKey, 'X-Mutation-Scope': 'caller-a', 'X-If-Absent': 'true' },
      );
      expect(chunked.status).toBe(413);
      // Content-Length 없는 스트리밍 413도 저장되지 않으므로 같은 key의 작은 본문은 새로 평가된다.
      expect(
        await ctx.migrationDataSource
          .getRepository(VfsMutationReceiptEntity)
          .findOneBy({ namespaceId, scope: 'caller-a', idempotencyKey: chunkedKey }),
      ).toBeNull();
      const retried = await postChunked(ctx.serverPort, `${base}?path=/chunked`, [Buffer.from('ok')], {
        'Idempotency-Key': chunkedKey,
        'X-Mutation-Scope': 'caller-a',
        'X-If-Absent': 'true',
      });
      expect(retried.status).toBe(201);
      expect(retried.body).toMatchObject({ resource: { path: '/chunked' } });
    });

    it('renews a short lease while an upload waits for more chunks', async () => {
      const previous = process.env.STORIX_MUTATION_LEASE_SECONDS;
      process.env.STORIX_MUTATION_LEASE_SECONDS = '10';
      const namespaceId = await ctx.createNamespace('conditional-content-renew-ns');
      const key = randomUUID();
      const held = startHeldUpload(
        ctx.serverPort,
        `/api/v2/namespaces/${namespaceId}/fs/content/conditional?path=/held`,
        { 'Idempotency-Key': key, 'X-Mutation-Scope': 'caller-a', 'X-If-Absent': 'true' },
      );
      try {
        held.req.write(Buffer.from('first'));
        let receipt: VfsMutationReceiptEntity | null = null;
        for (let attempt = 0; attempt < 100 && !receipt; attempt += 1) {
          receipt = await ctx.migrationDataSource
            .getRepository(VfsMutationReceiptEntity)
            .findOneBy({ namespaceId, scope: 'caller-a', idempotencyKey: key });
          if (!receipt) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(receipt).not.toBeNull();
        expect(receipt!.leaseExpiresAt!.getTime() - Date.now()).toBeLessThan(12_000);
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        const renewed = await ctx.migrationDataSource
          .getRepository(VfsMutationReceiptEntity)
          .findOneByOrFail({ namespaceId, scope: 'caller-a', idempotencyKey: key });
        expect(renewed.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
        held.req.end(Buffer.from('second'));
        expect((await held.response).status).toBe(201);
      } finally {
        void held.response.catch(() => undefined);
        held.req.destroy();
        if (previous === undefined) delete process.env.STORIX_MUTATION_LEASE_SECONDS;
        else process.env.STORIX_MUTATION_LEASE_SECONDS = previous;
      }
    });

    it('renews a short lease while hashing a malformed conditional content body', async () => {
      const previous = process.env.STORIX_MUTATION_LEASE_SECONDS;
      process.env.STORIX_MUTATION_LEASE_SECONDS = '10';
      let held: ReturnType<typeof startHeldUpload> | undefined;
      try {
        const namespaceId = await ctx.createNamespace('conditional-content-invalid-renew-ns');
        const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
        const key = randomUUID();
        const headers = {
          'Idempotency-Key': key,
          'X-Mutation-Scope': 'caller-a',
          'X-If-Revision': 'bad',
        };
        const body = Buffer.from('firstsecond');
        held = startHeldUpload(ctx.serverPort, `${base}?path=/invalid-held`, headers);
        held.req.write(Buffer.from('first'));

        let receipt: VfsMutationReceiptEntity | null = null;
        for (let attempt = 0; attempt < 100 && !receipt; attempt += 1) {
          receipt = await ctx.migrationDataSource
            .getRepository(VfsMutationReceiptEntity)
            .findOneBy({ namespaceId, scope: 'caller-a', idempotencyKey: key });
          if (!receipt) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(receipt).not.toBeNull();
        expect(receipt!.state).toBe('RESERVED');

        // 해시가 진행되는 동안 원래 lease가 만료됐어야 하는 시간보다 길게 기다린다.
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        const whileHashing = await request(ctx.httpServer)
          .post(base)
          .query({ path: '/invalid-held' })
          .set(headers)
          .set('Content-Type', 'application/octet-stream')
          .send(body)
          .expect(409);
        expect(whileHashing.body.code).toBe('MUTATION_IN_PROGRESS');

        held.req.end(Buffer.from('second'));
        const rejected = await held.response;
        expect(rejected.status).toBe(400);
        expect(rejected.body).toMatchObject({ code: 'VFS_INVALID_REVISION' });
        const replay = await request(ctx.httpServer)
          .post(base)
          .query({ path: '/invalid-held' })
          .set(headers)
          .set('Content-Type', 'application/octet-stream')
          .send(body)
          .expect(400);
        expect(replay.body).toEqual(rejected.body);
        expect(replay.headers['x-request-id']).toBe(rejected.headers['x-request-id']);
      } finally {
        if (held) {
          void held.response.catch(() => undefined);
          held.req.destroy();
        }
        if (previous === undefined) delete process.env.STORIX_MUTATION_LEASE_SECONDS;
        else process.env.STORIX_MUTATION_LEASE_SECONDS = previous;
      }
    });

    it('fences an upload owner whose lease was taken over before commit', async () => {
      const namespaceId = await ctx.createNamespace('conditional-content-fence-ns');
      const key = randomUUID();
      const held = startHeldUpload(
        ctx.serverPort,
        `/api/v2/namespaces/${namespaceId}/fs/content/conditional?path=/fenced`,
        { 'Idempotency-Key': key, 'X-Mutation-Scope': 'caller-a', 'X-If-Absent': 'true' },
      );
      try {
        held.req.write(Buffer.from('first'));
        let receipt: VfsMutationReceiptEntity | null = null;
        for (let attempt = 0; attempt < 100 && !receipt; attempt += 1) {
          receipt = await ctx.migrationDataSource
            .getRepository(VfsMutationReceiptEntity)
            .findOneBy({ namespaceId, scope: 'caller-a', idempotencyKey: key });
          if (!receipt) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(receipt).not.toBeNull();
        await ctx.migrationDataSource
          .getRepository(VfsMutationReceiptEntity)
          .update(
            { namespaceId, scope: 'caller-a', idempotencyKey: key },
            { leaseExpiresAt: new Date(Date.now() - 1000) },
          );
        const takeover = await ctx.app
          .get(VfsMutationReceiptRepository)
          .claim({ namespaceId, scope: 'caller-a', key }, new Date());
        expect(takeover).toEqual({ kind: 'owner', generation: 2 });
        held.req.end(Buffer.from('second'));
        expect((await held.response).status).toBe(500);
        const root = await ctx.migrationDataSource
          .getRepository(VfsNodeEntity)
          .findOneByOrFail({ namespaceId, parentId: IsNull() });
        expect(
          await ctx.migrationDataSource
            .getRepository(VfsNodeEntity)
            .findOneBy({ namespaceId, parentId: root.id, name: 'fenced' }),
        ).toBeNull();
      } finally {
        void held.response.catch(() => undefined);
        held.req.destroy();
      }
    });

    it('serializes same-path conditional creates to one 201 and one 412', async () => {
      const namespaceId = await ctx.createNamespace('conditional-content-race-ns');
      const base = `/api/v2/namespaces/${namespaceId}/fs/content/conditional`;
      const send = (key: string) =>
        request(ctx.httpServer)
          .post(base)
          .query({ path: '/same' })
          .set('Idempotency-Key', key)
          .set('X-Mutation-Scope', 'caller-a')
          .set('X-If-Absent', 'true')
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from('race'));
      const responses = await Promise.all([send(randomUUID()), send(randomUUID())]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 412]);
      expect(await ctx.migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } })).toBe(
        1,
      );
    });
  });
}
