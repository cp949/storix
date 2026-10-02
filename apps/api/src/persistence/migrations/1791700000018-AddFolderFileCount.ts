import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFolderFileCount1791700000018 implements MigrationInterface {
  name = 'AddFolderFileCount1791700000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "max_files_per_folder" bigint
      CONSTRAINT "CHK_namespace_max_files_per_folder_positive"
      CHECK ("max_files_per_folder" IS NULL OR "max_files_per_folder" > 0)`);
    await queryRunner.query(`ALTER TABLE "vfs_node" ADD COLUMN "child_file_count" bigint NOT NULL DEFAULT 0
      CONSTRAINT "CHK_vfs_node_child_file_count_non_negative" CHECK ("child_file_count" >= 0)`);
    // 기존 namespace·parent 인덱스는 선두에 namespace_id가 있어 전체 backfill의 parent lookup에 쓸 수 없다.
    await queryRunner.query('CREATE INDEX "tmp_vfs_node_parent_type" ON "vfs_node" ("parent_id", "type")');
    await queryRunner.query(`
      UPDATE "vfs_node"
      SET "child_file_count" = (
        SELECT COUNT(*) FROM "vfs_node" AS child
        WHERE child."parent_id" = "vfs_node"."id" AND child."type" = 'FILE'
      )
      WHERE "type" = 'DIRECTORY'
    `);
    await queryRunner.query('DROP INDEX "tmp_vfs_node_parent_type"');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "vfs_node" DROP COLUMN "child_file_count"');
    await queryRunner.query('ALTER TABLE "namespace" DROP COLUMN "max_files_per_folder"');
  }
}
