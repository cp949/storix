import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGcState1789300000000 implements MigrationInterface {
  name = 'AddGcState1789300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') {
      // gc_state는 GcLock(advisory lock 기반 멀티 인스턴스 중복 실행 방지)
      // 전용 테이블이다. SQLite는 단일 인스턴스 전용이라 이 문제 자체가
      // 없어(Plan B에서 GcLock을 SQLite용 no-op으로 교체) 테이블이 필요
      // 없다.
      return;
    }
    await queryRunner.query(`
      CREATE TABLE "gc_state" (
        "id" smallint PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
        "last_completed_at" timestamptz
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') {
      return;
    }
    await queryRunner.query(`DROP TABLE "gc_state";`);
  }
}
