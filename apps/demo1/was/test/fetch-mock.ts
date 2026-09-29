import { jest } from '@jest/globals';
import { storixTransport } from '../src/storix-client/storix-transport.js';

type TransportResponse = Awaited<ReturnType<typeof storixTransport.fetch>>;

// 전역 Response를 undici fetch의 응답 타입으로 좁힌다. 테스트가 만든 응답은 런타임에 동일하게 쓰인다.
export function transportResponse(response: Response): TransportResponse {
  return response as unknown as TransportResponse;
}

export function mockFetchOnce(status: number, body: unknown, headers: Record<string, string> = {}) {
  return jest.spyOn(storixTransport, 'fetch').mockResolvedValueOnce(
    transportResponse(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    ),
  );
}
