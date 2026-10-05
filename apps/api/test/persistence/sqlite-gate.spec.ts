import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { installSqliteGate } from '../../src/persistence/sqlite-gate.js';
import {
  SqliteGateTimeoutError,
  SqliteTransactionAbortedError,
} from '../../src/persistence/sqlite-gate.errors.js';

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

  it('트랜잭션 시작이 대기 상한을 넘겨 실패해도 게이트를 쥔 트랜잭션은 롤백되지 않고 커밋된다', async () => {
    await open(50);
    const mayEnd = deferred();
    const holder = ds.transaction(async (m) => {
      await m.query("INSERT INTO t VALUES ('held')");
      await mayEnd.promise;
      await m.query("INSERT INTO t VALUES ('held-2')");
    });
    await tick();

    await expect(
      ds.transaction(async (m) => {
        await m.query("INSERT INTO t VALUES ('waiter')");
      }),
    ).rejects.toBeInstanceOf(SqliteGateTimeoutError);
    mayEnd.resolve();
    await holder;

    expect(await rows()).toEqual(['held', 'held-2']);
  });

  it('repository.save처럼 TypeORM이 직접 연 트랜잭션이 대기 상한을 넘겨도 소유 트랜잭션은 커밋된다', async () => {
    await open(50);
    const mayEnd = deferred();
    const holder = ds.transaction(async (m) => {
      await m.query("INSERT INTO t VALUES ('held')");
      await mayEnd.promise;
    });
    await tick();

    const runner = ds.createQueryRunner();
    await expect(runner.startTransaction()).rejects.toBeInstanceOf(SqliteGateTimeoutError);
    // TypeORM은 startTransaction이 실패하면 같은 runner에서 rollbackTransaction을 호출한다.
    await runner.rollbackTransaction().catch(() => undefined);
    await runner.release();
    mayEnd.resolve();
    await holder;

    expect(await rows()).toEqual(['held']);
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

  // PRAGMA max_page_count로 DB 크기를 막아 실제 SQLITE_FULL(트랜잭션 자동 롤백)을 일으킨다.
  async function fillUntilFull(m: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) {
    for (let i = 0; i < 100; i++) await m.query('INSERT INTO t VALUES (?)', ['x'.repeat(4000)]);
  }

  interface RawConnection {
    inTransaction: boolean;
    prepare: (sql: string) => unknown;
    exec: (sql: string) => unknown;
  }
  const connectionOf = () =>
    (ds.driver as unknown as { databaseConnection: RawConnection }).databaseConnection;

  describe('SQLite가 트랜잭션을 자동 롤백한 경우', () => {
    beforeEach(async () => {
      await open(300);
      await ds.query('PRAGMA max_page_count = 20');
    });

    it('최상위 트랜잭션이 SQLITE_FULL로 자동 롤백돼도 게이트가 해제되어 이후 쿼리가 정상 동작한다', async () => {
      const error = await ds.transaction((m) => fillUntilFull(m)).catch((e: { code?: string }) => e);
      expect(error).toMatchObject({ code: 'SQLITE_FULL' });
      expect(connectionOf().inTransaction).toBe(false);

      await ds.query("INSERT INTO t VALUES ('after')");
      expect(await rows()).toEqual(['after']);
      // 해제 뒤 새 트랜잭션도 시작할 수 있다
      await ds.transaction(async (m) => {
        await m.query("INSERT INTO t VALUES ('next')");
      });
      expect(await rows()).toEqual(['after', 'next']);
    });

    it('자동 롤백된 트랜잭션을 기다리던 다른 트랜잭션은 이어서 정상 실행된다', async () => {
      const mayFill = deferred();
      const first = ds
        .transaction(async (m) => {
          await mayFill.promise;
          await fillUntilFull(m);
        })
        .catch(() => 'full');
      await tick();
      const second = ds.transaction(async (m) => {
        await m.query("INSERT INTO t VALUES ('second')");
      });
      await tick(20);
      mayFill.resolve();

      expect(await first).toBe('full');
      await second;
      expect(await rows()).toEqual(['second']);
    });

    it('중첩 트랜잭션이 자동 롤백된 뒤 바깥이 오류를 삼키고 계속해도 쿼리를 실행하지 않는다', async () => {
      let afterAbort: unknown;
      const outerError = await ds
        .transaction(async (outer) => {
          await outer.query("INSERT INTO t VALUES ('outer')");
          await ds.transaction((inner) => fillUntilFull(inner)).catch(() => undefined);
          // 자동 롤백 뒤라 이 쓰기가 autocommit으로 남으면 안 된다
          afterAbort = await outer.query("INSERT INTO t VALUES ('leak')").catch((e: unknown) => e);
        })
        .catch((e: unknown) => e);

      expect(afterAbort).toBeInstanceOf(SqliteTransactionAbortedError);
      // 바깥 트랜잭션은 커밋되지 않고 오류로 끝난다
      expect(outerError).toBeInstanceOf(SqliteTransactionAbortedError);
      expect(await rows()).toEqual([]);
    });

    it('중첩 자동 롤백이 있는 최상위 트랜잭션이 끝나면 게이트가 해제된다', async () => {
      await ds
        .transaction(async (outer) => {
          await ds.transaction((inner) => fillUntilFull(inner)).catch(() => undefined);
          await outer.query('SELECT 1').catch(() => undefined);
        })
        .catch(() => undefined);

      await ds.query("INSERT INTO t VALUES ('after')");
      expect(await rows()).toEqual(['after']);
    });
  });

  describe('카운터가 0인데 연결에 트랜잭션이 남은 경우', () => {
    // TypeORM의 ROLLBACK만 실패시켜 연결에 트랜잭션이 열린 채 남게 만든다.
    function failRollback(connection: RawConnection) {
      const original = connection.prepare.bind(connection);
      return jest.spyOn(connection, 'prepare').mockImplementation((sql: string) => {
        if (sql === 'ROLLBACK') throw new Error('ROLLBACK 실패');
        return original(sql);
      });
    }

    it('ROLLBACK을 직접 재시도해 트랜잭션이 닫히면 게이트를 해제한다', async () => {
      await open(300);
      const prepare = failRollback(connectionOf());
      await ds
        .transaction(async (m) => {
          await m.query("INSERT INTO t VALUES ('a')");
          throw new Error('콜백 실패');
        })
        .catch(() => undefined);
      prepare.mockRestore();

      expect(connectionOf().inTransaction).toBe(false);
      await ds.query("INSERT INTO t VALUES ('after')");
      expect(await rows()).toEqual(['after']);
    });

    it('재시도해도 트랜잭션이 남으면 게이트를 해제하지 않고 오류 로그를 남긴다', async () => {
      await open(50);
      const connection = connectionOf();
      const prepare = failRollback(connection);
      const exec = jest.spyOn(connection, 'exec').mockImplementation(() => {
        throw new Error('재시도 ROLLBACK 실패');
      });
      const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      await ds
        .transaction(async (m) => {
          await m.query("INSERT INTO t VALUES ('a')");
          throw new Error('콜백 실패');
        })
        .catch(() => undefined);

      expect(logError).toHaveBeenCalledTimes(1);
      await expect(ds.query('SELECT 1')).rejects.toBeInstanceOf(SqliteGateTimeoutError);

      prepare.mockRestore();
      exec.mockRestore();
      logError.mockRestore();
    });
  });
});
