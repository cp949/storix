import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddVfsMutationReceipt1789400000000 implements MigrationInterface {
  name = 'AddVfsMutationReceipt1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'better-sqlite3') {
      await queryRunner.query(`
        CREATE TABLE "vfs_mutation_receipt" (
          "namespace_id" varchar(36) NOT NULL REFERENCES "namespace"("id") ON DELETE CASCADE,
          "scope" varchar(128) NOT NULL,
          "idempotency_key" varchar(36) NOT NULL,
          "state" varchar(16) NOT NULL CHECK ("state" IN ('RESERVED', 'COMPLETE')),
          "generation" integer NOT NULL CHECK ("generation" > 0),
          "lease_expires_at" datetime,
          "expires_at" datetime NOT NULL,
          "method" varchar(16),
          "fingerprint" char(64),
          "response_status" smallint,
          "response_body" text,
          "response_headers" text,
          "created_at" datetime NOT NULL DEFAULT (datetime('now')),
          "updated_at" datetime NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY ("namespace_id", "scope", "idempotency_key")
        )
      `);
    } else {
      await queryRunner.query(`
        CREATE TABLE "vfs_mutation_receipt" (
          "namespace_id" uuid NOT NULL REFERENCES "namespace"("id") ON DELETE CASCADE,
          "scope" varchar(128) NOT NULL,
          "idempotency_key" uuid NOT NULL,
          "state" varchar(16) NOT NULL CHECK ("state" IN ('RESERVED', 'COMPLETE')),
          "generation" integer NOT NULL CHECK ("generation" > 0),
          "lease_expires_at" timestamptz,
          "expires_at" timestamptz NOT NULL,
          "method" varchar(16),
          "fingerprint" char(64),
          "response_status" smallint,
          "response_body" text,
          "response_headers" text,
          "created_at" timestamptz NOT NULL DEFAULT now(),
          "updated_at" timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY ("namespace_id", "scope", "idempotency_key")
        )
      `);
    }
    await queryRunner.query(`CREATE INDEX "idx_vfs_mutation_receipt_lease"
      ON "vfs_mutation_receipt" ("state", "lease_expires_at")`);
    await queryRunner.query(`CREATE INDEX "idx_vfs_mutation_receipt_expires"
      ON "vfs_mutation_receipt" ("expires_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "vfs_mutation_receipt"');
  }
}
