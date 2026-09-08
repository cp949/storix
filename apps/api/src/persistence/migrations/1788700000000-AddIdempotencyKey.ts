import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddIdempotencyKey1788700000000 implements MigrationInterface {
  name = 'AddIdempotencyKey1788700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'better-sqlite3') {
      await queryRunner.query(`
        CREATE TABLE "idempotency_key" (
          "key" varchar(255) PRIMARY KEY,
          "request_hash" char(64) NOT NULL,
          "response_status" smallint NOT NULL,
          "response_body" jsonb NOT NULL,
          "created_at" datetime NOT NULL DEFAULT (datetime('now'))
        )
      `);
      return;
    }
    await queryRunner.query(`
      CREATE TABLE "idempotency_key" (
        "key" varchar(255) PRIMARY KEY,
        "request_hash" char(64) NOT NULL,
        "response_status" smallint NOT NULL,
        "response_body" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "idempotency_key";`);
  }
}
