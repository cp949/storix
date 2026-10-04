import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNamespaceMoveLimit1791700000022 implements MigrationInterface {
  name = 'AddNamespaceMoveLimit1791700000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "max_sync_move_nodes" integer
      CONSTRAINT "CHK_namespace_max_sync_move_nodes_positive"
      CHECK ("max_sync_move_nodes" IS NULL OR "max_sync_move_nodes" > 0)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "namespace" DROP COLUMN "max_sync_move_nodes"');
  }
}
