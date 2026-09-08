import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGcState1789300000000 implements MigrationInterface {
  name = 'AddGcState1789300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "gc_state" (
        "id" smallint PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
        "last_completed_at" timestamptz
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "gc_state";`);
  }
}
