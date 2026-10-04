// 소비자 기대: 호출 서버가 경로를 잘못 만들어 없는 라우트를 호출해도 오류 body의 `code`로 입력 오류(BAD_REQUEST)와 구분할 수 있다.
// 대응 요구사항: RQ-018(안정적인 오류 분류).
import assert from 'node:assert/strict';
import { defineContract } from '../../define-contract.ts';

interface ErrorBody {
  code: string;
  message: string;
  requestId: string;
}

export default defineContract({
  id: 'unknown-route',
  title: '없는 라우트는 404 NOT_FOUND와 requestId로 응답하고 입력 오류 code와 구분된다',
  rq: ['RQ-018'],
  async run(ctx) {
    for (const [method, path] of [
      ['GET', '/api/v2/no-such-route'],
      ['POST', '/api/v2/namespaces/no-such/route'],
    ] as const) {
      const response = await ctx.client.request(method, path);
      assert.equal(response.status, 404, `${method} ${path}`);
      const body = response.json<ErrorBody>();
      assert.equal(body.code, 'NOT_FOUND', `${method} ${path}`);
      assert.equal(typeof body.message, 'string');
      assert.ok(body.requestId.length > 0, 'requestId가 있어야 한다');
    }
  },
});
