/** 실제 HTTP와 DB에서 관리자 인증·삭제 접수·상태 조회·생성 receipt 재생을 검증한다. */
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
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
