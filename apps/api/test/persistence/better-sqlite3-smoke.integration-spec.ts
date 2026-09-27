import { DataSource } from 'typeorm';

describe('better-sqlite3 드라이버 스모크 테스트', () => {
  it('better-sqlite3 DataSource를 초기화하고 쿼리를 실행할 수 있다', async () => {
    const dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: false,
    });

    await dataSource.initialize();
    await dataSource.query('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await dataSource.query('INSERT INTO t (id, v) VALUES (1, ?)', ['hello']);
    const rows = await dataSource.query('SELECT * FROM t');

    expect(rows).toEqual([{ id: 1, v: 'hello' }]);

    await dataSource.destroy();
  });
});
