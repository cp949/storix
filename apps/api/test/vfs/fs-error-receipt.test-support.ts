import type { FsHttpContext } from './fs-http-fixture.test-support.js';
import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Client as MinioClient, S3Error } from 'minio';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { BlobEntity } from '../../src/persistence/entities/blob.entity.js';
import { VfsNodeEntity } from '../../src/persistence/entities/vfs-node.entity.js';
import { VfsMutationReceiptEntity } from '../../src/persistence/entities/vfs-mutation-receipt.entity.js';
import { VfsMutationReceiptRepository } from '../../src/persistence/vfs-mutation-receipt.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { STORAGE_CLIENT } from '../../src/storage/storage.constants.js';
import { encodeRevision } from '../../src/vfs/revision.js';
import { withoutStatHash, InjectedUnavailableError } from './fs-http-fixture.test-support.js';

export function registerFsErrorReceiptContract(ctx: FsHttpContext) {
  describe('결정적 4xx 오류 receipt', () => {
    const scope = 'error-receipt';
    const mutate = (namespaceId: string, key: string, body: string) =>
      request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/mutations`)
        .set('Content-Type', 'application/json')
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', scope)
        .send(body);
    const upload = (
      namespaceId: string,
      key: string,
      path: string,
      headers: Record<string, string>,
      bytes = Buffer.from('body'),
    ) => {
      let call = request(ctx.httpServer)
        .post(`/api/v2/namespaces/${namespaceId}/fs/content/conditional`)
        .query({ path })
        .set('Idempotency-Key', key)
        .set('X-Mutation-Scope', scope)
        .set('Content-Type', 'application/octet-stream');
      for (const [name, value] of Object.entries(headers)) call = call.set(name, value);
      return call.send(bytes);
    };
    const receiptOf = (namespaceId: string, key: string) =>
      ctx.migrationDataSource
        .getRepository(VfsMutationReceiptEntity)
        .findOneBy({ namespaceId, scope, idempotencyKey: key });

    it('미분류·분류된 DB 5xx는 receipt 없이 같은 key에서 재평가하고 한 번만 변경한다', async () => {
      const namespaceId = await ctx.createNamespace('error-receipt-transient');
      const nodes = ctx.app.get(VfsNodeRepository);
      const jsonKey = randomUUID();
      const jsonBody = '{"kind":"mkdir","path":"/a","ifAbsent":true}';
      const jsonSpy = jest
        .spyOn(nodes, 'applyConditionalMutation')
        .mockRejectedValueOnce(new Error('injected database failure'))
        .mockRejectedValueOnce(new InjectedUnavailableError())
        .mockRejectedValueOnce({ driverError: { code: '08006', message: 'private database endpoint' } });
      try {
        expect((await mutate(namespaceId, jsonKey, jsonBody).expect(500)).body.code).toBe('INTERNAL_ERROR');
        expect(await receiptOf(namespaceId, jsonKey)).toBeNull();
        await mutate(namespaceId, jsonKey, jsonBody).expect(503);
        expect(await receiptOf(namespaceId, jsonKey)).toBeNull();
        const unavailable = await mutate(namespaceId, jsonKey, jsonBody).expect(503);
        expect(unavailable.body).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
        expect(JSON.stringify(unavailable.body)).not.toContain('private database endpoint');
        expect(await receiptOf(namespaceId, jsonKey)).toBeNull();
      } finally {
        jsonSpy.mockRestore();
      }
      const created = await mutate(namespaceId, jsonKey, jsonBody).expect(201);
      expect(created.body.resource.path).toBe('/a');
      const replay = await mutate(namespaceId, jsonKey, jsonBody).expect(201);
      expect(replay.body).toEqual(created.body);
      expect(await receiptOf(namespaceId, jsonKey)).toMatchObject({ state: 'COMPLETE' });
      expect(
        await ctx.migrationDataSource.getRepository(VfsNodeEntity).countBy({ namespaceId, name: 'a' }),
      ).toBe(1);

      const uploadKey = randomUUID();
      const contentSpy = jest
        .spyOn(nodes, 'putConditionalContent')
        .mockRejectedValueOnce(new Error('injected database failure'));
      try {
        await upload(namespaceId, uploadKey, '/a/file', { 'X-If-Absent': 'true' }).expect(500);
      } finally {
        contentSpy.mockRestore();
      }
      expect(await receiptOf(namespaceId, uploadKey)).toBeNull();
      expect(await ctx.migrationDataSource.getRepository(BlobEntity).count({ where: { namespaceId } })).toBe(
        0,
      );
      expect(
        (await upload(namespaceId, uploadKey, '/a/file', { 'X-If-Absent': 'true' }).expect(201)).body.resource
          .path,
      ).toBe('/a/file');
    });

    it('MinIO SDK 일시·영구 실패는 안전한 코드로 응답하고 일시 실패는 같은 key로 성공한다', async () => {
      const namespaceId = await ctx.createNamespace('error-receipt-blob-sdk');
      const client = ctx.app.get<MinioClient>(STORAGE_CLIENT);
      const putSpy = jest.spyOn(client, 'putObject');
      const transientKey = randomUUID();
      const permanentKey = randomUUID();
      try {
        putSpy.mockRejectedValueOnce(
          Object.assign(new Error('private blob endpoint'), { code: 'ECONNRESET' }),
        );
        const transient = await upload(namespaceId, transientKey, '/transient', {
          'X-If-Absent': 'true',
        }).expect(503);
        expect(transient.body).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
        expect(JSON.stringify(transient.body)).not.toContain('private blob endpoint');
        expect(await receiptOf(namespaceId, transientKey)).toBeNull();
        expect(await ctx.migrationDataSource.getRepository(BlobEntity).countBy({ namespaceId })).toBe(0);
        putSpy.mockRestore();

        const created = await upload(namespaceId, transientKey, '/transient', {
          'X-If-Absent': 'true',
        }).expect(201);
        expect(created.body.resource.path).toBe('/transient');
        expect(
          (await upload(namespaceId, transientKey, '/transient', { 'X-If-Absent': 'true' }).expect(201)).body,
        ).toEqual(created.body);
        expect(await receiptOf(namespaceId, transientKey)).toMatchObject({ state: 'COMPLETE' });
        expect(
          await ctx.migrationDataSource
            .getRepository(VfsNodeEntity)
            .countBy({ namespaceId, name: 'transient' }),
        ).toBe(1);

        const permanentSpy = jest
          .spyOn(client, 'putObject')
          .mockRejectedValueOnce(Object.assign(new S3Error('private object key'), { code: 'AccessDenied' }));
        try {
          const permanent = await upload(namespaceId, permanentKey, '/permanent', {
            'X-If-Absent': 'true',
          }).expect(500);
          expect(permanent.body).toMatchObject({ code: 'STORAGE_FAILURE' });
          expect(JSON.stringify(permanent.body)).not.toContain('private object key');
          expect(await receiptOf(namespaceId, permanentKey)).toBeNull();
        } finally {
          permanentSpy.mockRestore();
        }
      } finally {
        putSpy.mockRestore();
      }
    });

    it('진행 중 claim은 응답을 저장하지 않고 lease 만료 뒤 같은 key로 처리한다', async () => {
      // lease를 5초로 두고 claim 직후 요청해 busy 판정까지 5초 여유를 둔다.
      // 만료 대기는 저장된 lease 만료 시각을 기준으로 계산해 시계 지연에 흔들리지 않는다.
      const previous = process.env.STORIX_MUTATION_LEASE_SECONDS;
      process.env.STORIX_MUTATION_LEASE_SECONDS = '5';
      try {
        const namespaceId = await ctx.createNamespace('error-receipt-in-progress');
        const key = randomUUID();
        const body = '{"kind":"mkdir","path":"/a","ifAbsent":true}';
        await ctx.app.get(VfsMutationReceiptRepository).claim({ namespaceId, scope, key }, new Date());
        const busy = await mutate(namespaceId, key, body).expect(409);
        expect(busy.body.code).toBe('MUTATION_IN_PROGRESS');
        const reserved = await receiptOf(namespaceId, key);
        expect(reserved).toMatchObject({
          state: 'RESERVED',
          generation: 1,
          responseStatus: null,
          responseBody: null,
        });
        const waitMs = reserved!.leaseExpiresAt!.getTime() - Date.now() + 300;
        await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 0)));
        const accepted = await mutate(namespaceId, key, body).expect(201);
        expect(await receiptOf(namespaceId, key)).toMatchObject({
          state: 'COMPLETE',
          generation: 2,
          responseStatus: 201,
        });
        expect((await mutate(namespaceId, key, body).expect(201)).body).toEqual(accepted.body);
      } finally {
        if (previous === undefined) delete process.env.STORIX_MUTATION_LEASE_SECONDS;
        else process.env.STORIX_MUTATION_LEASE_SECONDS = previous;
      }
    });

    it('content의 잘못된 조건 헤더 조합과 원본 경로는 같은 key에서 서로의 오류를 재생하지 않는다', async () => {
      const namespaceId = await ctx.createNamespace('error-receipt-content-headers');
      const missingKey = randomUUID();
      const missing = await upload(namespaceId, missingKey, '/x', {}).expect(428);
      expect(missing.body.code).toBe('VFS_PRECONDITION_REQUIRED');
      for (const headers of [{ 'X-If-Absent': 'false' }, { 'X-If-Revision': 'bad' }] as Record<
        string,
        string
      >[]) {
        expect((await upload(namespaceId, missingKey, '/x', headers).expect(409)).body.code).toBe(
          'MUTATION_KEY_REUSED',
        );
      }
      const missingReplay = await upload(namespaceId, missingKey, '/x', {}).expect(428);
      expect(missingReplay.body).toEqual(missing.body);
      expect(missingReplay.headers['x-request-id']).toBe(missing.headers['x-request-id']);

      const invalidKey = randomUUID();
      const invalid = await upload(namespaceId, invalidKey, '/x', { 'X-If-Absent': 'yes' }).expect(400);
      expect(invalid.body.code).toBe('VFS_INVALID_MUTATION_REQUEST');
      for (const headers of [
        { 'X-If-Absent': 'false' },
        { 'X-If-Absent': 'true', 'X-If-Revision': encodeRevision({ id: randomUUID(), version: 1 }) },
        { 'X-If-Revision': 'bad' },
      ] as Record<string, string>[]) {
        expect((await upload(namespaceId, invalidKey, '/x', headers).expect(409)).body.code).toBe(
          'MUTATION_KEY_REUSED',
        );
      }
      expect(
        (await upload(namespaceId, invalidKey, '/x', { 'X-If-Absent': 'yes' }).expect(400)).body,
      ).toEqual(invalid.body);

      const pathKey = randomUUID();
      const nfd = await upload(namespaceId, pathKey, '/e\u0301', { 'X-If-Absent': 'true' }).expect(400);
      expect(nfd.body.code).toBe('VFS_INVALID_PATH');
      expect(
        (await upload(namespaceId, pathKey, '/a\u0301', { 'X-If-Absent': 'true' }).expect(409)).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (await upload(namespaceId, pathKey, '/e\u0301', { 'X-If-Absent': 'true' }).expect(400)).body,
      ).toEqual(nfd.body);
    });

    it('JSON mutation·content·snapshot 오류 receipt를 PostgreSQL 앱 재시작 뒤 최초 body와 X-Request-Id로 재생한다', async () => {
      const namespaceId = await ctx.createNamespace('error-receipt-pg-restart');
      const base = `/api/v2/namespaces/${namespaceId}/fs`;
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/doc' })
        .set('Content-Type', 'text/plain')
        .send('first')
        .expect(201);
      const staleRevision = encodeRevision({ id: randomUUID(), version: 1 });
      const statAtConflict = (
        await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/doc' }).expect(200)
      ).body;
      const revisionAtConflict = (
        await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/doc' }).expect(200)
      ).body.revision as string;
      const expectedCurrent = { ...withoutStatHash(statAtConflict), revision: revisionAtConflict };
      const jsonKey = randomUUID();
      const jsonBody = JSON.stringify({ kind: 'delete', path: '/doc', ifRevision: staleRevision });
      const jsonFailed = await mutate(namespaceId, jsonKey, jsonBody).expect(412);
      expect(jsonFailed.body.current).toEqual(expectedCurrent);
      const uploadKey = randomUUID();
      const uploadFailed = await upload(namespaceId, uploadKey, '/doc', { 'X-If-Absent': 'true' }).expect(
        412,
      );
      expect(uploadFailed.body.current).toEqual(expectedCurrent);
      const snapshotKey = randomUUID();
      const snapshotBody = '{"kind":"file","path":"/missing"}';
      const snapshotRequest = () =>
        request(ctx.httpServer)
          .post(`${base}/snapshots`)
          .set('Content-Type', 'application/json')
          .set('Idempotency-Key', snapshotKey)
          .set('X-Mutation-Scope', scope)
          .send(snapshotBody);
      const snapshotFailed = await snapshotRequest().expect(404);

      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/doc', force: true })
        .set('Content-Type', 'text/plain')
        .send('changed after the conflict')
        .expect(200);
      await request(ctx.httpServer)
        .post(`${base}/content`)
        .query({ path: '/missing' })
        .set('Content-Type', 'text/plain')
        .send('now present')
        .expect(201);
      const oldDataSource = ctx.app.get(DataSource);
      await ctx.app.close();
      expect(oldDataSource.isInitialized).toBe(false);
      await ctx.bootstrap();

      for (const [send, original] of [
        [() => mutate(namespaceId, jsonKey, jsonBody), jsonFailed],
        [() => upload(namespaceId, uploadKey, '/doc', { 'X-If-Absent': 'true' }), uploadFailed],
        [snapshotRequest, snapshotFailed],
      ] as const) {
        const replay = await send().expect(original.status);
        expect(replay.body).toEqual(original.body);
        expect(replay.headers['x-request-id']).toBe(original.headers['x-request-id']);
      }
      expect(jsonFailed.body.current.revision).toBe(revisionAtConflict);
      expect(
        (await request(ctx.httpServer).get(`${base}/stat`).query({ path: '/doc' }).expect(200)).body,
      ).not.toEqual(statAtConflict);
      expect(
        (await request(ctx.httpServer).get(`${base}/revision`).query({ path: '/doc' }).expect(200)).body
          .revision,
      ).not.toBe(revisionAtConflict);
      expect(
        (
          await mutate(
            namespaceId,
            jsonKey,
            JSON.stringify({ kind: 'delete', path: '/doc', ifRevision: 'x' }),
          ).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
      expect(
        (
          await upload(
            namespaceId,
            uploadKey,
            '/doc',
            { 'X-If-Absent': 'true' },
            Buffer.from('other'),
          ).expect(409)
        ).body.code,
      ).toBe('MUTATION_KEY_REUSED');
    });
  });
}
