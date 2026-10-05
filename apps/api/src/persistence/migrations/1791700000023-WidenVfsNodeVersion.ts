import { MigrationInterface, QueryRunner } from 'typeorm';

// vfs_node.version이 integer라 root가 2147483647에 닿으면 namespace 전체 쓰기가 영구 409가 된다.
// 모든 mutation이 조상을 root까지 올리므로 root가 가장 먼저 닿는다. bigint로 넓힌다.
// PostgreSQL은 테이블을 재작성하고 ACCESS EXCLUSIVE 락을 잡는다. 대형 테이블은 점검 창에서 적용한다.
// SQLite integer는 64비트라 변경이 필요 없고, 컬럼 변경에 테이블 재생성이 필요해 건너뛴다.
export class WidenVfsNodeVersion1791700000023 implements MigrationInterface {
  name = 'WidenVfsNodeVersion1791700000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'better-sqlite3') return;
    await queryRunner.query('ALTER TABLE "vfs_node" ALTER COLUMN "version" TYPE bigint');
  }

  // 2147483647을 넘는 version이 있으면 22003으로 실패한다. 값을 자르지 않고 롤백을 중단한다.
  public async down(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type === 'better-sqlite3') return;
    await queryRunner.query('ALTER TABLE "vfs_node" ALTER COLUMN "version" TYPE integer');
  }
}
