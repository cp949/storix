import { writeFile } from 'node:fs/promises';
import type { NamespaceInfo } from '../define-contract.ts';
import { createApiClient } from '../client/api-client.ts';
import { createApiNamespace } from './context.ts';
import type { UPLOAD_SESSION_POLICY } from './profiles.ts';

/** 세션 정책 값. */
export interface UploadSessionPolicy {
  readonly partSizeBytes: number;
  readonly maxStagedBytes: string;
  readonly maxActiveSessions: number;
}

/** 시작 설정 JSON의 내용. `STORIX_VFS_CAPABILITIES_CONFIG_PATH`가 가리키는 파일 형식이다. */
export interface CapabilitiesConfig {
  readonly globalAllowedCapabilities: readonly string[];
  readonly namespaceAllowedCapabilities: Readonly<Record<string, readonly string[]>>;
}

/** 전역과 각 namespace에 같은 capability를 허용하는 설정을 만든다. */
export function buildCapabilitiesConfig(
  capabilities: readonly string[],
  namespaceIds: readonly string[],
): CapabilitiesConfig {
  return {
    globalAllowedCapabilities: [...capabilities],
    namespaceAllowedCapabilities: Object.fromEntries(namespaceIds.map((id) => [id, [...capabilities]])),
  };
}

/** 시작 설정 JSON의 내용. `STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH`가 가리키는 파일 형식이다. */
export interface UploadSessionsConfig {
  readonly global: {
    readonly maxStagedBytes: string;
    readonly maxActiveSessions: number;
    readonly partSizeBytes: number;
  };
  readonly namespaces: Readonly<Record<string, { maxStagedBytes: string; maxActiveSessions: number }>>;
}

/** 전역 정책을 각 namespace에도 같은 한도로 적용하는 세션 정책 설정을 만든다. */
export function buildUploadSessionsConfig(
  policy: UploadSessionPolicy,
  namespaceIds: readonly string[],
): UploadSessionsConfig {
  return {
    global: {
      maxStagedBytes: policy.maxStagedBytes,
      maxActiveSessions: policy.maxActiveSessions,
      partSizeBytes: policy.partSizeBytes,
    },
    namespaces: Object.fromEntries(
      namespaceIds.map((id) => [
        id,
        { maxStagedBytes: policy.maxStagedBytes, maxActiveSessions: policy.maxActiveSessions },
      ]),
    ),
  };
}

/** 선택 capability를 하나도 허용하지 않는 설정. 서버를 처음 기동할 때 파일이 유효하도록 쓴다. */
export const EMPTY_CAPABILITIES_CONFIG: CapabilitiesConfig = buildCapabilitiesConfig([], []);

/** `provisionCapabilityNamespaces` 입력. */
export interface ProvisionInput {
  /** namespace 생성·설정 쓰기·restart 전에 검사하는 실행 취소 신호다. */
  readonly signal: AbortSignal;

  readonly baseUrl: string;
  readonly apiKey: string;

  /** 허용할 capability ID 목록 */
  readonly capabilities: readonly string[];

  /** 미리 만들 namespace 수. 프로필의 계약이 `createNamespace()`를 부르는 횟수 이상이어야 한다. */
  readonly count: number;

  /** 각 사전 준비 namespace에 붙일 ID prefix */
  readonly idPrefix?: string;

  /** 서버가 읽는 설정 파일 경로. 이 파일을 덮어쓴다. */
  readonly configPath: string;

  /** capability 설정을 쓴 뒤 재시작 전에 호출한다. 다른 시작 설정 파일(세션 정책 등)이 namespace ID를 요구할 때 쓴다. */
  prepareRestart?(namespaces: readonly NamespaceInfo[]): Promise<void>;

  /** 설정을 다시 읽도록 서버를 재시작한다. */
  restart(): Promise<void>;
}

/** provisioning의 HTTP 전송과 설정 쓰기를 교체하는 의존성이다. */
export interface ProvisionDependencies {
  /** 모든 namespace 생성 요청에 실행 신호를 전달한다. */
  readonly fetch: typeof fetch;

  /** 서버가 읽을 capability 설정 파일을 쓴다. */
  writeCapabilitiesConfig(configPath: string, contents: string): Promise<void>;
}

/**
 * capability 설정은 namespace ID를 시작 시 검증하므로 namespace를 먼저 만든 뒤 설정을 쓰고 재시작한다.
 * 서버는 `EMPTY_CAPABILITIES_CONFIG`를 담은 설정 파일로 이미 기동한 상태여야 한다.
 */
export async function provisionCapabilityNamespaces(
  input: ProvisionInput,
  dependencies: Partial<ProvisionDependencies> = {},
): Promise<NamespaceInfo[]> {
  const client = createApiClient(input.baseUrl, input.apiKey, input.signal, dependencies.fetch);
  const namespaces: NamespaceInfo[] = [];
  for (let index = 0; index < input.count; index += 1) {
    input.signal.throwIfAborted();
    namespaces.push(await createApiNamespace(client, 'provisioned', undefined, input.idPrefix));
  }
  const config = buildCapabilitiesConfig(
    input.capabilities,
    namespaces.map((namespace) => namespace.id),
  );
  input.signal.throwIfAborted();
  await (dependencies.writeCapabilitiesConfig ?? writeFile)(input.configPath, JSON.stringify(config));
  input.signal.throwIfAborted();
  await input.prepareRestart?.(namespaces);
  input.signal.throwIfAborted();
  await input.restart();
  return namespaces;
}
