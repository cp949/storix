import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVfsSnapshots1790400000000 implements MigrationInterface {
  name = 'AddVfsSnapshots1790400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sqlite = queryRunner.connection.options.type === 'better-sqlite3';
    const uuidType = sqlite ? 'varchar(36)' : 'uuid';
    const timestampType = sqlite ? 'datetime' : 'timestamptz';
    const now = sqlite ? "(datetime('now'))" : 'now()';
    const generatedId = sqlite ? '' : ' DEFAULT gen_random_uuid()';

    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "max_sync_snapshot_nodes" integer
      CONSTRAINT "CHK_namespace_max_sync_snapshot_nodes_positive" CHECK ("max_sync_snapshot_nodes" IS NULL OR "max_sync_snapshot_nodes" > 0)`);
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "max_snapshot_bytes" bigint
      CONSTRAINT "CHK_namespace_max_snapshot_bytes_positive" CHECK ("max_snapshot_bytes" IS NULL OR "max_snapshot_bytes" > 0)`);
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "max_retained_snapshot_nodes" integer
      CONSTRAINT "CHK_namespace_max_retained_snapshot_nodes_positive" CHECK ("max_retained_snapshot_nodes" IS NULL OR "max_retained_snapshot_nodes" > 0)`);
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "max_retained_snapshot_bytes" bigint
      CONSTRAINT "CHK_namespace_max_retained_snapshot_bytes_positive" CHECK ("max_retained_snapshot_bytes" IS NULL OR "max_retained_snapshot_bytes" > 0)`);
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "retained_snapshot_node_count" integer NOT NULL DEFAULT 0
      CONSTRAINT "CHK_namespace_retained_snapshot_node_count_non_negative" CHECK ("retained_snapshot_node_count" >= 0)`);
    await queryRunner.query(`ALTER TABLE "namespace" ADD COLUMN "retained_snapshot_byte_count" bigint NOT NULL DEFAULT 0
      CONSTRAINT "CHK_namespace_retained_snapshot_byte_count_non_negative" CHECK ("retained_snapshot_byte_count" >= 0)`);

    await queryRunner.query(`
      CREATE TABLE "vfs_snapshot" (
        "id" ${uuidType} PRIMARY KEY${generatedId},
        "namespace_id" ${uuidType} NOT NULL REFERENCES "namespace"("id"),
        "kind" varchar(16) NOT NULL,
        "source_path" text NOT NULL,
        "root_node_id" ${uuidType} NOT NULL,
        "source_revision" varchar(64) NOT NULL,
        "root_type" varchar(16) NOT NULL,
        "node_count" integer NOT NULL,
        "logical_bytes" bigint NOT NULL,
        "created_at" ${timestampType} NOT NULL DEFAULT ${now},
        CONSTRAINT "CHK_vfs_snapshot_kind" CHECK ("kind" IN ('FILE', 'TREE')),
        CONSTRAINT "CHK_vfs_snapshot_root_type" CHECK ("root_type" IN ('FILE', 'DIRECTORY')),
        CONSTRAINT "CHK_vfs_snapshot_node_count_positive" CHECK ("node_count" > 0),
        CONSTRAINT "CHK_vfs_snapshot_logical_bytes_non_negative" CHECK ("logical_bytes" >= 0),
        CONSTRAINT "UQ_vfs_snapshot_id_namespace_id" UNIQUE ("id", "namespace_id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "idx_vfs_snapshot_namespace_created_at"
      ON "vfs_snapshot" ("namespace_id", "created_at")`);

    await queryRunner.query(`
      CREATE TABLE "vfs_snapshot_entry" (
        "id" ${uuidType} PRIMARY KEY${generatedId},
        "namespace_id" ${uuidType} NOT NULL REFERENCES "namespace"("id"),
        "snapshot_id" ${uuidType} NOT NULL,
        "relative_path" text NOT NULL,
        "path_key" text NOT NULL,
        "type" varchar(16) NOT NULL,
        "source_node_id" ${uuidType} NOT NULL,
        "source_revision" varchar(64) NOT NULL,
        "blob_id" ${uuidType},
        "size" bigint,
        "mime_type" varchar(255),
        CONSTRAINT "CHK_vfs_snapshot_entry_type" CHECK ("type" IN ('FILE', 'DIRECTORY')),
        CONSTRAINT "CHK_vfs_snapshot_entry_size_non_negative" CHECK ("size" IS NULL OR "size" >= 0),
        CONSTRAINT "FK_vfs_snapshot_entry_snapshot" FOREIGN KEY ("snapshot_id", "namespace_id")
          REFERENCES "vfs_snapshot" ("id", "namespace_id") ON DELETE CASCADE,
        CONSTRAINT "FK_vfs_snapshot_entry_blob" FOREIGN KEY ("namespace_id", "blob_id")
          REFERENCES "blob" ("namespace_id", "id") ON DELETE RESTRICT
      )
    `);
    // 경로 텍스트와 그 UTF-8 hex는 PG B-tree 항목 크기를 넘을 수 있다. snapshot_id만
    // 인덱싱하고, root lock 아래 bounded capture가 중복 경로를 검증한다.
    await queryRunner.query(`CREATE INDEX "idx_vfs_snapshot_entry_snapshot_id"
      ON "vfs_snapshot_entry" ("snapshot_id")`);
    await queryRunner.query(`CREATE INDEX "idx_vfs_snapshot_entry_namespace_blob"
      ON "vfs_snapshot_entry" ("namespace_id", "blob_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "vfs_snapshot_entry"');
    await queryRunner.query('DROP TABLE "vfs_snapshot"');
    for (const column of [
      'retained_snapshot_byte_count',
      'retained_snapshot_node_count',
      'max_retained_snapshot_bytes',
      'max_retained_snapshot_nodes',
      'max_snapshot_bytes',
      'max_sync_snapshot_nodes',
    ]) {
      await queryRunner.query(`ALTER TABLE "namespace" DROP COLUMN "${column}"`);
    }
  }
}
