/**
 * 전체 계약 실행의 공유 자원을 준비하고 취득 역순으로 정리한다.
 * 규칙은 docs/design/12-contract-checks.md "실행 흐름".
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Contract, ProfileName } from '../define-contract.ts';
import { removeStaleContainers, startBlobStorage } from './blob-storage.ts';
import { CLEANUP_TIMEOUT_MS, cleanupError, ExecutionCleanupError, withCleanupTimeout } from './cleanup.ts';
import { startPostgres } from './postgres.ts';
import { runProfileLifecycle } from './profile-lifecycle.ts';
import { summarize, type ContractResult } from './run.ts';
import { refuseNewServers, stopAllServers } from './server.ts';

/** 검증과 선택을 마친 프로파일 그룹 및 실행 취소 신호다. */
export interface ContractLifecycleInput {
  /** 프로파일과 계약을 주어진 순서대로 실행한다. */
  readonly groups: ReadonlyMap<ProfileName, readonly Contract[]>;

  /** 프로파일 DB 드라이버다. */
  readonly db: 'sqlite' | 'postgres';

  /** 취소 후 후속 프로파일을 시작하지 않는다. */
  readonly signal: AbortSignal;
}

/** 외부 자원과 프로파일 실행을 교체하는 의존성이다. */
export interface ContractLifecycleDependencies {
  /** 서버 로그와 DB를 둘 실행 디렉터리를 만든다. */
  createWorkDir(): Promise<string>;

  /** 성공 실행의 디렉터리를 삭제한다. */
  removeWorkDir(workDir: string): Promise<void>;

  /** 공유 컨테이너와 DB 이름을 구분한다. */
  createRunId(): string;

  /** 이전 실행 또는 미완료 기동이 남긴 컨테이너를 제거한다. */
  removeStaleContainers: typeof removeStaleContainers;

  /** 공유 blob 저장소를 준비한다. */
  startBlobStorage: typeof startBlobStorage;

  /** Postgres 실행에서 공유 컨테이너를 준비한다. */
  startPostgres: typeof startPostgres;

  /** 핸들을 반환하기 전 기동 중인 서버도 정리한다. */
  stopServers(): Promise<void>;

  /** 프로파일별 서버와 DB 및 계약 실행을 관리한다. */
  runProfileLifecycle: typeof runProfileLifecycle;

  /** 정리 작업 하나의 제한 시간이다. */
  cleanupTimeoutMs: number;
}

/** CLI가 출력하고 종료 상태를 결정할 실행 결과다. */
export interface ContractLifecycleResult {
  /** 성공은 0, 실행·계약·정리 실패는 1, 취소는 130이다. */
  readonly exitCode: 0 | 1 | 130;

  /** 완료한 계약의 집계다. */
  readonly summary: ReturnType<typeof summarize>;

  /** 완료한 계약 결과다. */
  readonly contracts: readonly ContractResult[];

  /** 실패한 계약이 있는 프로파일의 서버 로그다. */
  readonly serverLogFiles: readonly string[];

  /** 보존한 작업 디렉터리 경로다. */
  readonly workDir?: string;

  /** 정리 오류보다 우선하는 원래 실행 오류 값이다. */
  readonly error?: unknown;

  /** 시도한 모든 정리에서 발생한 오류다. */
  readonly cleanupErrors: readonly Error[];
}

const defaultDependencies: ContractLifecycleDependencies = {
  createWorkDir: () => mkdtemp(path.join(tmpdir(), 'storix-contract-')),
  removeWorkDir: (workDir) => rm(workDir, { recursive: true, force: true }),
  createRunId: () => randomBytes(4).toString('hex'),
  removeStaleContainers,
  startBlobStorage,
  startPostgres,
  async stopServers() {
    refuseNewServers();
    await stopAllServers();
  },
  runProfileLifecycle,
  cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
};

/** 공유 자원을 한 번 준비한다. 실패한 정리 뒤에도 나머지 정리를 계속한다. */
export async function runContractLifecycle(
  input: ContractLifecycleInput,
  dependencies: Partial<ContractLifecycleDependencies> = {},
): Promise<ContractLifecycleResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  const cleanups: Array<{ label: string; run: () => Promise<unknown> }> = [];
  const cleanupErrors: Error[] = [];
  const results: ContractResult[] = [];
  const serverLogFiles: string[] = [];
  let workDir: string | undefined;
  let error: unknown;
  let executionFailed = false;
  try {
    input.signal.throwIfAborted();
    workDir = await deps.createWorkDir();
    // 기동 함수가 핸들을 반환하지 못한 경우에도 잔여 컨테이너를 제거한다.
    cleanups.push({ label: '잔여 컨테이너', run: () => deps.removeStaleContainers() });
    await deps.removeStaleContainers();
    input.signal.throwIfAborted();
    const runId = deps.createRunId();
    const blob = await deps.startBlobStorage(runId);
    cleanups.push({ label: 'blob', run: () => blob.stop() });
    input.signal.throwIfAborted();
    const postgres = input.db === 'postgres' ? await deps.startPostgres(runId) : undefined;
    if (postgres !== undefined) cleanups.push({ label: 'Postgres', run: () => postgres.stop() });
    cleanups.push({ label: 'API 서버', run: () => deps.stopServers() });
    for (const [profile, contracts] of input.groups) {
      if (input.signal.aborted) break;
      const outcome = await deps.runProfileLifecycle({
        profile,
        contracts,
        workDir,
        runId,
        db: input.db,
        postgres,
        blob,
        signal: input.signal,
      });
      results.push(...outcome.contracts);
      cleanupErrors.push(...outcome.cleanupErrors);
      if (outcome.contracts.some((entry) => !entry.passed)) serverLogFiles.push(outcome.serverLogFile);
    }
  } catch (caught) {
    executionFailed = true;
    if (caught instanceof ExecutionCleanupError) {
      error = caught.executionError;
      cleanupErrors.push(...caught.cleanupErrors);
    } else {
      error = caught;
    }
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await withCleanupTimeout(cleanup.label, cleanup.run, deps.cleanupTimeoutMs);
      } catch (caught) {
        cleanupErrors.push(cleanupError(caught));
      }
    }
  }
  const summary = summarize(results);
  if (
    workDir !== undefined &&
    !input.signal.aborted &&
    !executionFailed &&
    summary.exitCode === 0 &&
    cleanupErrors.length === 0
  ) {
    try {
      await withCleanupTimeout('작업 디렉터리', () => deps.removeWorkDir(workDir!), deps.cleanupTimeoutMs);
      workDir = undefined;
    } catch (caught) {
      cleanupErrors.push(cleanupError(caught));
    }
  }
  return {
    exitCode: input.signal.aborted ? 130 : executionFailed || cleanupErrors.length > 0 ? 1 : summary.exitCode,
    summary,
    contracts: results,
    serverLogFiles,
    workDir,
    ...(executionFailed ? { error } : {}),
    cleanupErrors,
  };
}
