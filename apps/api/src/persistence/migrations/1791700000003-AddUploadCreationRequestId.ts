import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUploadCreationRequestId1791700000003 implements MigrationInterface {
  name = 'AddUploadCreationRequestId1791700000003';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "vfs_upload_session" ADD COLUMN "creation_request_id" varchar(128)');
    // 완료 전 row의 request_id만 생성 요청 ID임을 알 수 있다. 이미 완료된 row의
    // request_id는 완료 요청 ID이므로 생성 ID로 잘못 복사하지 않는다.
    await runner.query(`UPDATE "vfs_upload_session"
      SET "creation_request_id" = "request_id" WHERE "state" <> 'COMPLETED'`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('ALTER TABLE "vfs_upload_session" DROP COLUMN "creation_request_id"');
  }
}
