import assert from 'node:assert/strict';
import type { ApiResponse } from '../define-contract.ts';

/** 재전송 응답이 최초 응답과 status·본문·`X-Request-Id`까지 같은지 확인한다. */
export function assertReplayed(replay: ApiResponse, first: ApiResponse, label: string): void {
  assert.equal(replay.status, first.status, `${label}: ${replay.text()}`);
  assert.deepEqual(replay.json(), first.json(), label);
  assert.equal(replay.headers.get('x-request-id'), first.headers.get('x-request-id'), label);
}
