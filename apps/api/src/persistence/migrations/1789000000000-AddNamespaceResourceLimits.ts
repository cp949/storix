import { MigrationInterface, QueryRunner } from 'typeorm';
import { getDbDriver } from '../../common/db-driver.js';

export class AddNamespaceResourceLimits1789000000000 implements MigrationInterface {
  name = 'AddNamespaceResourceLimits1789000000000';
  transaction?: boolean;

  constructor() {
    // SQLite는 이 마이그레이션 안에서 테이블을 재구성해야 하고, 그 재구성이
    // 요구하는 PRAGMA foreign_keys=OFF는 트랜잭션 안에서 no-op이다. 그래서
    // TypeORM이 자동으로 열어주는 트랜잭션을 꺼야 한다. 클래스 필드로
    // 무조건 대입하면(값이 true여도) Postgres 쪽 기본 트랜잭션 모드("all")에서
    // ForbiddenTransactionModeOverrideError가 나므로, sqlite일 때만 설정한다.
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
          CONSTRAINT "CHK_namespace_encryption_policy" CHECK ("encryption_policy" = 'NONE'),
          CONSTRAINT "CHK_namespace_status" CHECK ("status" IN ('ACTIVE', 'DELETING', 'DELETED')),
          CONSTRAINT "CHK_namespace_max_file_size_bytes_positive" CHECK ("max_file_size_bytes" IS NULL OR "max_file_size_bytes" > 0),
          CONSTRAINT "CHK_namespace_max_sync_delete_nodes_positive" CHECK ("max_sync_delete_nodes" IS NULL OR "max_sync_delete_nodes" > 0),
          CONSTRAINT "CHK_namespace_max_sync_copy_nodes_positive" CHECK ("max_sync_copy_nodes" IS NULL OR "max_sync_copy_nodes" > 0)
        )
      `);
      await queryRunner.query(`
        INSERT INTO "namespace_new" ("id","name","encryption_policy","status","created_at","updated_at")
          SELECT "id","name","encryption_policy","status","created_at","updated_at" FROM "namespace"
      `);
      await queryRunner.query(`DROP TABLE "namespace"`);
      await queryRunner.query(`ALTER TABLE "namespace_new" RENAME TO "namespace"`);
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'better-sqlite3') {
      await this.downSqlite(queryRunner);
      return;
    }
    await this.downPostgres(queryRunner);
  }

  private async downPostgres(queryRunner: QueryRunner): Promise<void> {
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

  private async downSqlite(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('PRAGMA foreign_keys=OFF');
    try {
      await queryRunner.query('BEGIN TRANSACTION');
      await queryRunner.query(`
        CREATE TABLE "namespace_old" (
          "id" varchar(36) PRIMARY KEY,
          "name" varchar(128) NOT NULL,
          "encryption_policy" varchar(16) NOT NULL DEFAULT 'NONE',
          "status" varchar(16) NOT NULL DEFAULT 'ACTIVE',
          "created_at" datetime NOT NULL DEFAULT (datetime('now')),
          "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
          CONSTRAINT "CHK_namespace_name_format" CHECK ("name" NOT GLOB '*[^a-z0-9_-]*' AND length("name") BETWEEN 1 AND 128),
          CONSTRAINT "CHK_namespace_encryption_policy" CHECK ("encryption_policy" = 'NONE'),
          CONSTRAINT "CHK_namespace_status" CHECK ("status" IN ('ACTIVE', 'DELETING', 'DELETED'))
        )
      `);
      await queryRunner.query(`
        INSERT INTO "namespace_old" ("id","name","encryption_policy","status","created_at","updated_at")
          SELECT "id","name","encryption_policy","status","created_at","updated_at" FROM "namespace"
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
