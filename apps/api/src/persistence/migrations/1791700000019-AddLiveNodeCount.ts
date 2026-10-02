import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLiveNodeCount1791700000019 implements MigrationInterface {
  name = 'AddLiveNodeCount1791700000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "max_live_nodes" bigint
      CONSTRAINT "CHK_namespace_max_live_nodes_positive"
      CHECK ("max_live_nodes" IS NULL OR "max_live_nodes" > 0)`);
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "live_node_count" bigint NOT NULL DEFAULT 0
      CONSTRAINT "CHK_namespace_live_node_count_non_negative" CHECK ("live_node_count" >= 0)`);
    await queryRunner.query(`
      UPDATE "namespace"
      SET "live_node_count" = (
        SELECT COUNT(*) FROM "vfs_node"
        WHERE "vfs_node"."namespace_id" = "namespace"."id" AND "vfs_node"."parent_id" IS NOT NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "namespace" DROP COLUMN "live_node_count"');
    await queryRunner.query('ALTER TABLE "namespace" DROP COLUMN "max_live_nodes"');
  }
}
