/**
 * GC 단계의 재개 위치를 저장한다. 실행 예산이 소진된 단계가 다음 실행에서 이어가는 데 쓴다.
 * 규칙은 docs/design/08-namespace-change-feed.md "보존 정리".
 */
import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGcCursor1791700000012 implements MigrationInterface {
  name = 'AddGcCursor1791700000012';

  async up(runner: QueryRunner): Promise<void> {
    const sqlite = runner.connection.options.type === 'better-sqlite3';
    const time = sqlite ? 'datetime' : 'timestamptz';
    await runner.query(`CREATE TABLE "gc_cursor" (
      "name" varchar(64) PRIMARY KEY,
      "position" text NOT NULL,
      "updated_at" ${time} NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TABLE "gc_cursor"');
  }
}
