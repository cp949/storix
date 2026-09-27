import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNamespaceTrashEnabled1791700000009 implements MigrationInterface {
  name = 'AddNamespaceTrashEnabled1791700000009';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "namespace" ADD COLUMN "trash_enabled" BOOLEAN NOT NULL DEFAULT FALSE');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "namespace" DROP COLUMN "trash_enabled"');
  }
}
