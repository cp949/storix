import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { GcLock } from '../../src/jobs/gc-lock.js';
import { AddGcState1789300000000 } from '../../src/persistence/migrations/1789300000000-AddGcState.js';

describe('GcLock 통합', () => {
  let container: StartedPostgreSqlContainer;
  let dataSource: DataSource;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('docker.io/library/postgres:16-alpine').start();
    dataSource = new DataSource({
      type: 'postgres',
      url: container.getConnectionUri(),
      synchronize: false,
      migrations: [AddGcState1789300000000],
    });
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 120000);

  afterAll(async () => {
    await dataSource.destroy();
    await container.stop();
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM gc_state');
  });

  it('두 인스턴스가 동시에 시도하면 한 쪽만 락을 획득한다', async () => {
    const lockA = new GcLock(dataSource);
    const lockB = new GcLock(dataSource);

    const [acquiredA, acquiredB] = await Promise.all([lockA.tryAcquire(3600), lockB.tryAcquire(3600)]);

    expect([acquiredA, acquiredB].filter(Boolean)).toHaveLength(1);

    await lockA.release();
    await lockB.release();
  });

  it('먼저 완료한 인스턴스가 락을 반납해도, min interval 이내면 다음 인스턴스는 실행하지 않는다', async () => {
    const lockA = new GcLock(dataSource);
    expect(await lockA.tryAcquire(3600)).toBe(true);
    await lockA.markCompleted();
    await lockA.release();

    const lockB = new GcLock(dataSource);
    const acquiredB = await lockB.tryAcquire(3600);

    expect(acquiredB).toBe(false);
  });

  it('실행 중 lock 연결이 끊겨도 완료를 기록하고 release는 실패하지 않는다', async () => {
    const lockA = new GcLock(dataSource);
    expect(await lockA.tryAcquire(3600)).toBe(true);
    // idle_session_timeout·failover로 서버가 lock 연결을 끊은 상황
    const terminated = (await dataSource.query(
      `SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks
       WHERE locktype = 'advisory' AND objid = 84217001 AND granted`,
    )) as Array<{ terminated: boolean }>;
    expect(terminated).toEqual([{ terminated: true }]);

    await lockA.markCompleted();
    await expect(lockA.release()).resolves.toBeUndefined();

    const rows = (await dataSource.query('SELECT last_completed_at FROM gc_state WHERE id = 1')) as Array<{
      last_completed_at: Date | null;
    }>;
    expect(rows[0]?.last_completed_at).toBeInstanceOf(Date);
    const lockB = new GcLock(dataSource);
    expect(await lockB.tryAcquire(3600)).toBe(false);
  });

  it('min interval이 지나면 다음 인스턴스가 실행할 수 있다', async () => {
    const lockA = new GcLock(dataSource);
    expect(await lockA.tryAcquire(1)).toBe(true);
    await lockA.markCompleted();
    await lockA.release();

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const lockB = new GcLock(dataSource);
    const acquiredB = await lockB.tryAcquire(1);

    expect(acquiredB).toBe(true);
    await lockB.release();
  });
});
