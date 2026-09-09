import { MigrationInterface, QueryRunner } from 'typeorm';
import { getDbDriver } from '../../common/db-driver.js';

export class AddEncryptionSupport1789100000000 implements MigrationInterface {
  name = 'AddEncryptionSupport1789100000000';
  transaction?: boolean;

  constructor() {
    if (getDbDriver() === 'sqlite') {
      this.transaction = false;
    }
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'better-sqlite3') {
      await this.upSqlite(queryRunner);
      return;
    }
    await this.upPostgres(queryRunner);
  }

  private async upPostgres(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "namespace" DROP CONSTRAINT "CHK_namespace_encryption_policy";
    `);
    await queryRunner.query(`
      ALTER TABLE "namespace" ADD CONSTRAINT "CHK_namespace_encryption_policy"
        CHECK ("encryption_policy" IN ('NONE', 'ENCRYPTED'));
    `);
    await queryRunner.query(`
      ALTER TABLE "blob" ADD COLUMN "encryption_iv" bytea;
    `);
    await queryRunner.query(`
      ALTER TABLE "blob" ADD CONSTRAINT "CHK_blob_encryption_iv_length"
        CHECK ("encryption_iv" IS NULL OR octet_length("encryption_iv") = 16);
    `);
  }

  private async upSqlite(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('PRAGMA foreign_keys=OFF');
    try {
      await queryRunner.query('BEGIN TRANSACTION');
      await queryRunner.query(`
        CREATE TABLE "namespace_new" (
          "id" varchar(36) PRIMARY KEY,
          "name" varchar(128) NOT NULL,
          "encryption_policy" varchar(16) NOT NULL DEFAULT 'NONE',
          "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
          "max_file_size_bytes" bigint,
          "max_sync_delete_nodes" integer,
          "max_sync_copy_nodes" integer,
          "created_at" datetime NOT NULL DEFAULT (datetime('now')),
          "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
          CONSTRAINT "CHK_namespace_name_format" CHECK ("name" NOT GLOB '*[^a-z0-9_-]*' AND length("name") BETWEEN 1 AND 128),
          CONSTRAINT "CHK_namespace_encryption_policy" CHECK ("encryption_policy" IN ('NONE', 'ENCRYPTED')),
          CONSTRAINT "CHK_namespace_status" CHECK ("status" IN ('ACTIVE', 'DELETING', 'DELETED')),
          CONSTRAINT "CHK_namespace_max_file_size_bytes_positive" CHECK ("max_file_size_bytes" IS NULL OR "max_file_size_bytes" > 0),
          CONSTRAINT "CHK_namespace_max_sync_delete_nodes_positive" CHECK ("max_sync_delete_nodes" IS NULL OR "max_sync_delete_nodes" > 0),
          CONSTRAINT "CHK_namespace_max_sync_copy_nodes_positive" CHECK ("max_sync_copy_nodes" IS NULL OR "max_sync_copy_nodes" > 0)
        )
      `);
      await queryRunner.query(`
        INSERT INTO "namespace_new" ("id","name","encryption_policy","status","max_file_size_bytes","max_sync_delete_nodes","max_sync_copy_nodes","created_at","updated_at")
          SELECT "id","name","encryption_policy","status","max_file_size_bytes","max_sync_delete_nodes","max_sync_copy_nodes","created_at","updated_at" FROM "namespace"
      `);
      await queryRunner.query(`DROP TABLE "namespace"`);
      await queryRunner.query(`ALTER TABLE "namespace_new" RENAME TO "namespace"`);
      await queryRunner.query(`CREATE UNIQUE INDEX "UQ_namespace_active_name" ON "namespace" ("name") WHERE "status" = 'ACTIVE'`);

      await queryRunner.query(`
        CREATE TABLE "blob_new" (
          "id" varchar(36) PRIMARY KEY,
          "namespace_id" varchar(36) NOT NULL REFERENCES "namespace" ("id"),
          "storage_key" varchar(512) NOT NULL,
          "size" bigint NOT NULL,
          "mime_type" varchar(255) NOT NULL,
          "sha256" char(64) NOT NULL,
          "reference_count" integer NOT NULL DEFAULT 0,
          "created_at" datetime NOT NULL DEFAULT (datetime('now')),
          "zero_since" datetime,
          "encryption_iv" blob,
          CONSTRAINT "CHK_blob_size_non_negative" CHECK ("size" >= 0),
          CONSTRAINT "CHK_blob_reference_count_non_negative" CHECK ("reference_count" >= 0),
          CONSTRAINT "CHK_blob_encryption_iv_length" CHECK ("encryption_iv" IS NULL OR length("encryption_iv") = 16),
          CONSTRAINT "UQ_blob_id_namespace_id" UNIQUE ("id", "namespace_id"),
          CONSTRAINT "UQ_blob_storage_key" UNIQUE ("storage_key")
        )
      `);
      await queryRunner.query(`
        INSERT INTO "blob_new" ("id","namespace_id","storage_key","size","mime_type","sha256","reference_count","created_at","zero_since")
          SELECT "id","namespace_id","storage_key","size","mime_type","sha256","reference_count","created_at","zero_since" FROM "blob"
      `);
      await queryRunner.query(`DROP TABLE "blob"`);
      await queryRunner.query(`ALTER TABLE "blob_new" RENAME TO "blob"`);
      await queryRunner.query(`CREATE INDEX "IDX_blob_namespace_id" ON "blob" ("namespace_id")`);
      await queryRunner.query(
        `CREATE INDEX "IDX_blob_reference_count_zero_since" ON "blob" ("zero_since") WHERE "reference_count" = 0`,
      );

      await queryRunner.query('COMMIT');
    } catch (error) {
      try {
        await queryRunner.query('ROLLBACK');
      } catch {
        // 원본 에러를 가리지 않기 위해 ROLLBACK 실패는 무시한다.
      }
      throw error;
    } finally {
      await queryRunner.query('PRAGMA foreign_keys=ON');
    }
  }

  // ENCRYPTED namespace가 하나라도 남아 있으면 이 되돌리기는 의도적으로 실패한다 —
  // encryption_iv를 지우면 그 데이터는 영구 복호화 불가이므로, namespace 정책 CHECK
  // 제약이 되돌리기를 막는다(트랜잭션 롤백되며, 버그가 아니다). SQLite에서는
  // namespace_old로의 INSERT ... SELECT 자체가 CHECK 위반으로 실패해 같은 효과를 낸다.
  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'better-sqlite3') {
      await this.downSqlite(queryRunner);
      return;
    }
    await this.downPostgres(queryRunner);
  }

  private async downPostgres(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "blob" DROP CONSTRAINT "CHK_blob_encryption_iv_length";`);
    await queryRunner.query(`ALTER TABLE "blob" DROP COLUMN "encryption_iv";`);
    await queryRunner.query(`ALTER TABLE "namespace" DROP CONSTRAINT "CHK_namespace_encryption_policy";`);
    await queryRunner.query(`
      ALTER TABLE "namespace" ADD CONSTRAINT "CHK_namespace_encryption_policy" CHECK ("encryption_policy" = 'NONE');
    `);
  }

  private async downSqlite(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('PRAGMA foreign_keys=OFF');
    try {
      await queryRunner.query('BEGIN TRANSACTION');
      await queryRunner.query(`
        CREATE TABLE "blob_old" (
          "id" varchar(36) PRIMARY KEY,
          "namespace_id" varchar(36) NOT NULL REFERENCES "namespace" ("id"),
          "storage_key" varchar(512) NOT NULL,
          "size" bigint NOT NULL,
          "mime_type" varchar(255) NOT NULL,
          "sha256" char(64) NOT NULL,
          "reference_count" integer NOT NULL DEFAULT 0,
          "created_at" datetime NOT NULL DEFAULT (datetime('now')),
          "zero_since" datetime,
          CONSTRAINT "CHK_blob_size_non_negative" CHECK ("size" >= 0),
          CONSTRAINT "CHK_blob_reference_count_non_negative" CHECK ("reference_count" >= 0),
          CONSTRAINT "UQ_blob_id_namespace_id" UNIQUE ("id", "namespace_id"),
          CONSTRAINT "UQ_blob_storage_key" UNIQUE ("storage_key")
        )
      `);
      await queryRunner.query(`
        INSERT INTO "blob_old" ("id","namespace_id","storage_key","size","mime_type","sha256","reference_count","created_at","zero_since")
          SELECT "id","namespace_id","storage_key","size","mime_type","sha256","reference_count","created_at","zero_since" FROM "blob"
      `);
      await queryRunner.query(`DROP TABLE "blob"`);
      await queryRunner.query(`ALTER TABLE "blob_old" RENAME TO "blob"`);
      await queryRunner.query(`CREATE INDEX "IDX_blob_namespace_id" ON "blob" ("namespace_id")`);
      await queryRunner.query(
        `CREATE INDEX "IDX_blob_reference_count_zero_since" ON "blob" ("zero_since") WHERE "reference_count" = 0`,
      );

      await queryRunner.query(`
        CREATE TABLE "namespace_old" (
          "id" varchar(36) PRIMARY KEY,
          "name" varchar(128) NOT NULL,
          "encryption_policy" varchar(16) NOT NULL DEFAULT 'NONE',
          "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
          "max_file_size_bytes" bigint,
          "max_sync_delete_nodes" integer,
          "max_sync_copy_nodes" integer,
          "created_at" datetime NOT NULL DEFAULT (datetime('now')),
          "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
          CONSTRAINT "CHK_namespace_name_format" CHECK ("name" NOT GLOB '*[^a-z0-9_-]*' AND length("name") BETWEEN 1 AND 128),
          CONSTRAINT "CHK_namespace_encryption_policy" CHECK ("encryption_policy" = 'NONE'),
          CONSTRAINT "CHK_namespace_status" CHECK ("status" IN ('ACTIVE', 'DELETING', 'DELETED')),
          CONSTRAINT "CHK_namespace_max_file_size_bytes_positive" CHECK ("max_file_size_bytes" IS NULL OR "max_file_size_bytes" > 0),
          CONSTRAINT "CHK_namespace_max_sync_delete_nodes_positive" CHECK ("max_sync_delete_nodes" IS NULL OR "max_sync_delete_nodes" > 0),
          CONSTRAINT "CHK_namespace_max_sync_copy_nodes_positive" CHECK ("max_sync_copy_nodes" IS NULL OR "max_sync_copy_nodes" > 0)
        )
      `);
      // ENCRYPTED namespace가 있으면 이 INSERT가 CHK_namespace_encryption_policy
      // 위반으로 실패한다 — Postgres의 "의도된 되돌리기 실패"와 같은 효과.
      await queryRunner.query(`
        INSERT INTO "namespace_old" ("id","name","encryption_policy","status","max_file_size_bytes","max_sync_delete_nodes","max_sync_copy_nodes","created_at","updated_at")
          SELECT "id","name","encryption_policy","status","max_file_size_bytes","max_sync_delete_nodes","max_sync_copy_nodes","created_at","updated_at" FROM "namespace"
      `);
      await queryRunner.query(`DROP TABLE "namespace"`);
      await queryRunner.query(`ALTER TABLE "namespace_old" RENAME TO "namespace"`);
      await queryRunner.query(`CREATE UNIQUE INDEX "UQ_namespace_active_name" ON "namespace" ("name") WHERE "status" = 'ACTIVE'`);
      await queryRunner.query('COMMIT');
    } catch (error) {
      try {
        await queryRunner.query('ROLLBACK');
      } catch {
        // 원본 에러를 가리지 않기 위해 ROLLBACK 실패는 무시한다.
      }
      throw error;
    } finally {
      await queryRunner.query('PRAGMA foreign_keys=ON');
    }
  }
}
