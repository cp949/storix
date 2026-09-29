import { randomUUID } from 'node:crypto';
import type { ApiClient, ApiResponse, ContentCondition } from '../define-contract.ts';

/** 호출자 scope. 계약 검증이 보내는 모든 변경 요청이 같은 값을 쓴다. */
const MUTATION_SCOPE = 'storix-contract';

/**
 * 서비스 API key(`Authorization: Bearer`)로 인증하는 HTTP 클라이언트를 만든다.
 * 공개 HTTP 계약만 호출한다. 응답 본문은 항상 바이트로 읽어 둔다.
 */
export function createApiClient(baseUrl: string, apiKey: string): ApiClient {
  const request: ApiClient['request'] = async (method, path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...options.headers },
      body: options.body,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const result: ApiResponse = {
      status: response.status,
      headers: response.headers,
      bytes,
      text: () => bytes.toString('utf-8'),
      json: <T = unknown>() => JSON.parse(bytes.toString('utf-8')) as T,
    };
    return result;
  };

  const contentUrl = (namespaceId: string, route: string, filePath: string): string =>
    `/api/v2/namespaces/${namespaceId}/fs/${route}?path=${encodeURIComponent(filePath)}`;

  return {
    request,

    putConditionalContent(namespaceId: string, filePath: string, bytes: Buffer, condition: ContentCondition) {
      const conditionHeader: Record<string, string> =
        'ifAbsent' in condition ? { 'X-If-Absent': 'true' } : { 'X-If-Revision': condition.ifRevision };
      return request('POST', contentUrl(namespaceId, 'content/conditional', filePath), {
        headers: {
          'Idempotency-Key': randomUUID(),
          'X-Mutation-Scope': MUTATION_SCOPE,
          'Content-Type': 'application/octet-stream',
          ...conditionHeader,
        },
        body: bytes,
      });
    },

    getContent(namespaceId: string, filePath: string) {
      return request('GET', contentUrl(namespaceId, 'content', filePath));
    },
  };
}
