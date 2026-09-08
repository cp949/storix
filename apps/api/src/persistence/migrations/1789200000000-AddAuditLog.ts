import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuditLog1789200000000 implements MigrationInterface {
  name = 'AddAuditLog1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'better-sqlite3') {
      await queryRunner.query(`
        CREATE TABLE "audit_log" (
          "id" varchar(36) PRIMARY KEY,
          "request_id" varchar(200) NOT NULL,
          "namespace_id" varchar(36),
          "operation" varchar(128) NOT NULL,
          "path" text,
          "detail" jsonb,
          "caller" varchar(200),
          "status" smallint NOT NULL,
          "created_at" datetime NOT NULL DEFAULT (datetime('now'))
        )
      `);
    } else {
      await queryRunner.query(`
        CREATE TABLE "audit_log" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          "request_id" varchar(200) NOT NULL,
          "namespace_id" uuid,
          "operation" varchar(128) NOT NULL,
          "path" text,
          "detail" jsonb,
          "caller" varchar(200),
          "status" smallint NOT NULL,
          "created_at" timestamptz NOT NULL DEFAULT now()
        );
      `);
    }
    await queryRunner.query(`
      CREATE INDEX "IDX_audit_log_namespace_id" ON "audit_log" ("namespace_id");
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_audit_log_created_at" ON "audit_log" ("created_at");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_log";`);
  }
}
