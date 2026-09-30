import { randomBytes, randomUUID } from 'node:crypto';
import { createApiClient } from '../client/api-client.ts';
import type {
  ApiClient,
  ContractBlobStorage,
  ContractContext,
  ContractServer,
  NamespaceInfo,
} from '../define-contract.ts';

/** `createContractContext` 입력. */
export interface ContractContextInput {
  /** HTTP 요청과 context 제어의 새 부수 효과를 중단한다. 생략하면 취소되지 않는 실행 신호를 만든다. */
  readonly signal?: AbortSignal;

  readonly baseUrl: string;
  readonly apiKey: string;

  /** 관리자 API key. 서버 기동 env의 `STORIX_ADMIN_API_KEY`와 같은 값이다. */
  readonly adminKey: string;

  /** 계약에 노출할 서버 제어 */
  readonly server: ContractServer;

  /** 계약에 노출할 blob 저장소 제어 */
  readonly blobStorage: ContractBlobStorage;

  /** namespace 이름의 접두어로 쓴다. 소문자 kebab-case라 namespace 이름 규칙(`^[a-z0-9_-]{1,128}$`)에 맞는다. */
  readonly contractId: string;

  /**
   * 서버 기동 전에 만들어 capability를 허용해 둔 namespace. 있으면 `createNamespace()`가 앞에서부터 하나씩 꺼낸다.
   * 다 쓰면 capability가 꺼진 namespace를 몰래 만들지 않고 오류를 던진다.
   */
  readonly provisioned?: NamespaceInfo[];
}

/** API로 namespace를 만든다. 이름에 무작위 접미사를 붙여 반복 실행에서 충돌하지 않는다. */
export async function createApiNamespace(client: ApiClient, contractId: string): Promise<NamespaceInfo> {
  const name = `${contractId}-${randomBytes(3).toString('hex')}`;
  const response = await client.request('POST', '/api/v2/namespaces', {
    headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (response.status !== 201) {
    throw new Error(`namespace 생성 실패(${response.status}): ${response.text()}`);
  }
  const created = response.json<{ id: string; name: string }>();
  return { id: created.id, name: created.name };
}

/** 계약 하나에 전달할 컨텍스트를 만든다. namespace 이름에 무작위 접미사를 붙여 반복 실행에서 충돌하지 않는다. */
export function createContractContext(
  input: ContractContextInput,
  dependencies: { readonly fetch?: typeof fetch } = {},
): ContractContext {
  const signal = input.signal ?? new AbortController().signal;
  const client = createApiClient(input.baseUrl, input.apiKey, signal, dependencies.fetch);
  const control = async (action: () => Promise<void>): Promise<void> => {
    signal.throwIfAborted();
    await action();
  };
  const context = {
    signal,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    adminKey: input.adminKey,
    client,
    server: { restart: () => control(() => input.server.restart()) },
    blobStorage: {
      stop: () => control(() => input.blobStorage.stop()),
      start: () => control(() => input.blobStorage.start()),
      deleteAllObjects: () => control(() => input.blobStorage.deleteAllObjects()),
    },
    async createNamespace(options?: { readonly withoutCapabilities?: boolean }): Promise<NamespaceInfo> {
      signal.throwIfAborted();
      if (options?.withoutCapabilities !== true && input.provisioned !== undefined) {
        const next = input.provisioned.shift();
        if (next === undefined) {
          throw new Error('사전 준비한 namespace를 모두 썼다. 프로필 준비 수보다 많이 요청했다.');
        }
        return next;
      }
      return createApiNamespace(client, input.contractId);
    },
  };
  return context;
}
