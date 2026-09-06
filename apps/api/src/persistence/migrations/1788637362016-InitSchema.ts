import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1788637362016 implements MigrationInterface {
  name = 'InitSchema1788637362016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "namespace" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar(128) NOT NULL,
        "encryption_policy" varchar(16) NOT NULL DEFAULT 'NONE',
        "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_namespace_name_format" CHECK ("name" ~ '^[a-z0-9_-]{1,128}$'),
        CONSTRAINT "CHK_namespace_encryption_policy" CHECK ("encryption_policy" = 'NONE'),
        CONSTRAINT "CHK_namespace_status" CHECK ("status" IN ('ACTIVE', 'DELETING', 'DELETED'))
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_namespace_active_name" ON "namespace" ("name") WHERE "status" = 'ACTIVE';
    `);

    await queryRunner.query(`
      CREATE TABLE "blob" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "namespace_id" uuid NOT NULL REFERENCES "namespace" ("id"),
        "storage_key" varchar(512) NOT NULL,
        "size" bigint NOT NULL,
        "mime_type" varchar(255) NOT NULL,
        "sha256" char(64) NOT NULL,
        "reference_count" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_blob_size_non_negative" CHECK ("size" >= 0),
        CONSTRAINT "CHK_blob_reference_count_non_negative" CHECK ("reference_count" >= 0),
        CONSTRAINT "UQ_blob_id_namespace_id" UNIQUE ("id", "namespace_id"),
        CONSTRAINT "UQ_blob_storage_key" UNIQUE ("storage_key")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_blob_namespace_id" ON "blob" ("namespace_id");
    `);

    await queryRunner.query(`
      CREATE TABLE "vfs_node" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "namespace_id" uuid NOT NULL REFERENCES "namespace" ("id"),
        "parent_id" uuid,
        "type" varchar(16) NOT NULL,
        "name" varchar(255) NOT NULL,
        "blob_id" uuid,
        "size" bigint,
        "mime_type" varchar(255),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "version" integer NOT NULL DEFAULT 1,
        CONSTRAINT "CHK_vfs_node_type" CHECK ("type" IN ('FILE', 'DIRECTORY')),
        CONSTRAINT "CHK_vfs_node_type_content" CHECK (
          ("type" = 'FILE' AND "blob_id" IS NOT NULL AND "size" IS NOT NULL AND "size" >= 0)
          OR
          ("type" = 'DIRECTORY' AND "blob_id" IS NULL AND "size" IS NULL)
        ),
        CONSTRAINT "CHK_vfs_node_root_shape" CHECK (
          ("parent_id" IS NULL AND "type" = 'DIRECTORY' AND "name" = '')
          OR
          ("parent_id" IS NOT NULL AND "name" <> '')
        ),
        CONSTRAINT "UQ_vfs_node_id_namespace_id" UNIQUE ("id", "namespace_id"),
        CONSTRAINT "UQ_vfs_node_child_name" UNIQUE ("namespace_id", "parent_id", "name"),
        CONSTRAINT "FK_vfs_node_parent" FOREIGN KEY ("namespace_id", "parent_id")
          REFERENCES "vfs_node" ("namespace_id", "id"),
        CONSTRAINT "FK_vfs_node_blob" FOREIGN KEY ("namespace_id", "blob_id")
          REFERENCES "blob" ("namespace_id", "id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_vfs_node_root_per_namespace" ON "vfs_node" ("namespace_id") WHERE "parent_id" IS NULL;
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_vfs_node_namespace_id_blob_id" ON "vfs_node" ("namespace_id", "blob_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "vfs_node";`);
    await queryRunner.query(`DROP TABLE "blob";`);
    await queryRunner.query(`DROP TABLE "namespace";`);
  }
}
