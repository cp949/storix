/**
 * 시작 시 ENCRYPTED namespace 존재 여부를 namespace 수와 무관하게 확인하는 부분 인덱스.
 * 규칙은 api ADR-0001(namespace 암호화 정책은 생성 시 고정)과 `EncryptionBootGuard`.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNamespaceEncryptedIndex1791700000013 implements MigrationInterface {
  name = 'AddNamespaceEncryptedIndex1791700000013';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `CREATE INDEX "idx_namespace_encrypted" ON "namespace" ("id") WHERE "encryption_policy" = 'ENCRYPTED'`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX "idx_namespace_encrypted"');
  }
}
