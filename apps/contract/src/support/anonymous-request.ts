import type { ApiResponse, ContractContext } from '../define-contract.ts';

/** 자격(`Authorization`) 없이 요청한다. 공개 경로와 인증 경계 계약이 쓴다. */
export async function anonymousRequest(
  ctx: ContractContext,
  method: string,
  path: string,
  init: { readonly headers?: Record<string, string>; readonly body?: string } = {},
): Promise<ApiResponse> {
  const response = await fetch(`${ctx.baseUrl}${path}`, { signal: ctx.signal, method, ...init });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    text: () => bytes.toString('utf-8'),
    json: <T = unknown>() => JSON.parse(bytes.toString('utf-8')) as T,
  };
}
