import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVfsUploadSessions1791700000000 implements MigrationInterface {
  name = 'AddVfsUploadSessions1791700000000';

  public async up(runner: QueryRunner): Promise<void> {
    const sqlite = runner.connection.options.type === 'better-sqlite3';
    const uuid = sqlite ? 'varchar(36)' : 'uuid';
    const time = sqlite ? 'datetime' : 'timestamptz';
    await runner.query(`CREATE TABLE "vfs_upload_usage" (
      "id" varchar(40) PRIMARY KEY,
      "namespace_id" ${uuid} UNIQUE REFERENCES "namespace"("id"),
      "active_sessions" bigint NOT NULL DEFAULT 0 CHECK ("active_sessions" >= 0),
      "staged_bytes" bigint NOT NULL DEFAULT 0 CHECK ("staged_bytes" >= 0),
      CONSTRAINT "CHK_vfs_upload_usage_scope" CHECK (("id" = 'global' AND "namespace_id" IS NULL) OR ("id" <> 'global' AND "namespace_id" IS NOT NULL))
    )`);
    await runner.query(`INSERT INTO "vfs_upload_usage" ("id", "namespace_id") VALUES ('global', NULL)`);
    await runner.query(`CREATE TABLE "vfs_upload_session" (
      "id" ${uuid} PRIMARY KEY,
      "namespace_id" ${uuid} NOT NULL REFERENCES "namespace"("id"),
      "scope" varchar(128) NOT NULL,
      "creation_key" ${uuid} NOT NULL,
      "fingerprint" varchar(64) NOT NULL,
      "target_path" text NOT NULL,
      "size_bytes" bigint NOT NULL CHECK ("size_bytes" >= 0),
      "mime_type" varchar(255) NOT NULL,
      "condition_type" varchar(16) NOT NULL CHECK ("condition_type" IN ('ABSENT', 'REVISION')),
      "condition_revision" varchar(128),
      "part_size_bytes" integer NOT NULL CHECK ("part_size_bytes" > 0),
      "part_count" integer NOT NULL CHECK ("part_count" >= 0),
      "state" varchar(16) NOT NULL CHECK ("state" IN ('OPEN', 'FINALIZING', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
      "lease_expires_at" ${time},
      "expires_at" ${time} NOT NULL,
      "max_expires_at" ${time} NOT NULL,
      "terminal_at" ${time},
      "response_status" integer,
      "response_body" text,
      "request_id" varchar(128),
      "created_at" ${time} NOT NULL,
      "updated_at" ${time} NOT NULL,
      CONSTRAINT "UQ_vfs_upload_session_creation" UNIQUE ("namespace_id", "scope", "creation_key"),
      CONSTRAINT "CHK_vfs_upload_session_condition" CHECK (("condition_type" = 'ABSENT' AND "condition_revision" IS NULL) OR ("condition_type" = 'REVISION' AND "condition_revision" IS NOT NULL))
    )`);
    await runner.query(
      'CREATE INDEX "idx_vfs_upload_session_state_expires" ON "vfs_upload_session" ("state", "expires_at")',
    );
    await runner.query(
      'CREATE INDEX "idx_vfs_upload_session_terminal" ON "vfs_upload_session" ("terminal_at")',
    );
    await runner.query(`CREATE TABLE "vfs_upload_part" (
      "session_id" ${uuid} NOT NULL REFERENCES "vfs_upload_session"("id") ON DELETE CASCADE,
      "part_index" integer NOT NULL CHECK ("part_index" >= 0),
      "size_bytes" bigint NOT NULL CHECK ("size_bytes" > 0),
      "staging_key" varchar(512) NOT NULL UNIQUE,
      "digest" varchar(64),
      "encryption_iv" varchar(32),
      "state" varchar(16) NOT NULL CHECK ("state" IN ('RESERVED', 'STORED', 'CLEANUP', 'DELETED')),
      "object_deleted_at" ${time},
      "created_at" ${time} NOT NULL,
      "updated_at" ${time} NOT NULL,
      CONSTRAINT "PK_vfs_upload_part" PRIMARY KEY ("session_id", "part_index")
    )`);
    await runner.query(
      'CREATE INDEX "idx_vfs_upload_part_state" ON "vfs_upload_part" ("state", "updated_at")',
    );
  }

  public async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "vfs_upload_part"');
    await runner.query('DROP TABLE "vfs_upload_session"');
    await runner.query('DROP TABLE "vfs_upload_usage"');
  }
}
