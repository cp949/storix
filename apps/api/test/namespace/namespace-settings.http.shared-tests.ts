import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

export function registerNamespaceSettingsHttpTests(options: {
  app: () => INestApplication;
  adminKey: string;
  createNamespace: (name: string, key: string) => Promise<string>;
  markInactive: (namespaceId: string) => Promise<void>;
}): void {
  describe('namespace settings HTTP contract', () => {
    it('부분 설정을 적용하고 재생하며 숫자 null로 기본값을 복원한다', async () => {
      const namespaceId = await options.createNamespace('settings-http', 'settings-create');
      const path = `/api/v2/admin/namespaces/${namespaceId}/settings`;
      const body = {
        maxTotalLogicalBytes: '12345',
        maxFileSizeBytes: '1234',
        maxFilesPerFolder: '12',
        maxNodes: '123',
        maxRetainedTrashBytes: '12000',
        excludeTrashFromQuota: true,
        excludeSnapshotsFromQuota: true,
        trashEnabled: true,
      };
      const changed = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-update')
        .send(body)
        .expect(200);
      expect(changed.body.limits).toMatchObject({
        maxFileSizeBytes: '1234',
        maxFilesPerFolder: '12',
        maxNodes: '123',
      });
      expect(changed.body.quota.limitBytes).toBe('12345');
      expect(changed.body.quota.excludeTrash).toBe(true);
      expect(changed.body.quota.excludeSnapshots).toBe(true);
      expect(changed.body.quota.trash).toMatchObject({ enabled: true, maxRetainedBytes: '12000' });
      const replay = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-update')
        .send(body)
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
      const tooHigh = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-too-large')
        .send({ maxNodes: '9223372036854775807', trashEnabled: false })
        .expect(400);
      expect(tooHigh.body.code).toBe('NAMESPACE_SETTING_EXCEEDS_CEILING');
      const unchanged = await request(options.app().getHttpServer())
        .get(`/api/v2/namespaces/${namespaceId}`)
        .expect(200);
      expect(unchanged.body.quota.trash.enabled).toBe(false);
      const corrected = await request(options.app().getHttpServer())
        .patch(path)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-too-large')
        .send({ trashEnabled: true })
        .expect(200);
      expect(corrected.body.quota.trash.enabled).toBe(true);
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

    it('삭제 상태로 전환된 namespace의 설정 변경을 거부한다', async () => {
      const namespaceId = await options.createNamespace('settings-inactive', 'settings-inactive-create');
      await options.markInactive(namespaceId);
      const response = await request(options.app().getHttpServer())
        .patch(`/api/v2/admin/namespaces/${namespaceId}/settings`)
        .set('Authorization', `Bearer ${options.adminKey}`)
        .set('Idempotency-Key', 'settings-inactive-update')
        .send({ trashEnabled: true })
        .expect(404);
      expect(response.body.code).toBe('NAMESPACE_NOT_FOUND');
    });
  });
}
