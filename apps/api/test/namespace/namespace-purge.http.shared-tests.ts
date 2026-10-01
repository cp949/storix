import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { NamespacePurgeRepository } from '../../src/persistence/namespace-purge.repository.js';

export function registerNamespacePurgeHttpTests(options: {
  app: () => INestApplication;
  adminKey: string;
  createNamespace: (name: string, key: string) => Promise<string>;
  /** 삭제 접수된 namespace를 완료 상태(DELETED, root 제거, COMPLETED)로 `days`일 전에 끝난 것으로 만든다. */
  forceCompleted: (namespaceId: string, days: number) => Promise<void>;
}): void {
  describe('삭제 완료 namespace의 물리 삭제', () => {
    const http = () => request(options.app().getHttpServer());
    const admin = { Authorization: `Bearer ${options.adminKey}` };
    const purge = () =>
      options.app().get(NamespacePurgeRepository, { strict: false }).purgeNext(30, null, 100);

    function accept(id: string, key: string) {
      return http().post(`/api/v2/admin/namespaces/${id}/delete`).set(admin).set('Idempotency-Key', key);
    }

    it('보존 기간 안에서는 DELETED 조회와 삭제 재요청 재생이 계속된다', async () => {
      const id = await options.createNamespace('purge-http-recent', 'purge-http-recent-create');
      await accept(id, 'purge-http-recent-del').expect(202);
      await options.forceCompleted(id, 29);
      await purge();

      expect((await http().get(`/api/v2/namespaces/${id}`).expect(200)).body.status).toBe('DELETED');
      await http().get(`/api/v2/admin/namespaces/${id}/deletion`).set(admin).expect(200);
      expect((await accept(id, 'purge-http-recent-del').expect(202)).body).toMatchObject({ namespaceId: id });
    });

    it('보존 기간이 지나 물리 삭제되면 조회·삭제 상태·삭제 재요청은 모두 404고 이름을 다시 쓸 수 있다', async () => {
      const id = await options.createNamespace('purge-http-old', 'purge-http-old-create');
      await accept(id, 'purge-http-old-del').expect(202);
      await options.forceCompleted(id, 31);
      expect((await purge()).purged).toBeGreaterThanOrEqual(1);

      expect((await http().get(`/api/v2/namespaces/${id}`).expect(404)).body.code).toBe(
        'NAMESPACE_NOT_FOUND',
      );
      expect(
        (await http().get(`/api/v2/admin/namespaces/${id}/deletion`).set(admin).expect(404)).body.code,
      ).toBe('NAMESPACE_NOT_FOUND');
      expect((await accept(id, 'purge-http-old-del').expect(404)).body.code).toBe('NAMESPACE_NOT_FOUND');
      const again = await options.createNamespace('purge-http-old', 'purge-http-old-create-2');
      expect(again).not.toBe(id);
    });
  });
}
