import { jest } from '@jest/globals';

export function mockFetchOnce(status: number, body: unknown, headers: Record<string, string> = {}) {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    }),
  );
}
