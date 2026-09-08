import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { GcLock } from './gc-lock.js';
import { AddGcState1789300000000 } from '../persistence/migrations/1789300000000-AddGcState.js';

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
