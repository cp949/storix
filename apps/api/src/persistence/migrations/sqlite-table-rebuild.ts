import type { QueryRunner } from 'typeorm';

// SQLite는 CHECK 제약이 걸린 컬럼 추가/변경에 ALTER를 지원하지 않는다 —
// "새 이름으로 CREATE → INSERT...SELECT로 데이터 복사 → 기존 DROP → RENAME"
// 재구성이 유일한 방법이다. 이 파일은 AddNamespaceResourceLimits/
// AddEncryptionSupport에서 4벌 반복되던 그 절차의 골격만 가진다 — CREATE TABLE
// 본문(컬럼/제약조건)과 복사할 컬럼 목록은 마이그레이션마다 실제로 다르므로
// 호출부가 그대로 넘긴다.

/**
 * PRAGMA foreign_keys=OFF와 수동 BEGIN/COMMIT/ROLLBACK으로 fn을 감싼다.
 * PRAGMA foreign_keys는 트랜잭션 안에서는 no-op이라 TypeORM이 자동으로 여는
 * 트랜잭션을 쓸 수 없다(migration 인스턴스가 transaction=false를 설정해야
 * 하는 이유). fn 안에서 여러 테이블을 재구성해도 하나의 트랜잭션으로 묶인다.
 */
export async function withSqliteTableRebuild(
  queryRunner: QueryRunner,
  fn: (queryRunner: QueryRunner) => Promise<void>,
): Promise<void> {
  await queryRunner.query('PRAGMA foreign_keys=OFF');
  try {
    await queryRunner.query('BEGIN TRANSACTION');
    await fn(queryRunner);
    await queryRunner.query('COMMIT');
  } catch (error) {
    try {
      await queryRunner.query('ROLLBACK');
    } catch {
      // 원본 에러를 가리지 않기 위해 ROLLBACK 실패는 무시한다.
    }
    throw error;
  } finally {
    await queryRunner.query('PRAGMA foreign_keys=ON');
  }
}

export interface SqliteTableRebuildSpec {
  /** 재구성 대상 테이블 이름(재구성 후에도 최종적으로 이 이름을 유지한다). */
  readonly table: string;
  /** 임시 테이블 접미사. up()은 'new', down()은 보통 'old'를 쓴다. */
  readonly tempSuffix: 'new' | 'old';
  /** `CREATE TABLE "<table>_<tempSuffix>" (<createTableBody>)`로 감싼다. */
  readonly createTableBody: string;
  /** 기존 테이블에서 새 테이블로 그대로 복사할 컬럼 목록. */
  readonly copyColumns: readonly string[];
  /** RENAME 이후 실행할 CREATE INDEX 문(있는 경우). */
  readonly indexSql?: readonly string[];
}

/** withSqliteTableRebuild 안에서 호출해야 한다(트랜잭션/PRAGMA는 스스로 열지 않는다). */
export async function rebuildSqliteTable(queryRunner: QueryRunner, spec: SqliteTableRebuildSpec): Promise<void> {
  const tempTable = `${spec.table}_${spec.tempSuffix}`;
  const columnList = spec.copyColumns.join(', ');

  await queryRunner.query(`CREATE TABLE "${tempTable}" (${spec.createTableBody})`);
  await queryRunner.query(`INSERT INTO "${tempTable}" (${columnList}) SELECT ${columnList} FROM "${spec.table}"`);
  await queryRunner.query(`DROP TABLE "${spec.table}"`);
  await queryRunner.query(`ALTER TABLE "${tempTable}" RENAME TO "${spec.table}"`);

  for (const sql of spec.indexSql ?? []) {
    await queryRunner.query(sql);
  }
}
