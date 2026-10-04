import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';
import { SqliteGateTimeoutError, SqliteTransactionAbortedError } from './sqlite-gate.errors.js';

/** 게이트 대기 상한 기본값. receipt lease(60초)보다 짧게 잡는다. */
export const SQLITE_GATE_WAIT_TIMEOUT_MS = 30_000;

export interface SqliteGateOptions {
  readonly waitTimeoutMs?: number;
}

// TypeORM better-sqlite3 드라이버는 DataSource당 연결 하나와 QueryRunner 하나를 모든 호출자에게
// 재사용한다. 그 결과 (1) 같은 틱에 시작한 두 트랜잭션은 둘 다 BEGIN을 실행해 실패하고,
// (2) 뒤늦게 겹친 트랜잭션은 SAVEPOINT로 중첩돼 앞 트랜잭션의 롤백에 함께 사라지며,
// (3) 트랜잭션 밖 쿼리는 열린 트랜잭션에 섞인다.
// 이 모듈은 연결 하나를 유지한 채 모든 쿼리를 FIFO 게이트로 직렬화해 셋을 모두 막는다.

interface Waiter {
  readonly resolve: () => void;
  readonly timer: NodeJS.Timeout;
}

// 연결 사용권 하나를 FIFO로 넘겨주는 mutex. 해제 시 대기자가 있으면 잠금을 풀지 않고 그대로 넘긴다.
class QueryGate {
  /** 트랜잭션을 열어 사용권을 쥔 runner. 이 runner의 쿼리만 게이트를 거치지 않고 통과한다. */
  owner: QueryRunner | null = null;
  private locked = false;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly waitTimeoutMs: number) {}

  acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new SqliteGateTimeoutError(this.waitTimeoutMs));
      }, this.waitTimeoutMs);
      // 대기 중인 타이머가 프로세스 종료를 막지 않게 한다.
      timer.unref();
      const waiter: Waiter = { resolve, timer };
      this.waiters.push(waiter);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.locked = false;
      return;
    }
    clearTimeout(next.timer);
    next.resolve();
  }
}

// 최상위 트랜잭션(dataSource.transaction 한 번) 하나의 비동기 범위. 이 범위 안에서 만든
// QueryRunner 요청은 트랜잭션을 연 runner를 그대로 돌려받아 기존 공유 runner와 같은
// 동작(SAVEPOINT 중첩, 트랜잭션 안의 manager 없는 쿼리)을 유지한다.
interface TransactionScope {
  runner: QueryRunner | null;
  /** 트랜잭션이 끝난 뒤 남아 있는 비동기 흐름이 범위를 재사용하지 못하게 막는다. */
  done: boolean;
}

// better-sqlite3 연결 중 게이트가 쓰는 부분이다.
interface SqliteConnection {
  /** SQLite가 트랜잭션을 자동 롤백하면 false가 된다. */
  readonly inTransaction: boolean;
  exec(sql: string): unknown;
}

// TypeORM BaseQueryRunner의 트랜잭션 상태다. 타입 선언에는 노출되지 않는다.
interface RunnerTransactionState {
  isTransactionActive: boolean;
  transactionDepth: number;
}

const logger = new Logger('SqliteGate');

// 믹스인 패턴이 요구하는 시그니처다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RunnerConstructor = new (...args: any[]) => QueryRunner;

const installed = new WeakSet<DataSource>();

function createGatedRunnerClass(
  Base: RunnerConstructor,
  gate: QueryGate,
  scopes: AsyncLocalStorage<TransactionScope>,
) {
  return class GatedQueryRunner extends Base {
    private scope: TransactionScope | undefined;
    // 이 runner가 연 트랜잭션·SAVEPOINT의 중첩 깊이. TypeORM은 SQLite가 트랜잭션을 자동 롤백해
    // ROLLBACK·ROLLBACK TO SAVEPOINT가 실패하면 isTransactionActive·transactionDepth를 그대로 둔다.
    // 그 상태로는 해제 시점을 알 수 없어 게이트가 영구 점유되므로 깊이를 따로 센다.
    private gateDepth = 0;

    private get rawConnection(): SqliteConnection {
      return (this.dataSource.driver as unknown as { databaseConnection: SqliteConnection })
        .databaseConnection;
    }

    // 소유자 runner는 게이트를 이미 쥐고 있으므로 통과하고, 그 외에는 쿼리마다 한 번 대기한다.
    // QueryRunner.query의 오버로드(일반/structured 결과)를 모두 만족하려면 any가 필요하다.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    override async query(query: string, parameters?: any, useStructuredResult?: boolean): Promise<any> {
      /* eslint-enable @typescript-eslint/no-explicit-any */
      const run = () => super.query(query, parameters, useStructuredResult as true);
      if (gate.owner === this) {
        // 트랜잭션이 열려 있어야 하는데 SQLite가 이미 롤백했다면 쿼리가 autocommit으로 실행돼 원자성이 깨진다.
        if (this.gateDepth > 0 && !this.rawConnection.inTransaction)
          throw new SqliteTransactionAbortedError();
        return run();
      }
      await gate.acquire();
      try {
        return await run();
      } finally {
        gate.release();
      }
    }

    override async startTransaction(...args: Parameters<QueryRunner['startTransaction']>): Promise<void> {
      // 이미 사용권을 쥔 runner의 중첩 시작은 SAVEPOINT다.
      if (gate.owner === this) {
        await super.startTransaction(...args);
        this.gateDepth += 1;
        return;
      }

      await gate.acquire();
      gate.owner = this;
      const scope = scopes.getStore();
      if (scope && !scope.done && !scope.runner) {
        scope.runner = this;
        this.scope = scope;
      }
      try {
        await super.startTransaction(...args);
        this.gateDepth = 1;
      } catch (error) {
        this.releaseOwnership();
        throw error;
      }
    }

    override async commitTransaction(): Promise<void> {
      await super.commitTransaction();
      // 커밋이 실패하면 깊이를 유지한다. 호출자가 이어서 롤백한다.
      this.leaveTransaction();
    }

    override async rollbackTransaction(): Promise<void> {
      try {
        await super.rollbackTransaction();
      } finally {
        // 자동 롤백 뒤에는 ROLLBACK이 실패하지만 트랜잭션은 이미 끝났으므로 성공·실패와 무관하게 센다.
        this.leaveTransaction();
      }
    }

    // 트랜잭션·SAVEPOINT 하나를 마쳤을 때 깊이를 줄이고, 최상위가 끝나면 상태를 정리해 게이트를 해제한다.
    private leaveTransaction(): void {
      if (this.gateDepth > 0) this.gateDepth -= 1;
      if (this.gateDepth > 0) return;

      // 마지막 ROLLBACK이 실패했거나 자동 롤백이 있었다면 TypeORM 상태가 어긋나 있다.
      const state = this as unknown as RunnerTransactionState;
      state.isTransactionActive = false;
      state.transactionDepth = 0;
      if (this.rawConnection.inTransaction && !this.rollbackConnection()) {
        // 트랜잭션이 남은 연결을 풀면 다음 쿼리가 그 트랜잭션에 섞이므로 게이트를 쥔 채 둔다.
        logger.error(
          'ROLLBACK 재시도에도 SQLite 트랜잭션이 닫히지 않아 게이트를 해제하지 않음. 프로세스 재시작이 필요함',
        );
        return;
      }
      this.releaseOwnership();
    }

    // TypeORM을 거치지 않고 연결에 ROLLBACK을 직접 보낸다. 트랜잭션이 닫혔으면 true를 돌려준다.
    private rollbackConnection(): boolean {
      try {
        this.rawConnection.exec('ROLLBACK');
      } catch {
        // 아래 inTransaction 확인으로 판단한다.
      }
      return !this.rawConnection.inTransaction;
    }

    private releaseOwnership(): void {
      if (gate.owner !== this) return;
      if (this.scope) {
        this.scope.runner = null;
        this.scope.done = true;
        this.scope = undefined;
      }
      gate.owner = null;
      gate.release();
    }
  };
}

