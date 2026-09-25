import { DataSource } from 'typeorm';
import { installSqliteGate } from './sqlite-gate.js';
import { SqliteGateTimeoutError } from './sqlite-gate.errors.js';

const tick = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('SQLite 쿼리 게이트', () => {
  let ds: DataSource;

  async function open(waitTimeoutMs?: number) {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await ds.initialize();
    await ds.query('CREATE TABLE t (v TEXT)');
    installSqliteGate(ds, { waitTimeoutMs });
  }

  const rows = async () => (await ds.query('SELECT v FROM t ORDER BY rowid')).map((r: { v: string }) => r.v);

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('겹친 트랜잭션은 순서대로 실행되어 앞 트랜잭션의 롤백이 뒤 트랜잭션의 커밋을 지우지 않는다', async () => {
    await open();
    const firstMayEnd = deferred();
    const first = ds
      .transaction(async (m) => {
        await m.query("INSERT INTO t VALUES ('t1')");
        await firstMayEnd.promise;
        throw new Error('t1 롤백');
      })
      .catch((e: Error) => e.message);
    await tick();
    const second = ds.transaction(async (m) => {
      await m.query("INSERT INTO t VALUES ('t2')");
    });
    await tick(20);
    firstMayEnd.resolve();

    expect(await first).toBe('t1 롤백');
    await second;
    expect(await rows()).toEqual(['t2']);
  });

  it('트랜잭션이 열려 있는 동안 트랜잭션 밖 쿼리는 끝날 때까지 대기한다', async () => {
    await open();
    const mayEnd = deferred();
    const tx = ds
      .transaction(async (m) => {
        await m.query("INSERT INTO t VALUES ('a')");
        await mayEnd.promise;
        throw new Error('a 롤백');
      })
      .catch(() => undefined);
    await tick();
    let outsideDone = false;
    const outside = ds.query("INSERT INTO t VALUES ('outside')").then(() => {
      outsideDone = true;
    });
    await tick(20);
    expect(outsideDone).toBe(false);

    mayEnd.resolve();
    await tx;
    await outside;
    // 밖 쿼리의 쓰기는 앞 트랜잭션의 롤백에 휩쓸리지 않는다
    expect(await rows()).toEqual(['outside']);
  });

  it('트랜잭션 밖 읽기는 열린 트랜잭션의 미커밋 쓰기를 보지 않는다', async () => {
    await open();
    const mayEnd = deferred();
    const tx = ds.transaction(async (m) => {
      await m.query("INSERT INTO t VALUES ('uncommitted')");
      await mayEnd.promise;
    });
    await tick();
    const seen = ds.query('SELECT v FROM t').then((r: { v: string }[]) => r.map((x) => x.v));
    await tick(20);
    mayEnd.resolve();
    await tx;

    // 읽기는 트랜잭션이 끝난 뒤에 실행되므로 커밋된 값만 본다(대기 후 실행)
    expect(await seen).toEqual(['uncommitted']);
    expect(await rows()).toEqual(['uncommitted']);
  });

  it('여러 트랜잭션은 시작 순서대로 하나씩 실행된다', async () => {
    await open();
    const log: string[] = [];
    const run = (name: string) =>
      ds.transaction(async (m) => {
        log.push(`begin:${name}`);
        await m.query('INSERT INTO t VALUES (?)', [name]);
        await tick(15);
        log.push(`end:${name}`);
      });
    await Promise.all([run('a'), run('b'), run('c')]);

    expect(log).toEqual(['begin:a', 'end:a', 'begin:b', 'end:b', 'begin:c', 'end:c']);
    expect(await rows()).toEqual(['a', 'b', 'c']);
  });

  it('트랜잭션 콜백 안에서 manager 없이 실행한 쿼리는 교착 없이 같은 트랜잭션에 참여한다', async () => {
    await open(200);
    await ds
      .transaction(async (m) => {
        await m.query("INSERT INTO t VALUES ('x')");
        const seen = await ds.query('SELECT v FROM t');
        expect(seen).toEqual([{ v: 'x' }]);
        throw new Error('롤백');
      })
      .catch(() => undefined);

    expect(await rows()).toEqual([]);
  });

  it('트랜잭션 콜백 안에서 다시 연 트랜잭션은 교착 없이 중첩된다', async () => {
    await open(200);
    await ds.transaction(async (outer) => {
      await outer.query("INSERT INTO t VALUES ('outer')");
      await ds.transaction(async (inner) => {
        await inner.query("INSERT INTO t VALUES ('inner')");
      });
    });

    expect(await rows()).toEqual(['outer', 'inner']);
  });

  it('runner를 직접 잡아 연 트랜잭션도 다른 쿼리를 대기시키고 자기 쿼리는 통과시킨다', async () => {
    await open();
    const runner = ds.createQueryRunner();
    await runner.startTransaction();
    await runner.query("INSERT INTO t VALUES ('r')");
    let outsideDone = false;
    const outside = ds.query("INSERT INTO t VALUES ('outside')").then(() => {
      outsideDone = true;
    });
    await tick(20);
    expect(outsideDone).toBe(false);

    await runner.rollbackTransaction();
    await runner.release();
    await outside;
    expect(await rows()).toEqual(['outside']);
  });

  it('대기 상한을 넘기면 SqliteGateTimeoutError로 실패하고 그 쿼리는 나중에도 실행되지 않는다', async () => {
    await open(50);
    const mayEnd = deferred();
    const tx = ds.transaction(async (m) => {
      await m.query("INSERT INTO t VALUES ('held')");
      await mayEnd.promise;
    });
    await tick();

    await expect(ds.query("INSERT INTO t VALUES ('late')")).rejects.toBeInstanceOf(SqliteGateTimeoutError);
    mayEnd.resolve();
    await tx;
    await tick(20);

    expect(await rows()).toEqual(['held']);
    // 타임아웃 뒤에도 게이트는 정상 동작한다
    await ds.query("INSERT INTO t VALUES ('after')");
    expect(await rows()).toEqual(['held', 'after']);
  });

  it('destroy 뒤 다시 initialize해도 이전 연결의 prepared statement를 쓰지 않는다', async () => {
    await open();
    await ds.query("INSERT INTO t VALUES ('before')");
    await ds.destroy();
    await ds.initialize();
    await ds.query('CREATE TABLE t (v TEXT)');

    await ds.query("INSERT INTO t VALUES ('after')");
    expect(await rows()).toEqual(['after']);
  });
});
