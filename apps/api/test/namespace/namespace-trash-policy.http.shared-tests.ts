import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

export function registerNamespaceTrashPolicyHttpTests(options: {
  app: () => INestApplication;
  adminKey: string;
  createNamespace: (name: string, key: string) => Promise<string>;
}): void {
  describe('namespace trash policy HTTP contract', () => {
    it('기본 OFF를 반환하고 관리자가 ON/OFF를 변경하며 동일 key 응답을 재생한다', async () => {
      const namespaceId = await options.createNamespace('trash-policy-http', 'trash-policy-create');
      const path = `/api/v2/admin/namespaces/${namespaceId}/trash`;
      const initial = await request(options.app().getHttpServer())
        .get(`/api/v2/namespaces/${namespaceId}`)
        .expect(200);
      expect(initial.body.quota.trash.enabled).toBe(false);

      await request(options.app().getHttpServer()).patch(path).send({ enabled: true }).expect(401);
      const enabled = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'trash-policy-enable')
        .send({ enabled: true })
        .expect(200);
      expect(enabled.body.quota.trash.enabled).toBe(true);
      const replay = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'trash-policy-enable')
        .send({ enabled: true })
        .expect(200);
      expect(replay.body).toEqual(enabled.body);
      const disabled = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'trash-policy-disable')
        .send({ enabled: false })
        .expect(200);
      expect(disabled.body.quota.trash.enabled).toBe(false);
    });

    it('Idempotency-Key는 255 byte까지 받고 256 byte는 400 IDEMPOTENCY_KEY_REQUIRED다', async () => {
      const namespaceId = await options.createNamespace(
        'trash-policy-key-length',
        'trash-policy-key-length-create',
      );
      const path = `/api/v2/admin/namespaces/${namespaceId}/trash`;
      await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'k'.repeat(255))
        .send({ enabled: true })
        .expect(200);
      const rejected = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'k'.repeat(256))
        .send({ enabled: false })
        .expect(400);
      expect(rejected.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('잘못된 body는 400, 없는 namespace는 404, 다른 body의 key 재사용은 422다', async () => {
      const namespaceId = await options.createNamespace('trash-policy-errors', 'trash-policy-errors-create');
      const path = `/api/v2/admin/namespaces/${namespaceId}/trash`;
      await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'trash-policy-invalid')
        .send({ enabled: 'true' })
        .expect(400);
      await request(options.app().getHttpServer())
        .patch('/api/v2/admin/namespaces/00000000-0000-4000-8000-000000000001/trash')
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'trash-policy-missing')
        .send({ enabled: true })
        .expect(404);
      await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'trash-policy-reused')
        .send({ enabled: true })
        .expect(200);
      const reused = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'trash-policy-reused')
        .send({ enabled: false })
        .expect(422);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });
}
