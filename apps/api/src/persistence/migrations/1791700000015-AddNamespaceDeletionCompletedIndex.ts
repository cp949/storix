/**
 * 삭제가 끝난 namespace의 보존 만료 후보를 인덱스로 찾는다. 규칙은 api ADR-0035와
 * docs/design/13-namespace-deletion.md "보존과 물리 삭제". 인덱스만 추가한다.
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNamespaceDeletionCompletedIndex1791700000015 implements MigrationInterface {
  name = 'AddNamespaceDeletionCompletedIndex1791700000015';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `CREATE INDEX "idx_namespace_deletion_completed" ON "namespace_deletion" ("completed_at", "namespace_id") WHERE "phase" = 'COMPLETED'`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP INDEX "idx_namespace_deletion_completed"');
  }
}
