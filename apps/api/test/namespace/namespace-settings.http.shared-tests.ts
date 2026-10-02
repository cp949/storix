import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

export function registerNamespaceSettingsHttpTests(options: {
  app: () => INestApplication;
  adminKey: string;
  createNamespace: (name: string, key: string) => Promise<string>;
}): void {
  describe('namespace settings HTTP contract', () => {
    it('부분 설정을 적용하고 재생하며 숫자 null로 기본값을 복원한다', async () => {
      const namespaceId = await options.createNamespace('settings-http', 'settings-create');
      const path = `/api/v2/admin/namespaces/${namespaceId}/settings`;
      const changed = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-update')
        .send({ maxNodes: '123', excludeTrashFromQuota: true })
        .expect(200);
      expect(changed.body.limits.maxNodes).toBe('123');
      expect(changed.body.quota.excludeTrash).toBe(true);
      const replay = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-update')
        .send({ maxNodes: '123', excludeTrashFromQuota: true })
        .expect(200);
      expect(replay.body).toEqual(changed.body);
      await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-clear')
        .send({ maxNodes: null })
        .expect(200);
    });

    it('인증·body·상한·멱등성 오류를 구분한다', async () => {
      const namespaceId = await options.createNamespace('settings-errors', 'settings-errors-create');
      const path = `/api/v2/admin/namespaces/${namespaceId}/settings`;
      await request(options.app().getHttpServer()).patch(path).send({ trashEnabled: true }).expect(401);
      for (const body of [{}, { unknown: true }, { maxNodes: '0' }, { trashEnabled: null }]) {
        await request(options.app().getHttpServer())
          .patch(path)
          .set('Authorization', `Bearer ${options.adminKey}`)
          .set('Idempotency-Key', `settings-invalid-${JSON.stringify(body)}`)
          .send(body)
          .expect(400);
      }
      await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-too-large')
        .send({ maxNodes: '9223372036854775807' })
        .expect(400);
      await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-reused')
        .send({ trashEnabled: true })
        .expect(200);
      const reused = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-reused')
        .send({ trashEnabled: false })
        .expect(422);
      expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });
}
