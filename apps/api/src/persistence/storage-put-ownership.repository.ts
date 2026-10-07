import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { isSqliteDataSource } from '../common/db-driver.js';

/** GC가 storage key multipart 회수 권한을 얻었는지 나타낸다. */
export type StoragePutGcClaimResult =
  { readonly kind: 'unknown' } | { readonly kind: 'protected' } | { readonly kind: 'claimed' };

interface AttemptOwnerRow {
  readonly state: string;
  readonly stoppedConfirmedAt: Date | string | null;
}

/** storage PUT 생존 기록과 multipart 회수 claim을 key별로 직렬화한다. */
@Injectable()
export class StoragePutOwnershipRepository {
  private readonly sqlite: boolean;

  constructor(private readonly dataSource: DataSource) {
    this.sqlite = isSqliteDataSource(dataSource.options);
  }

  /** 프로세스 실행 식별자를 영속 저장한다. 기존 실행 행의 종료 확인은 덮어쓰지 않는다. */
  async registerExecution(executionId: string): Promise<void> {
    const insert = this.sqlite
      ? 'INSERT OR IGNORE INTO storage_put_execution (execution_id, started_at) VALUES (?, CURRENT_TIMESTAMP)'
      : 'INSERT INTO storage_put_execution (execution_id, started_at) VALUES ($1, CURRENT_TIMESTAMP) ON CONFLICT (execution_id) DO NOTHING';
    await this.dataSource.query(insert, [executionId]);
  }

  /** key claim이 없는 경우에만 storage PUT 시도를 durable하게 등록한다. */
  async beginPut(key: string, executionId: string, attemptId = randomUUID()): Promise<string> {
    await this.dataSource.transaction(async (manager) => {
      await this.ensureKey(manager, key);
      const ph = this.sqlite ? '?' : '$1';
      const lock = this.sqlite ? '' : ' FOR UPDATE';
      const rows = (await manager.query(
        `SELECT gc_claim_id AS "gcClaimId" FROM storage_put_key WHERE storage_key = ${ph}${lock}`,
        [key],
      )) as Array<{ gcClaimId: string | null }>;
      if (!rows[0] || rows[0].gcClaimId !== null) throw new Error('storage key 회수 중');
      const values = this.sqlite
        ? "(?, ?, ?, 'ACTIVE', CURRENT_TIMESTAMP)"
        : "($1, $2, $3, 'ACTIVE', CURRENT_TIMESTAMP)";
      await manager.query(
        `INSERT INTO storage_put_attempt (attempt_id, execution_id, storage_key, state, created_at) VALUES ${values}`,
        [attemptId, executionId, key],
      );
    });
    return attemptId;
  }

  /** PUT Promise가 성공 또는 실패로 정착한 실행을 영속 기록한다. */
  async settlePut(attemptId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE storage_put_attempt SET state = 'SETTLED', settled_at = CURRENT_TIMESTAMP WHERE attempt_id = ${this.sqlite ? '?' : '$1'}`,
      [attemptId],
    );
  }

  /** storage key가 소유권 테이블에 등록됐는지 확인한다. */
  async hasKeyRecord(key: string): Promise<boolean> {
    const rows = (await this.dataSource.query(
      `SELECT storage_key FROM storage_put_key WHERE storage_key = ${this.sqlite ? '?' : '$1'}`,
      [key],
    )) as unknown[];
    return rows.length > 0;
  }

  /** 관리자가 외부에서 실행 종료를 확인한 근거를 기록한다. */
  async confirmExecutionStopped(executionId: string): Promise<boolean> {
    await this.dataSource.query(
      `UPDATE storage_put_execution SET stopped_confirmed_at = CURRENT_TIMESTAMP WHERE execution_id = ${this.sqlite ? '?' : '$1'} AND stopped_confirmed_at IS NULL`,
      [executionId],
    );
    const rows = (await this.dataSource.query(
      `SELECT stopped_confirmed_at AS "stoppedConfirmedAt" FROM storage_put_execution WHERE execution_id = ${this.sqlite ? '?' : '$1'}`,
      [executionId],
    )) as Array<{ stoppedConfirmedAt: Date | string | null }>;
    return rows.length > 0 && rows[0].stoppedConfirmedAt !== null;
  }

  /** 등록된 소유자와 종료 확인을 잠근 뒤 multipart abort 구간의 key claim을 얻는다. */
  async claimForGc(key: string, claimId: string, executionId: string): Promise<StoragePutGcClaimResult> {
    return this.dataSource.transaction(async (manager) => {
      const ph = this.sqlite ? '?' : '$1';
      const lock = this.sqlite ? '' : ' FOR UPDATE';
      const guards = (await manager.query(
        `SELECT gc_claim_id AS "gcClaimId", gc_execution_id AS "gcExecutionId" FROM storage_put_key WHERE storage_key = ${ph}${lock}`,
        [key],
      )) as Array<{ gcClaimId: string | null; gcExecutionId: string | null }>;
      if (!guards[0]) return { kind: 'unknown' };
      if (guards[0].gcClaimId !== null) {
        const process = guards[0].gcExecutionId
          ? (
              (await manager.query(
                `SELECT stopped_confirmed_at AS "stoppedConfirmedAt" FROM storage_put_execution WHERE execution_id = ${this.sqlite ? '?' : '$1'}`,
                [guards[0].gcExecutionId],
              )) as Array<{ stoppedConfirmedAt: Date | string | null }>
            )[0]
          : null;
        if (!process || process.stoppedConfirmedAt === null) return { kind: 'protected' };
      }
      const owners = (await manager.query(
        `SELECT a.state AS state, e.stopped_confirmed_at AS "stoppedConfirmedAt"
         FROM storage_put_attempt a LEFT JOIN storage_put_execution e ON e.execution_id = a.execution_id
         WHERE a.storage_key = ${ph}`,
        [key],
      )) as AttemptOwnerRow[];
      if (owners.length === 0) return { kind: 'unknown' };
      if (owners.some((owner) => owner.state !== 'SETTLED' && owner.stoppedConfirmedAt === null)) {
        return { kind: 'protected' };
      }
      await manager.query(
        `UPDATE storage_put_key SET gc_claim_id = ${this.sqlite ? '?' : '$1'}, gc_execution_id = ${this.sqlite ? '?' : '$2'}, gc_claimed_at = CURRENT_TIMESTAMP WHERE storage_key = ${this.sqlite ? '?' : '$3'}`,
        [claimId, executionId, key],
      );
      return { kind: 'claimed' };
    });
  }

  /** 이번 GC 실행이 얻은 claim만 해제한다. */
  async releaseGcClaim(key: string, claimId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE storage_put_key SET gc_claim_id = NULL, gc_execution_id = NULL, gc_claimed_at = NULL WHERE storage_key = ${this.sqlite ? '?' : '$1'} AND gc_claim_id = ${this.sqlite ? '?' : '$2'}`,
      [key, claimId],
    );
  }

  private async ensureKey(manager: EntityManager, key: string): Promise<void> {
    const sql = this.sqlite
      ? 'INSERT OR IGNORE INTO storage_put_key (storage_key) VALUES (?)'
      : 'INSERT INTO storage_put_key (storage_key) VALUES ($1) ON CONFLICT (storage_key) DO NOTHING';
    await manager.query(sql, [key]);
  }
}
