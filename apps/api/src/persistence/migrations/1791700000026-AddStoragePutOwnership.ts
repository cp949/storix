/** storage PUT 소유권과 key별 GC claim의 영속 테이블을 만든다. 규칙은 api ADR-0045다. */
import { MigrationInterface, QueryRunner } from 'typeorm';

/** 온라인 storage PUT 소유권과 key별 GC claim을 SQLite·PostgreSQL에 저장한다. */
export class AddStoragePutOwnership1791700000026 implements MigrationInterface {
  name = 'AddStoragePutOwnership1791700000026';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const sqlite = queryRunner.connection.options.type === 'better-sqlite3';
    const timestamp = sqlite ? 'datetime' : 'timestamptz';
    await queryRunner.query(`
      CREATE TABLE "storage_put_execution" (
        "execution_id" varchar(36) PRIMARY KEY,
        "started_at" ${timestamp} NOT NULL,
        "stopped_confirmed_at" ${timestamp}
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "storage_put_key" (
        "storage_key" text PRIMARY KEY,
        "gc_claim_id" varchar(36),
        "gc_execution_id" varchar(36),
        "gc_claimed_at" ${timestamp}
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "storage_put_attempt" (
        "attempt_id" varchar(36) PRIMARY KEY,
        "execution_id" varchar(36) NOT NULL,
        "storage_key" text NOT NULL,
        "state" varchar(16) NOT NULL,
        "created_at" ${timestamp} NOT NULL,
        "settled_at" ${timestamp}
      )
    `);
    await queryRunner.query(
      'CREATE INDEX "idx_storage_put_attempt_key" ON "storage_put_attempt" ("storage_key")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "idx_storage_put_attempt_key"');
    await queryRunner.query('DROP TABLE "storage_put_attempt"');
    await queryRunner.query('DROP TABLE "storage_put_key"');
    await queryRunner.query('DROP TABLE "storage_put_execution"');
  }
}
