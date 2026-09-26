import { SqliteGateTimeoutError } from './sqlite-gate.errors.js';
import { classifyPersistenceFailure, classifyPersistenceOperation } from './persistence-failure.js';
import { VfsNodeRepository } from './vfs-node.repository.js';
import type { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';

class DecoratedOperation {
  @classifyPersistenceOperation
  async fail(error: unknown): Promise<void> {
    throw error;
  }
}

function nodeRepository(transaction: (work: () => Promise<unknown>) => Promise<unknown>) {
  const query = {
    where() {
      return this;
    },
    async getOne() {
      return { type: 'DIRECTORY' };
    },
  };
  const manager = {
    createQueryBuilder: () => query,
    getRepository: () => ({}),
  } as unknown as EntityManager;
  const dataSource = {
    options: { type: 'better-sqlite3' },
    transaction: (work: (manager: EntityManager) => Promise<unknown>) => transaction(() => work(manager)),
  } as unknown as DataSource;
  const config = { get: () => undefined } as unknown as ConfigService;
  return new VfsNodeRepository(null!, null!, null!, dataSource, null!, config);
}

describe('DB 진입 경계 분류', () => {
  it('decorator는 확인된 driverError를 변환하고 기존 DomainError는 원형 보존한다', async () => {
    const operation = new DecoratedOperation();
    await expect(operation.fail({ driverError: { code: '08006' } })).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
    });
    const busy = new SqliteGateTimeoutError(30_000);
    await expect(operation.fail(busy)).rejects.toBe(busy);
  });

  it('withMutation의 transaction 진입과 commit DB transport 오류는 분류한다', async () => {
    const acquisitionError = Object.assign(new Error('private dsn'), { code: 'ECONNREFUSED' });
    const acquisition = nodeRepository(async () => {
      throw acquisitionError;
    });
    await expect(acquisition.withMutation('ns', 'root', async () => 'ok')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
    });

    const commitError = Object.assign(new Error('private dsn'), { code: 'ECONNRESET' });
    const commit = nodeRepository(async (work) => {
      await work();
      throw commitError;
    });
    await expect(commit.withMutation('ns', 'root', async () => 'ok')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
    });
  });

  it('withMutation은 caller callback의 원시 transport 오류를 원형 보존한다', async () => {
    const error = Object.assign(new Error('client disconnected'), { code: 'ECONNRESET' });
    const repository = nodeRepository(async (work) => work());
    await expect(
      repository.withMutation('ns', 'root', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it('withMutation callback의 명시적 driverError는 DB 소유로 분류한다', async () => {
    const repository = nodeRepository(async (work) => work());
    await expect(
      repository.withMutation('ns', 'root', async () => {
        throw { driverError: { code: '08006' } };
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 });
  });
});

describe('classifyPersistenceFailure', () => {
  it.each(['08000', '08003', '08006', '40001', '40P01', '53300', '55P03', '57P01', '57P02', '57P03'])(
    'PostgreSQL %s 드라이버 오류는 503이다',
    (code) => {
      expect(classifyPersistenceFailure({ driverError: { code } })).toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
        status: 503,
      });
    },
  );

  it.each([
    'SQLITE_BUSY',
    'SQLITE_LOCKED',
    'SQLITE_BUSY_SNAPSHOT',
    'SQLITE_BUSY_TIMEOUT',
    'SQLITE_LOCKED_SHAREDCACHE',
  ])('SQLite %s 드라이버 오류는 503이다', (code) => {
    expect(classifyPersistenceFailure({ code })).toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 });
  });

  it.each(['53100', 'XX001', 'SQLITE_FULL', 'SQLITE_CORRUPT', 'SQLITE_CORRUPT_INDEX', 'SQLITE_READONLY'])(
    '%s 저장 오류는 500이다',
    (code) => {
      expect(classifyPersistenceFailure({ driverError: { code } })).toMatchObject({
        code: 'STORAGE_FAILURE',
        status: 500,
      });
    },
  );

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'])('%s 연결 오류는 503이다', (code) => {
    expect(classifyPersistenceFailure(Object.assign(new Error('secret dsn'), { code }))).toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      status: 503,
    });
  });

  it('DB_BUSY, 고유 제약, 미확인 오류, message만 있는 오류는 유지한다', () => {
    expect(classifyPersistenceFailure(new SqliteGateTimeoutError(30_000))).toBeNull();
    expect(classifyPersistenceFailure({ driverError: { code: '23505' } })).toBeNull();
    expect(classifyPersistenceFailure({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBeNull();
    expect(classifyPersistenceFailure({ code: 'SQLITE_IOERR' })).toBeNull();
    expect(classifyPersistenceFailure({ code: 'SQLITE_CANTOPEN' })).toBeNull();
    // READONLY 확장 코드는 일시성이 기본 코드와 달라 접지 않는다.
    expect(classifyPersistenceFailure({ code: 'SQLITE_READONLY_RECOVERY' })).toBeNull();
    expect(classifyPersistenceFailure(new Error('ECONNREFUSED'))).toBeNull();
    expect(classifyPersistenceFailure({ driverError: { code: 'FUTURE_CODE' } })).toBeNull();
  });
});
