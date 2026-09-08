import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddBlobZeroSince1788800000000 implements MigrationInterface {
  name = 'AddBlobZeroSince1788800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isSqlite = queryRunner.connection.options.type === 'better-sqlite3';
    const columnType = isSqlite ? 'datetime' : 'timestamptz';
    const nowExpr = isSqlite ? "datetime('now')" : 'now()';

    await queryRunner.query(`ALTER TABLE "blob" ADD COLUMN "zero_since" ${columnType}`);

    // GC의 grace period 계산 대상이 될 수 있도록, 마이그레이션 전부터 존재하던 reference_count=0 blob도 zero_since 설정
    await queryRunner.query(`UPDATE "blob" SET "zero_since" = ${nowExpr} WHERE "reference_count" = 0`);

    await queryRunner.query(
      `CREATE INDEX "IDX_blob_reference_count_zero_since" ON "blob" ("zero_since") WHERE "reference_count" = 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_blob_reference_count_zero_since"`);
    await queryRunner.query(`ALTER TABLE "blob" DROP COLUMN "zero_since"`);
  }
}
