import { MigrationInterface, QueryRunner } from 'typeorm';
import { withSqliteTableRebuild } from './sqlite-table-rebuild.js';

const OLD_STATES = "'OPEN', 'FINALIZING', 'COMPLETED', 'CANCELLED', 'EXPIRED'";
const NEW_STATES = `${OLD_STATES}, 'FAILED'`;

export class AddUploadChecksumFailure1791700000005 implements MigrationInterface {
  name = 'AddUploadChecksumFailure1791700000005';
  // SQLite must disable foreign keys before its table rebuild transaction.
  transaction: boolean | undefined = process.env.STORIX_DB_DRIVER === 'sqlite' ? false : undefined;

  private async rebuildSqlite(runner: QueryRunner, from: string, to: string): Promise<void> {
    await withSqliteTableRebuild(runner, async (tx) => {
      const rows = (await tx.query(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vfs_upload_session'",
      )) as Array<{ sql: string }>;
      if (rows.length !== 1 || !rows[0].sql.includes(from))
        throw new Error('Upload session state constraint not found');
      const columns = (await tx.query('PRAGMA table_info("vfs_upload_session")')) as Array<{ name: string }>;
      const names = columns.map((column) => `"${column.name}"`).join(', ');
      const create = rows[0].sql
        .replace('"vfs_upload_session"', '"vfs_upload_session_new"')
        .replace(from, to);
      await tx.query(create);
      await tx.query(
        `INSERT INTO "vfs_upload_session_new" (${names}) SELECT ${names} FROM "vfs_upload_session"`,
      );
      await tx.query('DROP TABLE "vfs_upload_session"');
      await tx.query('ALTER TABLE "vfs_upload_session_new" RENAME TO "vfs_upload_session"');
      await tx.query(
        'CREATE INDEX "idx_vfs_upload_session_state_expires" ON "vfs_upload_session" ("state", "expires_at")',
      );
      await tx.query(
        'CREATE INDEX "idx_vfs_upload_session_terminal" ON "vfs_upload_session" ("terminal_at")',
      );
    });
  }

  async up(runner: QueryRunner): Promise<void> {
    if (runner.connection.options.type === 'better-sqlite3') {
      await this.rebuildSqlite(runner, OLD_STATES, NEW_STATES);
    } else {
      await runner.query('ALTER TABLE "vfs_upload_session" DROP CONSTRAINT "vfs_upload_session_state_check"');
      await runner.query(`ALTER TABLE "vfs_upload_session" ADD CONSTRAINT "vfs_upload_session_state_check"
        CHECK ("state" IN (${NEW_STATES}))`);
    }
    await runner.query('ALTER TABLE "vfs_upload_session" ADD COLUMN "sha256" varchar(64)');
  }

  async down(runner: QueryRunner): Promise<void> {
    const failed = (await runner.query(
      'SELECT "id" FROM "vfs_upload_session" WHERE "state" = \'FAILED\' LIMIT 1',
    )) as unknown[];
    if (failed.length > 0) throw new Error('Cannot remove upload failure state while FAILED sessions remain');
    await runner.query('ALTER TABLE "vfs_upload_session" DROP COLUMN "sha256"');
    if (runner.connection.options.type === 'better-sqlite3') {
      await this.rebuildSqlite(runner, NEW_STATES, OLD_STATES);
    } else {
      await runner.query('ALTER TABLE "vfs_upload_session" DROP CONSTRAINT "vfs_upload_session_state_check"');
      await runner.query(`ALTER TABLE "vfs_upload_session" ADD CONSTRAINT "vfs_upload_session_state_check"
        CHECK ("state" IN (${OLD_STATES}))`);
    }
  }
}
