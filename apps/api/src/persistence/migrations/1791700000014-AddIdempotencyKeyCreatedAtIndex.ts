/**
 * `idempotency_key` 보존 정리의 후보 조회용 인덱스. 규칙은 api ADR-0034.
 * 인덱스만 추가하며 기존 행은 바꾸지 않는다. 오래된 행은 GC가 예산 안에서 나눠 지운다.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIdempotencyKeyCreatedAtIndex1791700000014 implements MigrationInterface {
  name = 'AddIdempotencyKeyCreatedAtIndex1791700000014';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'CREATE INDEX "idx_idempotency_key_created_at" ON "idempotency_key" ("created_at", "key")',
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX "idx_idempotency_key_created_at"');
  }
}
