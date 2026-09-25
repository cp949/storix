import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNamespaceLogicalQuota1791400000000 implements MigrationInterface {
  name = 'AddNamespaceLogicalQuota1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "max_total_logical_bytes" bigint
      CONSTRAINT "CHK_namespace_max_total_logical_bytes_positive"
      CHECK ("max_total_logical_bytes" IS NULL OR "max_total_logical_bytes" > 0)`);
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "live_file_byte_count" bigint NOT NULL DEFAULT 0
      CONSTRAINT "CHK_namespace_live_file_byte_count_non_negative" CHECK ("live_file_byte_count" >= 0)`);
    await queryRunner.query(`
      UPDATE "namespace"
      SET "live_file_byte_count" = COALESCE((
        SELECT SUM("size") FROM "vfs_node"
        WHERE "vfs_node"."namespace_id" = "namespace"."id" AND "vfs_node"."type" = 'FILE'
      ), 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "namespace" DROP COLUMN "live_file_byte_count"');
    await queryRunner.query('ALTER TABLE "namespace" DROP COLUMN "max_total_logical_bytes"');
  }
}
