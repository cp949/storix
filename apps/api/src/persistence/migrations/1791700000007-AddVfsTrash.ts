import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVfsTrash1791700000007 implements MigrationInterface {
  name = 'AddVfsTrash1791700000007';

  async up(runner: QueryRunner): Promise<void> {
    const sqlite = runner.connection.options.type === 'better-sqlite3';
    const uuid = sqlite ? 'varchar(36)' : 'uuid';
    const time = sqlite ? 'datetime' : 'timestamptz';
    const generatedId = sqlite ? '' : ' DEFAULT gen_random_uuid()';

    await runner.query(`ALTER TABLE "namespace" ADD COLUMN "retained_trash_node_count" bigint NOT NULL DEFAULT 0
      CONSTRAINT "CHK_namespace_retained_trash_node_count_non_negative" CHECK ("retained_trash_node_count" >= 0)`);
    await runner.query(`ALTER TABLE "namespace" ADD COLUMN "retained_trash_byte_count" bigint NOT NULL DEFAULT 0
      CONSTRAINT "CHK_namespace_retained_trash_byte_count_non_negative" CHECK ("retained_trash_byte_count" >= 0)`);

    await runner.query(`CREATE TABLE "vfs_trash" (
      "id" ${uuid} PRIMARY KEY${generatedId},
      "namespace_id" ${uuid} NOT NULL REFERENCES "namespace"("id") ON DELETE CASCADE,
      "root_type" varchar(16) NOT NULL CHECK ("root_type" IN ('FILE', 'DIRECTORY')),
      "original_path" text NOT NULL,
      "root_node_id" ${uuid} NOT NULL,
      "root_revision" varchar(64) NOT NULL,
      "node_count" bigint NOT NULL CHECK ("node_count" > 0),
      "logical_bytes" bigint NOT NULL CHECK ("logical_bytes" >= 0),
      "deleted_at" ${time} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expires_at" ${time} NOT NULL,
      CONSTRAINT "CHK_vfs_trash_expiry" CHECK ("expires_at" > "deleted_at"),
      CONSTRAINT "UQ_vfs_trash_id_namespace_id" UNIQUE ("id", "namespace_id")
    )`);
    await runner.query(`CREATE INDEX "idx_vfs_trash_namespace_expiry"
      ON "vfs_trash" ("namespace_id", "expires_at", "id")`);
    await runner.query(`CREATE INDEX "idx_vfs_trash_namespace_list"
      ON "vfs_trash" ("namespace_id", "deleted_at" DESC, "id" ASC)`);

    await runner.query(`CREATE TABLE "vfs_trash_entry" (
      "id" ${uuid} PRIMARY KEY${generatedId},
      "namespace_id" ${uuid} NOT NULL REFERENCES "namespace"("id") ON DELETE CASCADE,
      "trash_id" ${uuid} NOT NULL,
      "relative_path" text NOT NULL,
      "path_key" text NOT NULL,
      "type" varchar(16) NOT NULL CHECK ("type" IN ('FILE', 'DIRECTORY')),
      "source_node_id" ${uuid} NOT NULL,
      "source_revision" varchar(64) NOT NULL,
      "blob_id" ${uuid},
      "size" bigint CHECK ("size" IS NULL OR "size" >= 0),
      "mime_type" varchar(255),
      CONSTRAINT "FK_vfs_trash_entry_trash" FOREIGN KEY ("trash_id", "namespace_id")
        REFERENCES "vfs_trash" ("id", "namespace_id") ON DELETE CASCADE,
      CONSTRAINT "FK_vfs_trash_entry_blob" FOREIGN KEY ("namespace_id", "blob_id")
        REFERENCES "blob" ("namespace_id", "id") ON DELETE RESTRICT
    )`);
    // 상대 경로는 B-tree 키 크기 제한을 넘을 수 있으므로 manifest 소유 ID만 인덱싱한다.
    await runner.query(`CREATE INDEX "idx_vfs_trash_entry_trash_id" ON "vfs_trash_entry" ("trash_id")`);
    await runner.query(`CREATE INDEX "idx_vfs_trash_entry_namespace_blob"
      ON "vfs_trash_entry" ("namespace_id", "blob_id")`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "vfs_trash_entry"');
    await runner.query('DROP TABLE "vfs_trash"');
    await runner.query('ALTER TABLE "namespace" DROP COLUMN "retained_trash_byte_count"');
    await runner.query('ALTER TABLE "namespace" DROP COLUMN "retained_trash_node_count"');
  }
}
