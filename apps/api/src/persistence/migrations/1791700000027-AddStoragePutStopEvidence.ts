/** 운영자의 writer 종료 확인 근거를 보존한다. 규칙은 api ADR-0045다. */
import type { MigrationInterface, QueryRunner } from 'typeorm';

/** 기존 실행·시도 기록을 유지하면서 선택적인 종료 확인 근거 컬럼을 추가한다. */
export class AddStoragePutStopEvidence1791700000027 implements MigrationInterface {
  name = 'AddStoragePutStopEvidence1791700000027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE storage_put_execution ADD COLUMN stopped_confirmation_evidence text',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE storage_put_execution DROP COLUMN stopped_confirmation_evidence');
  }
}
