import { writeFile } from 'node:fs/promises';
import type { NamespaceInfo } from '../define-contract.ts';
import { createContractContext } from './context.ts';

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

/** 선택 capability를 하나도 허용하지 않는 설정. 서버를 처음 기동할 때 파일이 유효하도록 쓴다. */
export const EMPTY_CAPABILITIES_CONFIG: CapabilitiesConfig = buildCapabilitiesConfig([], []);

/** `provisionCapabilityNamespaces` 입력. */
export interface ProvisionInput {
  readonly baseUrl: string;
  readonly apiKey: string;

  /** 허용할 capability ID 목록 */
  readonly capabilities: readonly string[];

  /** 미리 만들 namespace 수. 프로필의 계약이 `createNamespace()`를 부르는 횟수 이상이어야 한다. */
  readonly count: number;

  /** 서버가 읽는 설정 파일 경로. 이 파일을 덮어쓴다. */
  readonly configPath: string;

  /** 설정을 다시 읽도록 서버를 재시작한다. */
  restart(): Promise<void>;
}

/**
 * capability 설정은 namespace ID를 시작 시 검증하므로 namespace를 먼저 만든 뒤 설정을 쓰고 재시작한다.
 * 서버는 `EMPTY_CAPABILITIES_CONFIG`를 담은 설정 파일로 이미 기동한 상태여야 한다.
 */
export async function provisionCapabilityNamespaces(input: ProvisionInput): Promise<NamespaceInfo[]> {
  const creator = createContractContext({
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    server: { restart: input.restart },
    contractId: 'provisioned',
  });
  const namespaces: NamespaceInfo[] = [];
  for (let index = 0; index < input.count; index += 1) {
    namespaces.push(await creator.createNamespace());
  }
  const config = buildCapabilitiesConfig(
    input.capabilities,
    namespaces.map((namespace) => namespace.id),
  );
  await writeFile(input.configPath, JSON.stringify(config));
  await input.restart();
  return namespaces;
}
