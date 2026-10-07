import { randomUUID } from 'node:crypto';
import type { StoragePutOwnershipRepository } from '../../src/persistence/storage-put-ownership.repository.js';

/** SQLite·PostgreSQL에서 공유하는 PUT 소유권 및 key claim 상태 전이를 검증한다. */
export function runStoragePutOwnershipRepositorySharedTests(
  createRepository: () => StoragePutOwnershipRepository,
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
    expect(await repository.confirmExecutionStopped(executionId)).toBe(true);

    expect(await repository.claimForGc(key, randomUUID(), executionId)).toEqual({ kind: 'claimed' });
  });

  it('확인할 실행 식별자가 없으면 종료 확인을 기록하지 않는다', async () => {
    expect(await repository.confirmExecutionStopped(randomUUID())).toBe(false);
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
    expect(await repository.confirmExecutionStopped(firstGcId)).toBe(true);
    expect(await repository.claimForGc(key, randomUUID(), secondGcId)).toEqual({ kind: 'claimed' });
  });

  it('key별 PUT 등록과 GC claim 경쟁에서는 한쪽만 시작 권한을 얻는다', async () => {
    const key = `blobs/${testRunId}/race`;
    const claimId = randomUUID();
    const [put, claim] = await Promise.allSettled([
      repository.beginPut(key, executionId, randomUUID()),
      repository.claimForGc(key, claimId, executionId),
    ]);

    const putStarted = put.status === 'fulfilled';
    const gcClaimed = claim.status === 'fulfilled' && claim.value.kind === 'claimed';
    expect(putStarted && gcClaimed).toBe(false);
    if (gcClaimed) await repository.releaseGcClaim(key, claimId);
  });
}