/**
 * SQLite DataSource의 모든 쿼리를 하나의 FIFO 게이트로 직렬화한다.
 *
 * - 트랜잭션은 게이트를 끝까지 쥐고, 다른 트랜잭션과 트랜잭션 밖 쿼리는 그동안 대기한다.
 * - 대기가 `waitTimeoutMs`를 넘기면 `SqliteGateTimeoutError`(DB_BUSY, 503)로 실패하고 그 쿼리는 실행되지 않는다.
 * - 트랜잭션 콜백 안에서 manager 없이 실행한 쿼리와 다시 연 트랜잭션은 그 트랜잭션에 참여한다.
 *
 * DataSource 초기화 뒤 한 번만 호출한다. 마이그레이션·별도 프로세스 잡의 DataSource에는 설치하지 않는다.
 */
export function installSqliteGate(dataSource: DataSource, options: SqliteGateOptions = {}): void {
  if (!isSqliteDataSource(dataSource.options)) {
    throw new Error('installSqliteGate는 SQLite DataSource에만 설치할 수 있다');
  }
  if (installed.has(dataSource)) return;
  installed.add(dataSource);

  const gate = new QueryGate(options.waitTimeoutMs ?? SQLITE_GATE_WAIT_TIMEOUT_MS);
  const scopes = new AsyncLocalStorage<TransactionScope>();
  const driver = dataSource.driver as unknown as { createQueryRunner: (mode?: string) => QueryRunner };
  const createOriginal = driver.createQueryRunner.bind(driver);

  // 원본 runner에서 런타임 클래스만 가져온다.
  const Gated = createGatedRunnerClass(createOriginal().constructor as RunnerConstructor, gate, scopes);
  // prepared statement는 연결에 묶여 있으므로 캐시도 연결 객체별로 둔다. destroy 뒤 다시 initialize해
  // 연결이 바뀌면 닫힌 연결의 statement를 쓰지 않는다. runner 사이에는 공유해 호출마다 다시 prepare하지 않는다.
  const statementCaches = new WeakMap<object, Map<string, unknown>>();
  const statementCacheFor = (connection: object): Map<string, unknown> => {
    let cache = statementCaches.get(connection);
    if (!cache) statementCaches.set(connection, (cache = new Map()));
    return cache;
  };

  Object.assign(driver, {
    createQueryRunner: (mode?: string): QueryRunner => {
      const scope = scopes.getStore();
      if (scope && !scope.done && scope.runner && gate.owner === scope.runner) return scope.runner;
      const runner = new Gated(dataSource.driver);
      const { databaseConnection } = dataSource.driver as unknown as { databaseConnection: object };
      (runner as unknown as { stmtCache: Map<string, unknown> }).stmtCache =
        statementCacheFor(databaseConnection);
      void mode;
      return runner;
    },
  });

  // 최상위 dataSource.transaction마다 비동기 범위를 만든다. 이미 범위 안이면 만들지 않아 안쪽 호출이 같은 트랜잭션에 참여한다.
  const manager = dataSource.manager;
  const originalTransaction = manager.transaction.bind(manager) as (...args: unknown[]) => Promise<unknown>;
  Object.assign(manager, {
    transaction: (...args: unknown[]) => {
      const current = scopes.getStore();
      if (current && !current.done) return originalTransaction(...args);
      return scopes.run({ runner: null, done: false }, () => originalTransaction(...args));
    },
  });
}
