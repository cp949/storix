import { Injectable } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';

// gc job 전용으로 고정된 임의의 advisory lock 키. 다른 용도로 재사용하지 않는다.
const ADVISORY_LOCK_KEY = 84_217_001;

@Injectable()
export class GcLock {
  private queryRunner: QueryRunner | undefined;

  constructor(private readonly dataSource: DataSource) {}

  private get isSqlite(): boolean {
    return this.dataSource.options.type === 'better-sqlite3';
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

    const [{ locked }]: { locked: boolean }[] = await queryRunner.query('SELECT pg_try_advisory_lock($1) AS locked', [
      ADVISORY_LOCK_KEY,
    ]);
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

  async markCompleted(): Promise<void> {
    if (this.isSqlite || !this.queryRunner) {
      return;
    }
    await this.queryRunner.query(
      `INSERT INTO gc_state (id, last_completed_at) VALUES (1, now())
       ON CONFLICT (id) DO UPDATE SET last_completed_at = now()`,
    );
  }

  async release(): Promise<void> {
    if (this.isSqlite || !this.queryRunner) {
      return;
    }
    await this.queryRunner.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    await this.queryRunner.release();
    this.queryRunner = undefined;
  }
}
