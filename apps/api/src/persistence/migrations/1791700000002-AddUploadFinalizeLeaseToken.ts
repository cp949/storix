import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUploadFinalizeLeaseToken1791700000002 implements MigrationInterface {
  name = 'AddUploadFinalizeLeaseToken1791700000002';

  async up(runner: QueryRunner): Promise<void> {
    const uuid = runner.connection.options.type === 'better-sqlite3' ? 'varchar(36)' : 'uuid';
    await runner.query(`ALTER TABLE "vfs_upload_session" ADD COLUMN "lease_token" ${uuid}`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "vfs_upload_session" DROP COLUMN "lease_token"');
  }
}
