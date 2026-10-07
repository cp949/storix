/** SQLite·PostgreSQL에서 durable PUT와 GC의 배제를 검증한다. 규칙은 api ADR-0045다. */
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { AddStoragePutStopEvidence1791700000027 } from '../../src/persistence/migrations/1791700000027-AddStoragePutStopEvidence.js';
import type { StoragePutOwnershipRepository } from '../../src/persistence/storage-put-ownership.repository.js';

/** SQLite·PostgreSQL에서 공유하는 PUT 소유권 및 key claim 상태 전이를 검증한다. */
export function runStoragePutOwnershipRepositorySharedTests(
  createRepository: () => StoragePutOwnershipRepository,
  getDataSource: () => DataSource,
): void {
  let repository: StoragePutOwnershipRepository;
  let executionId: string;
  let testRunId: string;

  beforeEach(async () => {
    repository = createRepository();
    testRunId = randomUUID();
    executionId = randomUUID();
    await repository.registerExecution(executionId);
  });

  it('미등록 key는 소유자를 확인할 수 없는 상태로 돌려준다', async () => {
    expect(await repository.claimForGc(`blobs/${testRunId}/legacy`, randomUUID(), executionId)).toEqual({
      kind: 'unknown',
    });
  });

  it('정착하지 않은 PUT는 cutoff와 무관하게 GC claim을 막는다', async () => {
    await repository.beginPut(`blobs/${testRunId}/active`, executionId, randomUUID());

    expect(await repository.claimForGc(`blobs/${testRunId}/active`, randomUUID(), executionId)).toEqual({
      kind: 'protected',
    });
  });

  it('정상 정착한 PUT는 GC claim을 허용하고 claim 동안 새 PUT를 거부한다', async () => {
    const attemptId = randomUUID();
    const key = `blobs/${testRunId}/settled`;
    await repository.beginPut(key, executionId, attemptId);
    await repository.settlePut(attemptId);
    const claimId = randomUUID();

    expect(await repository.claimForGc(key, claimId, executionId)).toEqual({ kind: 'claimed' });
    await expect(repository.beginPut(key, executionId, randomUUID())).rejects.toThrow('storage key 회수 중');
    await repository.releaseGcClaim(key, claimId);
    await expect(repository.beginPut(key, executionId, randomUUID())).resolves.toEqual(expect.any(String));
  });

  it('확인된 종료 실행의 미정착 PUT는 GC claim을 허용한다', async () => {
    const key = `upload-staging/${testRunId}/stopped`;
    await repository.beginPut(key, executionId, randomUUID());
    expect(await repository.confirmExecutionStopped(executionId, '실제 writer 실행의 종료를 확인함')).toBe(
      true,
    );

    expect(await repository.claimForGc(key, randomUUID(), executionId)).toEqual({ kind: 'claimed' });
  });

  it('확인할 실행 식별자가 없으면 종료 확인을 기록하지 않는다', async () => {
    expect(await repository.confirmExecutionStopped(randomUUID(), '종료 확인 근거')).toBe(false);
  });

  it('중단된 GC 실행의 key claim은 별도 종료 확인 뒤에만 인계한다', async () => {
    const key = `blobs/${testRunId}/gc-claim`;
    const attemptId = await repository.beginPut(key, executionId, randomUUID());
    await repository.settlePut(attemptId);
    const firstGcId = randomUUID();
    const secondGcId = randomUUID();
    await repository.registerExecution(firstGcId);
    await repository.registerExecution(secondGcId);

    expect(await repository.claimForGc(key, randomUUID(), firstGcId)).toEqual({ kind: 'claimed' });
    expect(await repository.claimForGc(key, randomUUID(), secondGcId)).toEqual({ kind: 'protected' });
    expect(await repository.confirmExecutionStopped(firstGcId, 'GC 실행 종료를 확인함')).toBe(true);
    expect(await repository.claimForGc(key, randomUUID(), secondGcId)).toEqual({ kind: 'claimed' });
  });

  it('종료 확인 근거를 보존하고 재확인으로 처음 근거를 덮어쓰지 않는다', async () => {
    expect(await repository.confirmExecutionStopped(executionId, 'writer incarnation 종료 확인')).toBe(true);
    expect(await repository.confirmExecutionStopped(executionId, '다른 확인 근거')).toBe(true);
    const ph = getDataSource().options.type === 'better-sqlite3' ? '?' : '$1';
    const [row] = (await getDataSource().query(
      `SELECT stopped_confirmation_evidence AS "evidence" FROM storage_put_execution WHERE execution_id = ${ph}`,
      [executionId],
    )) as Array<{ evidence: string }>;
    expect(row.evidence).toBe('writer incarnation 종료 확인');
  });

  it('비어 있는 확인 근거로 실행 종료를 승인하지 않는다', async () => {
    await expect(repository.confirmExecutionStopped(executionId, '  ')).rejects.toThrow(
      'writer 종료 확인 근거가 필요함',
    );
    const key = `blobs/${testRunId}/unconfirmed`;
    await repository.beginPut(key, executionId);
    expect(await repository.claimForGc(key, randomUUID(), executionId)).toEqual({ kind: 'protected' });
  });

  it('근거 컬럼 롤백과 재적용은 기존 실행 종료 확인을 보존한다', async () => {
    await repository.confirmExecutionStopped(executionId, 'writer 종료 확인');
    const runner = getDataSource().createQueryRunner();
    const migration = new AddStoragePutStopEvidence1791700000027();
    const ph = getDataSource().options.type === 'better-sqlite3' ? '?' : '$1';
    try {
      await migration.down(runner);
      await migration.up(runner);
      const [row] = (await runner.query(
        `SELECT stopped_confirmed_at AS "confirmedAt", stopped_confirmation_evidence AS "evidence" FROM storage_put_execution WHERE execution_id = ${ph}`,
        [executionId],
      )) as Array<{ confirmedAt: Date | string | null; evidence: string | null }>;
      expect(row.confirmedAt).not.toBeNull();
      expect(row.evidence).toBeNull();
      expect(await repository.confirmExecutionStopped(executionId, '복구 후 근거 보충')).toBe(true);
      const [updated] = (await runner.query(
        `SELECT stopped_confirmation_evidence AS "evidence" FROM storage_put_execution WHERE execution_id = ${ph}`,
        [executionId],
      )) as Array<{ evidence: string }>;
      expect(updated.evidence).toBe('복구 후 근거 보충');
    } finally {
      await runner.release();
    }
  });

  it('회수 가능한 key의 PUT 등록과 GC claim 경쟁에서는 한쪽만 시작 권한을 얻는다', async () => {
    const key = `blobs/${testRunId}/race`;
    const previousAttempt = await repository.beginPut(key, executionId);
    await repository.settlePut(previousAttempt);
    const claimId = randomUUID();
    const [put, claim] = await Promise.allSettled([
      repository.beginPut(key, executionId, randomUUID()),
      repository.claimForGc(key, claimId, executionId),
    ]);
    expect(claim.status).toBe('fulfilled');
    if (claim.status !== 'fulfilled') throw claim.reason;
    if (claim.value.kind === 'claimed') {
      expect(put.status).toBe('rejected');
      await repository.releaseGcClaim(key, claimId);
    } else {
      expect(claim.value.kind).toBe('protected');
      expect(put.status).toBe('fulfilled');
    }
  });
}
