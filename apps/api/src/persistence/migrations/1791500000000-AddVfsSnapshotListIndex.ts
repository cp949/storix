import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVfsSnapshotListIndex1791500000000 implements MigrationInterface {
  name = 'AddVfsSnapshotListIndex1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "IDX_vfs_snapshot_file_list"
      ON "vfs_snapshot" ("namespace_id", "root_node_id", "kind", "created_at" DESC, "id" ASC)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_vfs_snapshot_file_list"');
  }
}
