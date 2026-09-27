import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUploadPartLease1791700000004 implements MigrationInterface {
  name = 'AddUploadPartLease1791700000004';

  async up(runner: QueryRunner): Promise<void> {
    const timestamp = runner.connection.options.type === 'better-sqlite3' ? 'datetime' : 'timestamptz';
    await runner.query(`ALTER TABLE "vfs_upload_part" ADD COLUMN "lease_expires_at" ${timestamp}`);
    const uuid = runner.connection.options.type === 'better-sqlite3' ? 'varchar(36)' : 'uuid';
    await runner.query(`CREATE TABLE "vfs_upload_staging_cleanup" (
      "staging_key" varchar(512) PRIMARY KEY,
      "session_id" ${uuid} NOT NULL,
      "part_index" integer NOT NULL,
      "namespace_id" ${uuid} NOT NULL,
      "size_bytes" bigint NOT NULL,
      "deleted_at" ${timestamp},
      "put_settled_at" ${timestamp},
      "created_at" ${timestamp} NOT NULL
    )`);
    await runner.query(
      'CREATE INDEX "idx_upload_staging_cleanup_part" ON "vfs_upload_staging_cleanup" ("session_id", "part_index")',
    );
    // Earlier versions have no PUT ownership signal. Keep their reservations charged
    // for the maximum configured upload lifetime during a rolling upgrade.
    const sqlite = runner.connection.options.type === 'better-sqlite3';
    const placeholder = sqlite ? '?' : '$';
    const expiry = new Date(Date.now() + 24 * 3600_000);
    await runner.query(
      `UPDATE "vfs_upload_part" SET "lease_expires_at" = ${placeholder}${placeholder === '$' ? '1' : ''}
      WHERE "state" = ${placeholder}${placeholder === '$' ? '2' : ''}`,
      [sqlite ? expiry.toISOString().replace('T', ' ').replace('Z', '') : expiry, 'RESERVED'],
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    const pending = (await runner.query(
      'SELECT "staging_key" FROM "vfs_upload_staging_cleanup" LIMIT 1',
    )) as unknown[];
    if (pending.length > 0)
      throw new Error('Cannot remove upload part lease while charged staging tombstones remain');
    await runner.query('DROP TABLE "vfs_upload_staging_cleanup"');
    await runner.query('ALTER TABLE "vfs_upload_part" DROP COLUMN "lease_expires_at"');
  }
}
