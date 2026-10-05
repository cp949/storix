import { Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { isSqliteDataSource } from '../common/db-driver.js';

// gc job 전용으로 고정된 임의의 advisory lock 키. 다른 용도로 재사용하지 않는다.
const ADVISORY_LOCK_KEY = 84_217_001;

@Injectable()
export class GcLock {
  private readonly logger = new Logger(GcLock.name);
  private queryRunner: QueryRunner | undefined;

  constructor(private readonly dataSource: DataSource) {}

  private get isSqlite(): boolean {
    return isSqliteDataSource(this.dataSource.options);
  }

  async tryAcquire(minIntervalSeconds: number): Promise<boolean> {
    // SQLite는 단일 프로세스 all-in-one 배포 전제라 GcLock이 막으려는
    // "여러 WAS 호스트가 하나의 DB를 공유하며 GC를 중복 실행"하는 상황 자체가
    // 발생하지 않는다 — 실제 잠금 없이 항상 실행을 허가한다.
    if (this.isSqlite) {
      return true;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    const [{ locked }]: { locked: boolean }[] = await queryRunner.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [ADVISORY_LOCK_KEY],
    );
    if (!locked) {
      await queryRunner.release();
      return false;
    }

    const rows: { last_completed_at: Date | null }[] = await queryRunner.query(
      'SELECT last_completed_at FROM gc_state WHERE id = 1',
    );
    const lastCompletedAt = rows[0]?.last_completed_at ?? null;
    const elapsedMs = lastCompletedAt ? Date.now() - lastCompletedAt.getTime() : Infinity;
    if (elapsedMs < minIntervalSeconds * 1000) {
      await queryRunner.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
      await queryRunner.release();
      return false;
    }

    this.queryRunner = queryRunner;
    return true;
  }

  // lock 연결은 GC 동안 idle이라 idle_session_timeout이나 failover로 끊길 수 있다.
  // 끊기면 서버가 lock을 풀어 다른 인스턴스가 동시에 실행할 수 있다(api ADR-0021, 정확성 영향 없음).
  // 완료 기록은 쿨다운을 유지하도록 lock 연결이 아닌 별도 연결로 남긴다.
  async markCompleted(): Promise<void> {
    if (this.isSqlite || !this.queryRunner) {
      return;
    }
    if (!(await this.isLockConnectionAlive(this.queryRunner))) {
      this.logger.warn('GC 실행 중 advisory lock 연결이 끊겼다. 다른 인스턴스가 동시에 실행했을 수 있다');
    }
    await this.dataSource.query(
      `INSERT INTO gc_state (id, last_completed_at) VALUES (1, now())
       ON CONFLICT (id) DO UPDATE SET last_completed_at = now()`,
    );
  }

  // 연결이 끊겼으면 서버가 세션과 함께 lock을 이미 풀었다. 실패는 경고로만 남긴다.
  async release(): Promise<void> {
    if (this.isSqlite || !this.queryRunner) {
      return;
    }
    const queryRunner = this.queryRunner;
    this.queryRunner = undefined;
    try {
      await queryRunner.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } catch (error) {
      this.logger.warn(`advisory lock 해제 실패(연결 끊김으로 이미 해제됨): ${describeError(error)}`);
    }
    try {
      await queryRunner.release();
    } catch (error) {
      this.logger.warn(`lock 연결 반납 실패: ${describeError(error)}`);
    }
  }

  private async isLockConnectionAlive(queryRunner: QueryRunner): Promise<boolean> {
    try {
      await queryRunner.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
