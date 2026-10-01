import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { IdempotencyReceiptRetentionRepository } from '../../src/persistence/idempotency-receipt-retention.repository.js';

export function registerNamespaceReceiptRetentionTests(options: {
  app: () => INestApplication;
  /** receipt의 `created_at`을 `days`일 전으로 바꾼다. */
  backdate: (key: string, days: number) => Promise<void>;
  receiptExists: (key: string) => Promise<boolean>;
}): void {
  describe('namespace receipt 보존 기간', () => {
    const http = () => request(options.app().getHttpServer());
    const create = (name: string, key: string) =>
      http().post('/api/v2/namespaces').set('Idempotency-Key', key).send({ name });
    const prune = () =>
      options.app().get(IdempotencyReceiptRetentionRepository, { strict: false }).pruneExpiredBatch(30, 500);

    it('보존 기간 안의 같은 key·본문 재요청은 최초 201을 재생한다', async () => {
      const first = await create('receipt-fresh', 'receipt-fresh-key').expect(201);
      await options.backdate('receipt-fresh-key', 29);
      expect(await prune()).toBeGreaterThanOrEqual(0);
      const replay = await create('receipt-fresh', 'receipt-fresh-key').expect(201);
      expect(replay.body).toEqual(first.body);
    });

    it('기간이 지나 지워진 뒤 같은 key·본문 재요청은 새 요청으로 처리되어 이름이 있으면 409다', async () => {
      await create('receipt-expired', 'receipt-expired-key').expect(201);
      await options.backdate('receipt-expired-key', 31);
      await prune();
      expect(await options.receiptExists('receipt-expired-key')).toBe(false);

      const again = await create('receipt-expired', 'receipt-expired-key').expect(409);
      expect(again.body.code).toBe('NAMESPACE_ALREADY_EXISTS');
    });

    it('기간이 지난 key를 다른 본문에 재사용하면 422 없이 새 요청으로 처리한다', async () => {
      await create('receipt-reuse-a', 'receipt-reuse-key').expect(201);
      await create('receipt-reuse-b', 'receipt-reuse-key').expect(422);
      await options.backdate('receipt-reuse-key', 31);
      await prune();
      const created = await create('receipt-reuse-b', 'receipt-reuse-key').expect(201);
      expect(created.body.name).toBe('receipt-reuse-b');
    });
  });
}
