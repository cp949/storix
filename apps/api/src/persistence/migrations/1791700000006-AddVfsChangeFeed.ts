import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVfsChangeFeed1791700000006 implements MigrationInterface {
  name = 'AddVfsChangeFeed1791700000006';

  async up(runner: QueryRunner): Promise<void> {
    const sqlite = runner.connection.options.type === 'better-sqlite3';
    const uuid = sqlite ? 'varchar(36)' : 'uuid';
    const time = sqlite ? 'datetime' : 'timestamptz';
    await runner.query(`CREATE TABLE "vfs_change_feed_state" (
      "namespace_id" ${uuid} PRIMARY KEY REFERENCES "namespace"("id") ON DELETE CASCADE,
      "last_sequence" bigint NOT NULL DEFAULT 0 CHECK ("last_sequence" >= 0),
      "pruned_through" bigint NOT NULL DEFAULT 0 CHECK ("pruned_through" >= 0 AND "pruned_through" <= "last_sequence"),
      "has_checkpoint" boolean NOT NULL DEFAULT ${sqlite ? '0' : 'false'},
      "signing_secret" varchar(64) NOT NULL CHECK (length("signing_secret") = 64)
    )`);
    await runner.query(`CREATE TABLE "vfs_change_event" (
      "namespace_id" ${uuid} NOT NULL REFERENCES "namespace"("id") ON DELETE CASCADE,
      "sequence" bigint NOT NULL CHECK ("sequence" > 0),
      "operation_id" ${uuid} NOT NULL,
      "operation_index" integer NOT NULL CHECK ("operation_index" >= 0),
      "operation_count" integer NOT NULL CHECK ("operation_count" > 0 AND "operation_index" < "operation_count"),
      "kind" varchar(16) NOT NULL CHECK ("kind" IN ('created', 'updated', 'moved', 'deleted')),
      "node_id" ${uuid} NOT NULL,
      "node_type" varchar(16) NOT NULL CHECK ("node_type" IN ('FILE', 'DIRECTORY')),
      "path" text NOT NULL,
      "previous_path" text,
      "revision" varchar(128),
      "occurred_at" ${time} NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PK_vfs_change_event" PRIMARY KEY ("namespace_id", "sequence"),
      CONSTRAINT "CHK_vfs_change_event_tombstone" CHECK (("kind" = 'deleted' AND "previous_path" IS NULL AND "revision" IS NULL) OR ("kind" <> 'deleted' AND "revision" IS NOT NULL))
    )`);
    await runner.query('CREATE INDEX "idx_vfs_change_event_occurred_at" ON "vfs_change_event" ("occurred_at", "namespace_id", "sequence")');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "vfs_change_event"');
    await runner.query('DROP TABLE "vfs_change_feed_state"');
  }
}
