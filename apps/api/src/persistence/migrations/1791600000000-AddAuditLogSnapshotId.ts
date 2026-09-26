import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuditLogSnapshotId1791600000000 implements MigrationInterface {
  name = 'AddAuditLogSnapshotId1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const type = queryRunner.connection.options.type === 'better-sqlite3' ? 'varchar(36)' : 'uuid';
    await queryRunner.query(`ALTER TABLE "audit_log" ADD COLUMN "snapshot_id" ${type}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "audit_log" DROP COLUMN "snapshot_id"');
  }
}
