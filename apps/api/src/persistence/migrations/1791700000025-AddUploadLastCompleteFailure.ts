import { MigrationInterface, QueryRunner } from 'typeorm';

// 완료가 실패해 OPEN으로 돌아온 세션의 마지막 실패 진단을 담는 nullable 컬럼 두 개를 추가한다.
// 기존 행은 null을 유지한다. down은 이 진단 컬럼만 제거하며 세션·조각·receipt는 건드리지 않는다.
export class AddUploadLastCompleteFailure1791700000025 implements MigrationInterface {
  name = 'AddUploadLastCompleteFailure1791700000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const type = queryRunner.connection.options.type === 'better-sqlite3' ? 'datetime' : 'timestamptz';
    await queryRunner.query('ALTER TABLE "vfs_upload_session" ADD COLUMN "last_complete_failure_code" text');
    await queryRunner.query(`ALTER TABLE "vfs_upload_session" ADD COLUMN "last_complete_failure_at" ${type}`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "vfs_upload_session" DROP COLUMN "last_complete_failure_at"');
    await queryRunner.query('ALTER TABLE "vfs_upload_session" DROP COLUMN "last_complete_failure_code"');
  }
}
