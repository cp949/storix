/**
 * 프로파일마다 새 DB와 API 서버를 준비하고 계약을 순차 실행한다.
 * 서버 종료는 이 모듈이 소유한다. 규칙은 docs/design/12-contract-checks.md "실행 흐름".
 */
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Contract, ProfileName } from '../define-contract.ts';
import type { BlobStorageHandle } from './blob-storage.ts';
import { createContractContext } from './context.ts';
import { CLEANUP_TIMEOUT_MS, cleanupError, withCleanupTimeout } from './cleanup.ts';
import { prepareSqliteDatabase, type DatabaseHandle } from './database.ts';
import { preparePostgresDatabase, type PostgresHandle } from './postgres.ts';
import { PROFILE_CAPABILITIES, PROFILE_ENV, UPLOAD_SESSION_POLICY } from './profiles.ts';
import {
  EMPTY_CAPABILITIES_CONFIG,
  buildUploadSessionsConfig,
  provisionCapabilityNamespaces,
} from './provision.ts';
import { runContract, type ContractResult } from './run.ts';
import { buildServerEnv } from './server-env.ts';
import { findFreePort, startServer } from './server.ts';

/** 하나의 프로파일이 사용할 공유 자원과 계약 목록을 받는다. */
export interface ProfileLifecycleInput {
  /** DB·로그·capability 설정을 구분하는 프로파일이다. */
  readonly profile: ProfileName;

  /** 주어진 순서대로 실행할 계약이다. */
  readonly contracts: readonly Contract[];

  /** DB·로그·capability 설정 파일을 둘 실행 디렉터리다. */
  readonly workDir: string;

  /** Postgres database 이름을 구분하는 실행 ID다. */
  readonly runId: string;

  /** 프로파일 DB를 준비할 드라이버다. */
  readonly db: 'sqlite' | 'postgres';

  /** Postgres 실행에서 사용하는 공유 컨테이너다. */
  readonly postgres?: PostgresHandle;

  /** 계약에 노출할 공유 blob 저장소다. */
  readonly blob: BlobStorageHandle;

  /** 취소 뒤 후속 계약과 저장소 복구를 막는 실행 신호다. */
  readonly signal: AbortSignal;
}

/** 외부 자원 준비와 계약 실행을 교체하는 의존성이다. */
export interface ProfileLifecycleDependencies {
  /** 프로파일 전용 DB를 만들고 migration을 적용한다. */
  prepareDatabase(input: ProfileLifecycleInput): DatabaseHandle;

  /** API 서버가 사용할 루프백 포트를 준비한다. */
  findFreePort: typeof findFreePort;

  /** 서버의 첫 기동에 사용할 빈 capability 설정과 세션 정책 같은 시작 설정 파일을 쓴다. */
  writeCapabilitiesConfig(configPath: string, contents: string): Promise<void>;

  /** 프로파일 전용 API 서버를 기동한다. */
  startServer: typeof startServer;

  /** capability namespace를 준비하고 서버를 재시작한다. */
  provisionCapabilityNamespaces: typeof provisionCapabilityNamespaces;

  /** 계약을 실행하고 통과 또는 실패 결과를 반환한다. */
  runContract: typeof runContract;

  /** 서버 정리 하나의 제한 시간이다. */
  cleanupTimeoutMs: number;
}

/** 서버 기동 뒤 프로파일 실행의 계약 결과·서버 로그 경로·정리 오류·실행 오류다. */
export interface ProfileLifecycleResult {
  /** 취소나 실행 오류 전까지 실행을 완료한 계약 결과다. */
  readonly contracts: readonly ContractResult[];

  /** 프로파일 API 서버의 stdout·stderr 로그 파일이다. */
  readonly serverLogFile: string;

  /** 계약 결과와 별도로 보고할 서버 정리 오류다. */
  readonly cleanupErrors: readonly Error[];

  /** 서버 기동 뒤 발생한 실행 오류의 원래 값이다. 속성이 있으면 `undefined` 값도 실행 실패다. */
  readonly error?: unknown;
}

const defaultDependencies: ProfileLifecycleDependencies = {
  prepareDatabase(input) {
    if (input.db === 'sqlite') return prepareSqliteDatabase(input.workDir, input.profile);
    if (input.postgres === undefined) throw new Error('Postgres 프로파일에 공유 Postgres가 필요하다.');
    return preparePostgresDatabase(input.postgres, input.runId, input.profile);
  },
  findFreePort,
  writeCapabilitiesConfig: async (configPath, contents) => writeFile(configPath, contents),
  startServer,
  provisionCapabilityNamespaces,
  runContract,
  cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
};

/**
 * - DB·서버·capability를 준비하고 계약을 순차 실행한다.
 * - 계약 실패 결과 뒤에도 계속 실행한다.
 * - 서버 기동 전 오류는 던진다.
 * - 서버 기동 뒤 실행 오류는 서버를 종료한 뒤 완료한 계약 결과·서버 로그·정리 오류와 함께 반환한다.
 */
