import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNamespaceResourceLimits1789000000000 implements MigrationInterface {
  name = 'AddNamespaceResourceLimits1789000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "namespace" ADD COLUMN "max_file_size_bytes" bigint;
    `);
    await queryRunner.query(`
      ALTER TABLE "namespace" ADD COLUMN "max_sync_delete_nodes" integer;
    `);
    await queryRunner.query(`
      ALTER TABLE "namespace" ADD COLUMN "max_sync_copy_nodes" integer;
    `);
    await queryRunner.query(`
      ALTER TABLE "namespace" ADD CONSTRAINT "CHK_namespace_max_file_size_bytes_positive"
        CHECK ("max_file_size_bytes" IS NULL OR "max_file_size_bytes" > 0);
    `);
    await queryRunner.query(`
      ALTER TABLE "namespace" ADD CONSTRAINT "CHK_namespace_max_sync_delete_nodes_positive"
        CHECK ("max_sync_delete_nodes" IS NULL OR "max_sync_delete_nodes" > 0);
    `);
    await queryRunner.query(`
      ALTER TABLE "namespace" ADD CONSTRAINT "CHK_namespace_max_sync_copy_nodes_positive"
        CHECK ("max_sync_copy_nodes" IS NULL OR "max_sync_copy_nodes" > 0);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "namespace" DROP CONSTRAINT "CHK_namespace_max_sync_copy_nodes_positive";`,
    );
    await queryRunner.query(
      `ALTER TABLE "namespace" DROP CONSTRAINT "CHK_namespace_max_sync_delete_nodes_positive";`,
    );
    await queryRunner.query(
      `ALTER TABLE "namespace" DROP CONSTRAINT "CHK_namespace_max_file_size_bytes_positive";`,
    );
    await queryRunner.query(`ALTER TABLE "namespace" DROP COLUMN "max_sync_copy_nodes";`);
    await queryRunner.query(`ALTER TABLE "namespace" DROP COLUMN "max_sync_delete_nodes";`);
    await queryRunner.query(`ALTER TABLE "namespace" DROP COLUMN "max_file_size_bytes";`);
  }
}
