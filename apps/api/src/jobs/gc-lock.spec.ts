import { jest } from '@jest/globals';
import type { DataSource, QueryRunner } from 'typeorm';
import { GcLock } from './gc-lock.js';

describe('GcLock', () => {
  function makeQueryRunner() {
    return {
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      query: jest.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
      release: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  function makeDataSource(queryRunner: ReturnType<typeof makeQueryRunner>): DataSource {
    return {
      options: { type: 'postgres' },
      createQueryRunner: () => queryRunner as unknown as QueryRunner
    } as unknown as DataSource;
  }

  it('advisory lock을 얻지 못하면 false를 반환하고 커넥션을 반납한다', async () => {
    const queryRunner = makeQueryRunner();
    queryRunner.query.mockResolvedValueOnce([{ locked: false }]);
    const gcLock = new GcLock(makeDataSource(queryRunner));

    const acquired = await gcLock.tryAcquire(3600);

    expect(acquired).toBe(false);
    expect(queryRunner.release).toHaveBeenCalled();
  });

  it('락은 얻었지만 최근에(interval 이내) 완료된 이력이 있으면 false를 반환하고 락·커넥션을 반납한다', async () => {
    const queryRunner = makeQueryRunner();
    const recent = new Date(Date.now() - 10_000); // 10초 전
    queryRunner.query
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ last_completed_at: recent }]);
    const gcLock = new GcLock(makeDataSource(queryRunner));

    const acquired = await gcLock.tryAcquire(3600);

    expect(acquired).toBe(false);
    expect(queryRunner.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [84_217_001]);
    expect(queryRunner.release).toHaveBeenCalled();
  });

  it('락을 얻었고 interval이 지났으면(또는 이력이 없으면) true를 반환하고 커넥션을 유지한다', async () => {
    const queryRunner = makeQueryRunner();
    queryRunner.query
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ last_completed_at: null }]);
    const gcLock = new GcLock(makeDataSource(queryRunner));

    const acquired = await gcLock.tryAcquire(3600);

    expect(acquired).toBe(true);
    expect(queryRunner.release).not.toHaveBeenCalled();
  });

  it('gc_state에 행이 없으면(첫 실행) interval과 무관하게 true를 반환한다', async () => {
    const queryRunner = makeQueryRunner();
    queryRunner.query.mockResolvedValueOnce([{ locked: true }]).mockResolvedValueOnce([]);
    const gcLock = new GcLock(makeDataSource(queryRunner));

    const acquired = await gcLock.tryAcquire(3600);

    expect(acquired).toBe(true);
    expect(queryRunner.release).not.toHaveBeenCalled();
  });

  it('markCompleted는 락 획득에 쓴 커넥션으로 last_completed_at을 갱신한다', async () => {
    const queryRunner = makeQueryRunner();
    queryRunner.query
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ last_completed_at: null }])
      .mockResolvedValueOnce(undefined);
    const gcLock = new GcLock(makeDataSource(queryRunner));
    await gcLock.tryAcquire(3600);

    await gcLock.markCompleted();

    expect(queryRunner.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO gc_state'),
    );
  });

  it('release는 advisory unlock 후 커넥션을 반납한다', async () => {
    const queryRunner = makeQueryRunner();
    queryRunner.query
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ last_completed_at: null }])
      .mockResolvedValueOnce(undefined);
    const gcLock = new GcLock(makeDataSource(queryRunner));
    await gcLock.tryAcquire(3600);

    await gcLock.release();

    expect(queryRunner.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [84_217_001]);
    expect(queryRunner.release).toHaveBeenCalled();
  });

  describe('SQLite 드라이버', () => {
    function makeSqliteDataSource(): DataSource {
      return { options: { type: 'better-sqlite3' }, createQueryRunner: jest.fn() } as unknown as DataSource;
    }

    it('tryAcquire는 항상 true를 반환하고 커넥션을 만들지 않는다', async () => {
      const dataSource = makeSqliteDataSource();
      const gcLock = new GcLock(dataSource);

      const acquired = await gcLock.tryAcquire(3600);

      expect(acquired).toBe(true);
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('markCompleted와 release는 아무 것도 하지 않는다', async () => {
      const dataSource = makeSqliteDataSource();
      const gcLock = new GcLock(dataSource);
      await gcLock.tryAcquire(3600);

      await expect(gcLock.markCompleted()).resolves.toBeUndefined();
      await expect(gcLock.release()).resolves.toBeUndefined();
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });
  });
});
