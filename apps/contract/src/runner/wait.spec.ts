import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { waitUntil } from './wait.ts';

describe('조건 대기(waitUntil)', () => {
  it('조건이 참이 될 때까지 반복해서 확인한다', async () => {
    let calls = 0;
    await waitUntil(async () => ++calls >= 3, { timeoutMs: 1000, intervalMs: 5, description: '테스트' });
    assert.equal(calls, 3);
  });

  it('확인 중 던진 오류는 준비 전 상태로 보고 재시도한다', async () => {
    let calls = 0;
    await waitUntil(
      async () => {
        if (++calls < 3) throw new Error('연결 거부');
        return true;
      },
      { timeoutMs: 1000, intervalMs: 5, description: '테스트' },
    );
    assert.equal(calls, 3);
  });

  it('제한 시간을 넘으면 설명이 담긴 오류를 던진다', async () => {
    await assert.rejects(
      waitUntil(async () => false, { timeoutMs: 30, intervalMs: 5, description: '서버 준비' }),
      /서버 준비.*시간 초과/,
    );
  });
});
