/** 삭제 operation과 최초 HTTP 응답 receipt를 namespace tombstone에 연결한다. */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNamespaceDeletion1791700000011 implements MigrationInterface {
  name = 'AddNamespaceDeletion1791700000011';

  async up(runner: QueryRunner): Promise<void> {
    const sqlite = runner.connection.options.type === 'better-sqlite3';
    const uuid = sqlite ? 'varchar(36)' : 'uuid';
    const time = sqlite ? 'datetime' : 'timestamptz';
    await runner.query(`CREATE TABLE "namespace_deletion" (
      "namespace_id" ${uuid} PRIMARY KEY REFERENCES "namespace"("id"),
      "phase" varchar(16) NOT NULL CHECK ("phase" IN ('UPLOADS', 'METADATA', 'OBJECTS', 'COMPLETED')),
      "requested_at" ${time} NOT NULL,
      "updated_at" ${time} NOT NULL,
      "completed_at" ${time},
      "blocked_reason" varchar(32) CHECK ("blocked_reason" IN ('UPLOAD_SETTLEMENT_UNKNOWN', 'STORAGE_DELETE_FAILED', 'DATA_INCONSISTENT')),
      CONSTRAINT "CHK_namespace_deletion_completed" CHECK (("phase" = 'COMPLETED' AND "completed_at" IS NOT NULL) OR ("phase" <> 'COMPLETED' AND "completed_at" IS NULL))
    )`);
    await runner.query(
      `CREATE INDEX "idx_namespace_deletion_open" ON "namespace_deletion" ("namespace_id") WHERE "phase" <> 'COMPLETED'`,
    );
    await runner.query(`CREATE TABLE "namespace_deletion_receipt" (
      "namespace_id" ${uuid} NOT NULL REFERENCES "namespace"("id"),
      "key_hash" char(64) NOT NULL,
      "response_status" smallint NOT NULL CHECK ("response_status" IN (200, 202)),
      "response_body" jsonb NOT NULL,
      "created_at" ${time} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY ("namespace_id", "key_hash")
    )`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "namespace_deletion_receipt"');
    await runner.query('DROP TABLE "namespace_deletion"');
  }
}
