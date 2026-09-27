import { MigrationInterface, QueryRunner } from 'typeorm';

// 생성 응답의 만료 시각은 활동 갱신으로 바뀌는 expires_at과 별도로 보존한다.
export class AddUploadCreationExpiry1791700000001 implements MigrationInterface {
  name = 'AddUploadCreationExpiry1791700000001';

  async up(runner: QueryRunner): Promise<void> {
    const time = runner.connection.options.type === 'better-sqlite3' ? 'datetime' : 'timestamptz';
    await runner.query(`ALTER TABLE "vfs_upload_session" ADD COLUMN "creation_expires_at" ${time}`);
    await runner.query('UPDATE "vfs_upload_session" SET "creation_expires_at" = "expires_at"');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "vfs_upload_session" DROP COLUMN "creation_expires_at"');
  }
}
