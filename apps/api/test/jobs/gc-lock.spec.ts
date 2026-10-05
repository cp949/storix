import { Logger } from '@nestjs/common';
import { jest } from '@jest/globals';
import type { DataSource, QueryRunner } from 'typeorm';
import { GcLock } from '../../src/jobs/gc-lock.js';

describe('GcLock', () => {
  function makeQueryRunner() {
    return {
      connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      query: jest.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
      release: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    };
  }

  function makeDataSource(
    queryRunner: ReturnType<typeof makeQueryRunner>,
    query = jest.fn<(sql: string) => Promise<unknown>>().mockResolvedValue(undefined),
  ): DataSource {
    return {
      options: { type: 'postgres' },
      createQueryRunner: () => queryRunner as unknown as QueryRunner,
      query,
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

  it('markCompleted는 lock 연결이 아닌 별도 연결로 last_completed_at을 갱신한다', async () => {
    const queryRunner = makeQueryRunner();
    queryRunner.query
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ last_completed_at: null }])
      .mockResolvedValueOnce([{ '?column?': 1 }]);
    const dataSourceQuery = jest.fn<(sql: string) => Promise<unknown>>().mockResolvedValue(undefined);
    const gcLock = new GcLock(makeDataSource(queryRunner, dataSourceQuery));
    await gcLock.tryAcquire(3600);

    await gcLock.markCompleted();

    expect(dataSourceQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO gc_state'));
    expect(queryRunner.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO gc_state'));
  });

  it('lock 연결이 끊겼으면 경고를 남기고 완료는 그대로 기록한다', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const queryRunner = makeQueryRunner();
      queryRunner.query
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValueOnce([{ last_completed_at: null }])
        .mockRejectedValueOnce(new Error('Connection terminated'));
      const dataSourceQuery = jest.fn<(sql: string) => Promise<unknown>>().mockResolvedValue(undefined);
      const gcLock = new GcLock(makeDataSource(queryRunner, dataSourceQuery));
      await gcLock.tryAcquire(3600);

      await gcLock.markCompleted();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('advisory lock 연결이 끊겼다'));
      expect(dataSourceQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO gc_state'));
    } finally {
      warn.mockRestore();
    }
  });

  it('release는 unlock·반납이 실패해도 throw하지 않고 다시 호출하면 아무 것도 하지 않는다', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const queryRunner = makeQueryRunner();
      queryRunner.query
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValueOnce([{ last_completed_at: null }])
        .mockRejectedValueOnce(new Error('Connection terminated'));
      queryRunner.release.mockRejectedValueOnce(new Error('already released'));
      const gcLock = new GcLock(makeDataSource(queryRunner));
      await gcLock.tryAcquire(3600);

      await expect(gcLock.release()).resolves.toBeUndefined();
      await expect(gcLock.release()).resolves.toBeUndefined();

      expect(queryRunner.release).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
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
