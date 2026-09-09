import { DataSource, QueryRunner } from 'typeorm';
import { rebuildSqliteTable, withSqliteTableRebuild } from './sqlite-table-rebuild.js';

// AddNamespaceResourceLimits/AddEncryptionSupport 마이그레이션이 실제로 쓰는
// "CREATE 새 이름 → INSERT...SELECT → DROP → RENAME (+ 인덱스)"와 그걸
// 감싸는 PRAGMA/트랜잭션 골격을 이 파일이 직접 검증한다 — 두 마이그레이션은
// 이 헬퍼를 호출하기만 하므로 여기서 실제 SQLite 엔진으로 확인해야 의미가
// 있다(mock으로는 SQL 자체가 맞는지 알 수 없다).
describe('rebuildSqliteTable/withSqliteTableRebuild', () => {
  if (process.env.STORIX_DB_DRIVER !== 'sqlite') {
    throw new Error(
      'STORIX_DB_DRIVER=sqlite 환경변수 없이 이 파일을 실행하면 better-sqlite3 드라이버 자체가 없어 의미가 없다',
    );
  }

  let dataSource: DataSource;
  let queryRunner: QueryRunner;

  beforeEach(async () => {
    dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:', synchronize: false });
    await dataSource.initialize();
    await dataSource.query(`CREATE TABLE "widget" ("id" varchar(36) PRIMARY KEY, "name" varchar(64) NOT NULL)`);
    await dataSource.query(`INSERT INTO "widget" ("id", "name") VALUES ('1', 'a')`);
    queryRunner = dataSource.createQueryRunner();
  });

  afterEach(async () => {
    await queryRunner.release();
    await dataSource.destroy();
  });

  it('기존 row를 보존하면서 새 컬럼과 인덱스가 추가된 스키마로 재구성한다', async () => {
    await rebuildSqliteTable(queryRunner, {
      table: 'widget',
      tempSuffix: 'new',
      createTableBody: `"id" varchar(36) PRIMARY KEY, "name" varchar(64) NOT NULL, "note" varchar(64)`,
      copyColumns: ['id', 'name'],
      indexSql: [`CREATE INDEX "IDX_widget_name" ON "widget" ("name")`],
    });

    const rows = await dataSource.query('SELECT id, name, note FROM widget');
    expect(rows).toEqual([{ id: '1', name: 'a', note: null }]);

    const indexes = await dataSource.query(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='IDX_widget_name'`,
    );
    expect(indexes).toHaveLength(1);
  });

  it('여러 테이블 재구성을 하나의 트랜잭션으로 묶어 전부 반영한다', async () => {
    await dataSource.query(`CREATE TABLE "gadget" ("id" varchar(36) PRIMARY KEY)`);
    await dataSource.query(`INSERT INTO "gadget" ("id") VALUES ('g1')`);

    await withSqliteTableRebuild(queryRunner, async (qr) => {
      await rebuildSqliteTable(qr, {
        table: 'widget',
        tempSuffix: 'new',
        createTableBody: `"id" varchar(36) PRIMARY KEY, "name" varchar(64) NOT NULL, "note" varchar(64)`,
        copyColumns: ['id', 'name'],
      });
      await rebuildSqliteTable(qr, {
        table: 'gadget',
        tempSuffix: 'new',
        createTableBody: `"id" varchar(36) PRIMARY KEY, "label" varchar(64)`,
        copyColumns: ['id'],
      });
    });

    const widgetColumns: { name: string }[] = await dataSource.query(`PRAGMA table_info(widget)`);
    expect(widgetColumns.map((c) => c.name)).toContain('note');
    const gadgetColumns: { name: string }[] = await dataSource.query(`PRAGMA table_info(gadget)`);
    expect(gadgetColumns.map((c) => c.name)).toContain('label');
  });

  it('도중 실패하면 이미 끝낸 재구성까지 전부 롤백하고 원래 데이터를 보존한다', async () => {
    await expect(
      withSqliteTableRebuild(queryRunner, async (qr) => {
        await rebuildSqliteTable(qr, {
          table: 'widget',
          tempSuffix: 'new',
          createTableBody: `"id" varchar(36) PRIMARY KEY, "name" varchar(64) NOT NULL, "note" varchar(64)`,
          copyColumns: ['id', 'name'],
        });
        await qr.query('SELECT * FROM "no_such_table"');
      }),
    ).rejects.toThrow();

    const columns: { name: string }[] = await dataSource.query(`PRAGMA table_info(widget)`);
    expect(columns.map((c) => c.name)).not.toContain('note');
    const rows = await dataSource.query('SELECT id, name FROM widget');
    expect(rows).toEqual([{ id: '1', name: 'a' }]);
  });
});
