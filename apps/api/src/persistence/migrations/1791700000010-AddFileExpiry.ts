import { MigrationInterface, QueryRunner } from 'typeorm';

// 파일 만료와 resumable 세션의 만료 입력을 저장한다.
// down은 컬럼을 제거하므로 롤백 시점의 미확정 파일은 만료 없는 파일이 된다.
export class AddFileExpiry1791700000010 implements MigrationInterface {
  name = 'AddFileExpiry1791700000010';

  async up(runner: QueryRunner): Promise<void> {
    const sqlite = runner.connection.options.type === 'better-sqlite3';
    const time = sqlite ? 'datetime' : 'timestamptz';
    await runner.query(`ALTER TABLE "vfs_node" ADD COLUMN "expires_at" ${time}`);
    await runner.query(
      'CREATE INDEX "idx_vfs_node_expires_at" ON "vfs_node" ("expires_at", "id") WHERE "expires_at" IS NOT NULL',
    );
    await runner.query('ALTER TABLE "vfs_upload_session" ADD COLUMN "file_expires_in_seconds" INTEGER');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "vfs_upload_session" DROP COLUMN "file_expires_in_seconds"');
    // SQLite는 인덱스가 걸린 컬럼을 DROP COLUMN할 수 없어 인덱스를 먼저 제거한다.
    await runner.query('DROP INDEX "idx_vfs_node_expires_at"');
    await runner.query('ALTER TABLE "vfs_node" DROP COLUMN "expires_at"');
  }
}
