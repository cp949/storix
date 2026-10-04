import { MigrationInterface, QueryRunner } from 'typeorm';

// X-Request-Id는 미들웨어가 200자까지 받고 audit_log.request_id도 varchar(200)이다.
// 업로드 세션 컬럼만 128이라 129~200자 값이 PostgreSQL에서 22001로 실패했다.
// SQLite는 varchar 길이를 강제하지 않고, 컬럼 변경에 테이블 재생성이 필요해 위험만 크므로 건너뛴다.
// 이 때문에 SQLite 스키마에는 varchar(128)이 남고 엔티티 정의(200)와 숫자가 어긋나지만 동작은 같다.
export class WidenUploadSessionRequestId1791700000021 implements MigrationInterface {
  name = 'WidenUploadSessionRequestId1791700000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'better-sqlite3') return;
    await queryRunner.query('ALTER TABLE "vfs_upload_session" ALTER COLUMN "request_id" TYPE varchar(200)');
    await queryRunner.query(
      'ALTER TABLE "vfs_upload_session" ALTER COLUMN "creation_request_id" TYPE varchar(200)',
    );
  }

  // 길이 129자 이상인 값이 있으면 22001로 실패한다. 값을 자르지 않고 롤백을 중단한다.
  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'better-sqlite3') return;
    await queryRunner.query('ALTER TABLE "vfs_upload_session" ALTER COLUMN "request_id" TYPE varchar(128)');
    await queryRunner.query(
      'ALTER TABLE "vfs_upload_session" ALTER COLUMN "creation_request_id" TYPE varchar(128)',
    );
  }
}
