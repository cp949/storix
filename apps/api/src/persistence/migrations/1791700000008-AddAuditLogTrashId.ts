import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuditLogTrashId1791700000008 implements MigrationInterface {
  name = 'AddAuditLogTrashId1791700000008';

  async up(runner: QueryRunner): Promise<void> {
    const type = runner.connection.options.type === 'better-sqlite3' ? 'varchar(36)' : 'uuid';
    await runner.query(`ALTER TABLE "audit_log" ADD COLUMN "trash_id" ${type}`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "audit_log" DROP COLUMN "trash_id"');
  }
}