export async function runProfileLifecycle(
  input: ProfileLifecycleInput,
  dependencies: Partial<ProfileLifecycleDependencies> = {},
): Promise<ProfileLifecycleResult> {
  const deps = { ...defaultDependencies, ...dependencies };
  input.signal.throwIfAborted();
  const database = deps.prepareDatabase(input);
  const apiKey = randomBytes(16).toString('hex');
  const adminKey = randomBytes(16).toString('hex');
  const port = await deps.findFreePort();
  input.signal.throwIfAborted();
  const capabilities = PROFILE_CAPABILITIES[input.profile] ?? [];
  const capabilitiesConfigPath = path.join(input.workDir, `${input.profile}.capabilities.json`);
  if (capabilities.length > 0) {
    input.signal.throwIfAborted();
    await deps.writeCapabilitiesConfig(capabilitiesConfigPath, JSON.stringify(EMPTY_CAPABILITIES_CONFIG));
  }
  // resumable-upload는 유한한 세션 정책 파일을 요구한다. 처음에는 namespace 없이 유효한 파일로 기동한다.
  const needsUploadSessions = capabilities.includes('resumable-upload');
  const uploadSessionsConfigPath = path.join(input.workDir, `${input.profile}.upload-sessions.json`);
  if (needsUploadSessions) {
    input.signal.throwIfAborted();
    await deps.writeCapabilitiesConfig(
      uploadSessionsConfigPath,
      JSON.stringify(buildUploadSessionsConfig(UPLOAD_SESSION_POLICY, [])),
    );
  }
  input.signal.throwIfAborted();
  const server = await deps.startServer({
    port,
    workDir: input.workDir,
    label: input.profile,
    env: buildServerEnv({
      port,
      apiKey,
      adminKey,
      profileEnv: {
        ...PROFILE_ENV[input.profile],
        ...(capabilities.length > 0 ? { STORIX_VFS_CAPABILITIES_CONFIG_PATH: capabilitiesConfigPath } : {}),
        ...(needsUploadSessions ? { STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH: uploadSessionsConfigPath } : {}),
      },
      databaseEnv: database.env,
      storageEnv: input.blob.env,
    }),
  });
  const results: ContractResult[] = [];
  const cleanupErrors: Error[] = [];
  let executionFailed = false;
  let executionError: unknown;
  try {
    input.signal.throwIfAborted();
    // 계약별 namespace 생성에 필요한 수보다 여유 있게 준비한다.
    const provisioned =
      capabilities.length > 0
        ? await deps.provisionCapabilityNamespaces({
            signal: input.signal,
            baseUrl: server.baseUrl,
            apiKey,
            capabilities,
            count: input.contracts.length * 2,
            ...(input.profile.endsWith('-prefix') ? { idPrefix: 'abcdefghijkl' } : {}),
            configPath: capabilitiesConfigPath,
            // 활성 namespace마다 세션 정책이 있어야 서버가 다시 시작된다.
            prepareRestart: async (namespaces) => {
              if (!needsUploadSessions) return;
              input.signal.throwIfAborted();
              await deps.writeCapabilitiesConfig(
                uploadSessionsConfigPath,
                JSON.stringify(
                  buildUploadSessionsConfig(
                    UPLOAD_SESSION_POLICY,
                    namespaces.map((namespace) => namespace.id),
                  ),
                ),
              );
            },
            restart: async () => {
              input.signal.throwIfAborted();
              await server.restart();
            },
          })
        : undefined;
    input.signal.throwIfAborted();
    for (const contract of input.contracts) {
      if (input.signal.aborted) break;
      const result = await deps.runContract(
        contract,
        createContractContext({
          signal: input.signal,
          baseUrl: server.baseUrl,
          apiKey,
          adminKey,
          server: { restart: () => server.restart() },
          blobStorage: {
            stop: () => input.blob.interrupt(),
            start: () => input.blob.resume(),
            deleteAllObjects: () => input.blob.deleteAllObjects(),
          },
          contractId: contract.id,
          provisioned,
        }),
      );
      results.push(result);
      // 저장소를 멈춘 계약 뒤에도 다음 계약이 같은 저장소를 사용할 수 있게 한다.
      if (!input.signal.aborted) await input.blob.ensureRunning();
    }
  } catch (error) {
    executionFailed = true;
    executionError = error;
  } finally {
    try {
      await withCleanupTimeout('프로파일 API 서버', () => server.stop(), deps.cleanupTimeoutMs);
    } catch (error) {
      cleanupErrors.push(cleanupError(error));
    }
  }
  return {
    contracts: results,
    serverLogFile: server.logFile,
    cleanupErrors,
    ...(executionFailed ? { error: executionError } : {}),
  };
}
