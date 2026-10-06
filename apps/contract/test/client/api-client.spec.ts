/**
 * HTTP 요청과 응답 본문 대기를 실제 루프백 서버에서 취소한다.
 * 규칙은 docs/design/12-contract-checks.md "중단과 정리".
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it } from 'node:test';
import { createApiClient } from '../../src/client/api-client.ts';

/** ES2023 lib 범위에서 테스트의 시작·재개 시점을 제어한다. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// 응답 헤더 대기와 본문 대기 모두 실행 signal로 중단돼야 한다.
describe('API client 취소', () => {
  for (const phase of ['headers', 'body'] as const) {
    it(`${phase} 대기 중 abort가 AbortError로 끝난다`, async () => {
      const controller = new AbortController();
      const arrived = deferred();
      const readingBody = deferred();
      const server = createServer((_request, response) => {
        if (phase === 'body') {
          response.writeHead(200);
          response.write('partial');
        }
        arrived.resolve();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address !== null && typeof address !== 'string');
      const fetchRequest: typeof fetch = async (url, options) => {
        const response = await fetch(url, options);
        const arrayBuffer = response.arrayBuffer.bind(response);
        Object.defineProperty(response, 'arrayBuffer', {
          value() {
            const pending = arrayBuffer();
            // 응답을 받은 client가 실제 미완료 본문 읽기를 시작한 뒤에만 취소한다.
            readingBody.resolve();
            return pending;
          },
        });
        return response;
      };
      const client = createApiClient(
        `http://127.0.0.1:${address.port}`,
        'key',
        controller.signal,
        fetchRequest,
      );
      const request = client.request('GET', '/pending');
      const rejected = assert.rejects(request, { name: 'AbortError' });
      try {
        await (phase === 'body' ? readingBody.promise : arrived.promise);
        controller.abort();
        // RED에서도 실행을 무한 대기하지 않게 실제 socket을 닫는다.
        setTimeout(() => server.closeAllConnections(), 100);
        await rejected;
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});
