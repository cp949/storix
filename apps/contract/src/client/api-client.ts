import { randomUUID } from 'node:crypto';
import type { ApiClient, ApiResponse, ContentCondition, MutationOptions } from '../define-contract.ts';

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

  const jsonHeaders = (options: MutationOptions): Record<string, string> => ({
    'Idempotency-Key': options.idempotencyKey ?? randomUUID(),
    'X-Mutation-Scope': MUTATION_SCOPE,
    'Content-Type': 'application/json',
  });
  const snapshotUrl = (namespaceId: string, suffix = ''): string =>
    `/api/v2/namespaces/${namespaceId}/fs/snapshots${suffix}`;

  return {
    request,

    putConditionalContent(
      namespaceId: string,
      filePath: string,
      bytes: Buffer,
      condition: ContentCondition,
      options: MutationOptions & { readonly contentType?: string; readonly expectedSha256?: string } = {},
    ) {
      const conditionHeader: Record<string, string> =
        'ifAbsent' in condition ? { 'X-If-Absent': 'true' } : { 'X-If-Revision': condition.ifRevision };
      return request('POST', contentUrl(namespaceId, 'content/conditional', filePath), {
        headers: {
          'Idempotency-Key': options.idempotencyKey ?? randomUUID(),
          'X-Mutation-Scope': MUTATION_SCOPE,
          'Content-Type': options.contentType ?? 'application/octet-stream',
          ...conditionHeader,
          ...(options.expectedSha256 === undefined ? {} : { 'X-Content-Sha256': options.expectedSha256 }),
        },
        body: bytes,
      });
    },

    getContent(namespaceId: string, filePath: string, options = {}) {
      return request('GET', contentUrl(namespaceId, 'content', filePath), { headers: options.headers });
    },

    listDirectory(namespaceId: string, dirPath: string, options = {}) {
      const query = new URLSearchParams({ path: dirPath });
      if (options.cursor !== undefined) query.set('cursor', options.cursor);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      if (options.consistency !== undefined) query.set('consistency', options.consistency);
      return request('GET', `/api/v2/namespaces/${namespaceId}/fs/ls?${query}`);
    },

    listChanges(namespaceId: string, options = {}) {
      const query = new URLSearchParams();
      if (options.cursor !== undefined) query.set('cursor', options.cursor);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      const suffix = query.size === 0 ? '' : `?${query}`;
      return request('GET', `/api/v2/namespaces/${namespaceId}/fs/changes${suffix}`);
    },

    listCapabilities(namespaceId: string) {
      return request('GET', `/api/v2/namespaces/${namespaceId}/capabilities`);
    },

    move(namespaceId: string, body: object) {
      return request('POST', `/api/v2/namespaces/${namespaceId}/fs/mv`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },

    copy(namespaceId: string, body: object) {
      return request('POST', `/api/v2/namespaces/${namespaceId}/fs/cp`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    },

    remove(namespaceId: string, targetPath: string, recursive = false) {
      return request(
        'POST',
        `${contentUrl(namespaceId, 'rm', targetPath)}&recursive=${recursive ? 'true' : 'false'}`,
      );
    },

    getStat(namespaceId: string, filePath: string) {
      return request('GET', contentUrl(namespaceId, 'stat', filePath));
    },

    mkdir(namespaceId: string, dirPath: string, parents = false) {
      return request('POST', `/api/v2/namespaces/${namespaceId}/fs/mkdir`, {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath, parents }),
      });
    },

    postMutation(namespaceId: string, body: object, options: MutationOptions = {}) {
      return request('POST', `/api/v2/namespaces/${namespaceId}/fs/mutations`, {
        headers: jsonHeaders(options),
        body: JSON.stringify(body),
      });
    },

    createSnapshot(namespaceId: string, body: object, options: MutationOptions = {}) {
      return request('POST', snapshotUrl(namespaceId), {
        headers: jsonHeaders(options),
        body: JSON.stringify(body),
      });
    },

    getSnapshot(namespaceId: string, snapshotId: string) {
      return request('GET', snapshotUrl(namespaceId, `/${snapshotId}`));
    },

    listSnapshots(namespaceId: string, rootNodeId: string, options = {}) {
      const query = new URLSearchParams({ rootNodeId });
      if (options.cursor !== undefined) query.set('cursor', options.cursor);
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      return request('GET', `${snapshotUrl(namespaceId)}?${query}`);
    },

    getSnapshotContent(namespaceId: string, snapshotId: string) {
      return request('GET', snapshotUrl(namespaceId, `/${snapshotId}/content`));
    },

    restoreSnapshot(namespaceId: string, snapshotId: string, body: object, options: MutationOptions = {}) {
      return request('POST', snapshotUrl(namespaceId, `/${snapshotId}/restore`), {
        headers: jsonHeaders(options),
        body: JSON.stringify(body),
      });
    },

    deleteSnapshot(namespaceId: string, snapshotId: string, options: MutationOptions = {}) {
      return request('POST', snapshotUrl(namespaceId, `/${snapshotId}/delete`), {
        headers: jsonHeaders(options),
        body: JSON.stringify({}),
      });
    },
  };
}
