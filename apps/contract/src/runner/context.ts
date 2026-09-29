import { randomBytes, randomUUID } from 'node:crypto';
import { createApiClient } from '../client/api-client.ts';
import type { ContractContext, NamespaceInfo } from '../define-contract.ts';

/** `createContractContext` 입력. */
export interface ContractContextInput {
  readonly baseUrl: string;
  readonly apiKey: string;

  /** namespace 이름의 접두어로 쓴다. 소문자 kebab-case라 namespace 이름 규칙(`^[a-z0-9_-]{1,128}$`)에 맞는다. */
  readonly contractId: string;
}

/** 계약 하나에 전달할 컨텍스트를 만든다. namespace 이름에 무작위 접미사를 붙여 반복 실행에서 충돌하지 않는다. */
export function createContractContext(input: ContractContextInput): ContractContext {
  const client = createApiClient(input.baseUrl, input.apiKey);
  return {
    baseUrl: input.baseUrl,
    client,
    async createNamespace(): Promise<NamespaceInfo> {
      const name = `${input.contractId}-${randomBytes(3).toString('hex')}`;
      const response = await client.request('POST', '/api/v2/namespaces', {
        headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (response.status !== 201) {
        throw new Error(`namespace 생성 실패(${response.status}): ${response.text()}`);
      }
      const created = response.json<{ id: string; name: string }>();
      return { id: created.id, name: created.name };
    },
  };
}
