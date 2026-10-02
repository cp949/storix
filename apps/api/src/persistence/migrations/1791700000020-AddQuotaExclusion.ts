import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddQuotaExclusion1791700000020 implements MigrationInterface {
  name = 'AddQuotaExclusion1791700000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "namespace" ADD COLUMN "exclude_trash_from_quota" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "namespace" ADD COLUMN "exclude_snapshots_from_quota" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "max_retained_trash_bytes" bigint
      CONSTRAINT "CHK_namespace_max_retained_trash_bytes_positive"
      CHECK ("max_retained_trash_bytes" IS NULL OR "max_retained_trash_bytes" > 0)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "namespace" DROP COLUMN "max_retained_trash_bytes"');
    await queryRunner.query('ALTER TABLE "namespace" DROP COLUMN "exclude_snapshots_from_quota"');
    await queryRunner.query('ALTER TABLE "namespace" DROP COLUMN "exclude_trash_from_quota"');
  }
}
