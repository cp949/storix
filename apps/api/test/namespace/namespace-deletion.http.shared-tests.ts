/** 실제 HTTP와 DB에서 관리자 인증·삭제 접수·상태 조회·생성 receipt 재생을 검증한다. */
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { VfsTrashRetentionRepository } from '../../src/persistence/vfs-trash-retention.repository.js';
import { VfsNodeRepository } from '../../src/persistence/vfs-node.repository.js';
import { VfsTrashEntity } from '../../src/persistence/entities/vfs-trash.entity.js';
import { VfsUploadSessionRepository } from '../../src/persistence/vfs-upload-session.repository.js';
import { NamespaceEntity } from '../../src/persistence/entities/namespace.entity.js';

/** namespace HTTP suite에 삭제 계약을 등록한다. */
export function registerNamespaceDeletionHttpTests(options: {
  app: () => INestApplication;
  adminKey: string;
  createNamespace: (name: string, key: string) => Promise<string>;
}): void {
  describe('namespace 삭제 HTTP 계약', () => {
    const path = (id: string) => `/api/v2/admin/namespaces/${id}`;
    const create = () => options.createNamespace(`delete-http-${randomUUID()}`, randomUUID());
    const accept = (id: string, key?: string) => {
      const req = request(options.app().getHttpServer())
        .post(`${path(id)}/delete`)
        .set('Authorization', `Bearer ${options.adminKey}`);
      return key === undefined ? req : req.set('Idempotency-Key', key);
    };
    const get = (id: string) =>
      request(options.app().getHttpServer())
        .get(`${path(id)}/deletion`)
        .set('Authorization', `Bearer ${options.adminKey}`);

    // 실제 repository 진입·조회 실패가 안전한 persistence HTTP 오류로 전달되는지 고정한다.
    it.each(['SQLITE_BUSY', 'ECONNRESET'])(
      '삭제 접수의 %s DB 오류는 안전한 503 STORAGE_UNAVAILABLE이다',
      async (code) => {
        const id = await create();
        const failure =
          code === 'SQLITE_BUSY'
            ? { driverError: { code, message: 'private deletion db endpoint' } }
            : Object.assign(new Error('private deletion db endpoint'), { code });
        const spy = jest.spyOn(options.app().get(DataSource), 'transaction').mockRejectedValueOnce(failure);
        try {
          const response = await accept(id, 'db-failure').expect(503);
          expect(response.body.code).toBe('STORAGE_UNAVAILABLE');
          expect(response.body.message).toBe('Storage temporarily unavailable');
          expect(JSON.stringify(response.body)).not.toContain('private deletion db endpoint');
        } finally {
          spy.mockRestore();
        }
      },
    );
    it.each(['SQLITE_BUSY', 'ECONNRESET'])(
      '삭제 상태 조회의 %s DB 오류는 안전한 503 STORAGE_UNAVAILABLE이다',
      async (code) => {
        const id = await create();
        const failure =
          code === 'SQLITE_BUSY'
            ? { driverError: { code, message: 'private deletion db endpoint' } }
            : Object.assign(new Error('private deletion db endpoint'), { code });
        const repository = options.app().get(DataSource).getRepository(NamespaceEntity);
        const spy = jest.spyOn(repository, 'createQueryBuilder').mockImplementationOnce(() => {
          throw failure;
        });
        try {
          const response = await get(id).expect(503);
          expect(response.body.code).toBe('STORAGE_UNAVAILABLE');
          expect(response.body.message).toBe('Storage temporarily unavailable');
          expect(JSON.stringify(response.body)).not.toContain('private deletion db endpoint');
        } finally {
          spy.mockRestore();
        }
      },
    );
    it('service key와 admin 키 미설정은 401이다', async () => {
      const id = await create();
      for (const route of ['delete', 'deletion']) {
        const req =
          route === 'delete'
            ? request(options.app().getHttpServer()).post(`${path(id)}/${route}`)
            : request(options.app().getHttpServer()).get(`${path(id)}/${route}`);
        expect(
          (await req.set('Authorization', 'Bearer service-key').set('Idempotency-Key', 'auth')).status,
        ).toBe(401);
      }
      const config = options.app().get(ConfigService);
      const original = config.get.bind(config);
      const spy = jest
        .spyOn(config, 'get')
        .mockImplementation((key: string) => (key === 'STORIX_ADMIN_API_KEY' ? undefined : original(key)));
      try {
        await accept(id, 'no-admin').expect(401);
        await get(id).expect(401);
      } finally {
        spy.mockRestore();
      }
    });
    it('키 누락은 400 IDEMPOTENCY_KEY_REQUIRED, 256 byte 키와 body 동반은 400 NAMESPACE_INVALID_DELETE_REQUEST다', async () => {
      const id = await create();
      expect((await accept(id).expect(400)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await accept(id, '').expect(400)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
      expect((await accept(id, 'x'.repeat(256)).expect(400)).body.code).toBe(
        'NAMESPACE_INVALID_DELETE_REQUEST',
      );
      expect((await accept(id, 'body').send({}).expect(400)).body.code).toBe(
        'NAMESPACE_INVALID_DELETE_REQUEST',
      );
      expect((await accept(id, 'chunked').set('Transfer-Encoding', 'chunked').expect(400)).body.code).toBe(
        'NAMESPACE_INVALID_DELETE_REQUEST',
      );
    });
    // Node는 헤더 값을 latin1로 읽으므로 한글 85자(UTF-8 255 byte)는 서버에서 255자 문자열이 된다.
    it('Idempotency-Key는 헤더로 전송된 byte 수 기준 255 byte까지 허용한다', async () => {
      const id = await create();
      const wire = (text: string) => Buffer.from(text, 'utf8').toString('latin1');
      await accept(id, wire('한'.repeat(86))).expect(400);
      await accept(id, wire('한'.repeat(85))).expect(202);
    });
    it('잘못된 UUID와 없는 namespace는 404 NAMESPACE_NOT_FOUND다', async () => {
      for (const id of ['invalid', randomUUID()]) {
        expect((await accept(id, 'missing').expect(404)).body.code).toBe('NAMESPACE_NOT_FOUND');
        expect((await get(id).expect(404)).body.code).toBe('NAMESPACE_NOT_FOUND');
      }
    });
    it('접수는 202와 Location·Cache-Control을 반환하고 상태 조회는 DELETING·UPLOADS를 반환한다', async () => {
      const id = await create();
      const result = await accept(id, 'accepted').expect(202);
      expect(result.body).toEqual({ namespaceId: id, status: 'DELETING' });
      expect(result.headers.location).toBe(`${path(id)}/deletion`);
      expect(result.headers['cache-control']).toBe('no-store');
      const status = await get(id).expect(200);
      expect(status.headers['cache-control']).toBe('no-store');
      expect(status.body).toEqual({
        namespaceId: id,
        status: 'DELETING',
        phase: 'UPLOADS',
        requestedAt: expect.any(String),
        completedAt: null,
        blockedReason: null,
      });
      expect(new Date(status.body.requestedAt).toISOString()).toBe(status.body.requestedAt);
    });
    it('ACTIVE이고 삭제 요청이 없으면 상태 조회는 404 NAMESPACE_DELETION_NOT_FOUND다', async () => {
      expect((await get(await create()).expect(404)).body.code).toBe('NAMESPACE_DELETION_NOT_FOUND');
    });
    it('같은 키 재요청은 202 body를 재생하고 Location을 다시 만든다', async () => {
      const id = await create();
      const first = await accept(id, 'replay').expect(202);
      const replay = await accept(id, 'replay').expect(202);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers.location).toBe(first.headers.location);
      expect(replay.headers['cache-control']).toBe('no-store');
    });
    it('예전 생성 키는 삭제 대상 UUID를 재생하고 새 생성 키는 새 UUID를 만든다', async () => {
      const name = `delete-recreate-${randomUUID()}`;
      const key = randomUUID();
      const id = await options.createNamespace(name, key);
      await accept(id, 'delete-recreate').expect(202);
      expect(await options.createNamespace(name, key)).toBe(id);
      expect(await options.createNamespace(name, randomUUID())).not.toBe(id);
    });
  });
}

/** 실제 DB에 모든 데이터 경로를 준비한 뒤 삭제 접수의 접근 차단을 검증한다. */
export function registerNamespaceDeletionAccessHttpTests(options: {
  app: () => INestApplication;
  namespace: () => string;
  adminKey: string;
  serviceKey: string;
}): void {
  describe('삭제 접수 뒤 데이터 접근 차단', () => {
    const api = () =>
      request.agent(options.app().getHttpServer()).set('Authorization', `Bearer ${options.serviceKey}`);
    const base = () => `/api/v2/namespaces/${options.namespace()}/fs`;
    const admin = (call: request.Test) => call.set('Authorization', `Bearer ${options.adminKey}`);
    const conditionalKey = randomUUID();
    const quotaKey = randomUUID();
    const trashKey = randomUUID();
    const command = { kind: 'mkdir', path: '/conditional', ifAbsent: true };
    const mutate = () =>
      api()
        .post(`${base()}/mutations`)
        .set('X-Mutation-Scope', 'deletion')
        .set('Idempotency-Key', conditionalKey)
        .send(command);
    const quota = () =>
      admin(api().patch(`/api/v2/admin/namespaces/${options.namespace()}/quota`))
        .set('Idempotency-Key', quotaKey)
        .send({ maxTotalLogicalBytes: '100000' });
    const trashPolicy = () =>
      admin(api().patch(`/api/v2/admin/namespaces/${options.namespace()}/trash`))
        .set('Idempotency-Key', trashKey)
        .send({ enabled: true });
    let fileId: string;
    let snapshotId: string;
    let sessionId: string;
    let completedId: string;
    let cursor: string;
    beforeAll(async () => {
      await quota().expect(200);
      await trashPolicy().expect(200);
      await api()
        .post(`${base()}/content`)
        .query({ path: '/file' })
        .set('Content-Type', 'text/plain')
        .send('abc')
        .expect(201);
      const stat = (await api().get(`${base()}/stat`).query({ path: '/file' }).expect(200)).body;
      fileId = stat.id;
      snapshotId = (
        await api()
          .post(`${base()}/snapshots`)
          .set('X-Mutation-Scope', 'deletion')
          .set('Idempotency-Key', randomUUID())
          .send({ kind: 'file', path: '/file' })
          .expect(201)
      ).body.snapshotId;
      await api()
        .post(`${base()}/content`)
        .query({ path: '/trash-file' })
        .set('Content-Type', 'text/plain')
        .send('trash')
        .expect(201);
      await api().post(`${base()}/rm`).query({ path: '/trash-file' }).expect(204);
      await mutate().expect(201);
      cursor = (await api().get(`${base()}/changes`).expect(200)).body.nextCursor;
      const uploads = options.app().get(VfsUploadSessionRepository);
      const caps = {
        global: { maxStagedBytes: 100000n, maxActiveSessions: 100 },
        namespace: { maxStagedBytes: 100000n, maxActiveSessions: 100 },
      };
      for (const path of ['/upload', '/completed']) {
        const row = {
          id: randomUUID(),
          namespaceId: options.namespace(),
          scope: 'deletion',
          creationKey: randomUUID(),
          fingerprint: 'a'.repeat(64),
          targetPath: path,
          sizeBytes: path === '/upload' ? '1' : '0',
          mimeType: 'text/plain',
          conditionType: 'ABSENT' as const,
          conditionRevision: null,
          fileExpiresInSeconds: null,
          partSizeBytes: 1,
          partCount: path === '/upload' ? 1 : 0,
          now: new Date(),
          expiresAt: new Date(Date.now() + 60000),
          maxExpiresAt: new Date(Date.now() + 120000),
        };
        await uploads.createSession(row, caps);
        if (path === '/upload') sessionId = row.id;
        else {
          completedId = row.id;
          await api().post(`${base()}/upload-sessions/${completedId}/complete`).expect(201);
        }
      }
      await api()
        .get(`/api/v2/public/${options.namespace()}/fs/content`)
        .query({ path: '/file' })
        .expect(200);
      await admin(api().post(`/api/v2/admin/namespaces/${options.namespace()}/delete`))
        .set('Idempotency-Key', 'access-block')
        .expect(202);
    });
    const blocked = async (call: request.Test) => {
      expect((await call.expect(404)).body.code).toBe('NAMESPACE_NOT_FOUND');
    };
    it('DELETING namespace의 stat·ls·content·download·presigned 발급은 404다', async () => {
      for (const route of ['stat', 'ls', 'content', 'download', 'presigned-download'])
        await blocked(
          api()
            .get(`${base()}/${route}`)
            .query({ path: route === 'ls' ? '/' : '/file' }),
        );
    });
    it('DELETING namespace의 PUBLIC content·download는 404다', async () => {
      for (const route of ['content', 'download'])
        await blocked(
          api()
            .get(`/api/v2/public/${options.namespace()}/fs/${route}`)
            .unset('Authorization')
            .query({ path: '/file' }),
        );
    });
    it('DELETING namespace의 snapshot·trash·change-feed·capability 조회는 404다', async () => {
      for (const route of [
        `snapshots?rootNodeId=${fileId}`,
        `snapshots/${snapshotId}`,
        `snapshots/${snapshotId}/content`,
        'trash',
        'changes',
        `changes?cursor=${encodeURIComponent(cursor)}`,
      ])
        await blocked(api().get(`${base()}/${route}`));
      await blocked(api().get(`/api/v2/namespaces/${options.namespace()}/capabilities`));
    });
    it('DELETING namespace의 conditional mutation 완료 receipt 재생은 404다', async () => {
      await blocked(mutate());
    });
    it('DELETING namespace의 quota·trash 관리자 receipt 재생은 404다', async () => {
      await blocked(quota());
      await blocked(trashPolicy());
    });
    it('DELETING namespace의 upload session 생성·조각 PUT·complete·GET·DELETE는 404다', async () => {
      await blocked(
        api()
          .post(`${base()}/upload-sessions`)
          .set('X-Mutation-Scope', 'deletion')
          .set('Idempotency-Key', randomUUID())
          .send({ path: '/new-upload', sizeBytes: '1', mimeType: 'text/plain', ifAbsent: true }),
      );
      await blocked(
        api()
          .put(`${base()}/upload-sessions/${sessionId}/parts/0`)
          .set('Content-Type', 'application/octet-stream')
          .send(Buffer.from('x')),
      );
      await blocked(api().post(`${base()}/upload-sessions/${sessionId}/complete`));
      await blocked(api().get(`${base()}/upload-sessions/${sessionId}`));
      await blocked(api().delete(`${base()}/upload-sessions/${sessionId}`));
    });
    it('DELETING namespace의 완료된 upload session complete 재요청은 404다', async () => {
      await blocked(api().post(`${base()}/upload-sessions/${completedId}/complete`));
    });
    it('namespace 상세 GET은 DELETING status를 200으로 반환하고 목록에서는 빠진다', async () => {
      expect((await api().get(`/api/v2/namespaces/${options.namespace()}`).expect(200)).body.status).toBe(
        'DELETING',
      );
      const list = (await api().get('/api/v2/namespaces').expect(200)).body;
      expect(list.some((row: { id: string }) => row.id === options.namespace())).toBe(false);
    });
    it('DELETING namespace의 만료 휴지통은 보존 정리가 건너뛴다', async () => {
      const db = options.app().get(DataSource);
      await db.getRepository(VfsTrashEntity).update(
        { namespaceId: options.namespace() },
        {
          deletedAt: new Date('1999-01-01T00:00:00.000Z'),
          expiresAt: new Date('2000-01-01T00:00:00.000Z'),
        },
      );
      const retention = new VfsTrashRetentionRepository(db, options.app().get(VfsNodeRepository));
      expect(await retention.pruneExpiredBatch(500)).toEqual({ items: 0, nodes: 0, bytes: '0' });
      expect(await db.getRepository(VfsTrashEntity).countBy({ namespaceId: options.namespace() })).toBe(1);
    });
  });
}
