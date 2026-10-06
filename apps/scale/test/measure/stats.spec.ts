import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { percentile, summarize } from '../../src/measure/stats.ts';

describe('지연 요약', () => {
  it('최근접 순위로 분위수를 계산한다', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    assert.equal(percentile(values, 0.5), 50);
    assert.equal(percentile(values, 0.95), 95);
    assert.equal(percentile(values, 1), 100);
  });

  it('빈 표본은 null이다', () => {
    assert.equal(percentile([], 0.5), null);
    assert.deepEqual(summarize([]), {
      count: 0,
      failures: 0,
      p50Ms: null,
      p95Ms: null,
      maxMs: null,
    });
  });

  it('실패 요청은 시도 수와 실패 수에 남고 분위수에는 들어가지 않는다', () => {
    const summary = summarize([
      { ms: 10, ok: true },
      { ms: 20, ok: true },
      { ms: 9999, ok: false },
    ]);
    assert.equal(summary.count, 3);
    assert.equal(summary.failures, 1);
    assert.equal(summary.maxMs, 20);
    assert.equal(summary.p50Ms, 10);
  });

  it('범위 밖 q는 거부한다', () => {
    assert.throws(() => percentile([1], 0), /q는/);
    assert.throws(() => percentile([1], 1.1), /q는/);
  });
});
