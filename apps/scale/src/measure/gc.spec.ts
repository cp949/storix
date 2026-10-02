import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasExhaustedStages, type GcRun } from './gc.ts';

function run(result: Record<string, unknown> | null): GcRun {
  return {
    wallMs: 1,
    exitCode: 0,
    timedOut: false,
    skipped: false,
    peakRssBytes: 1,
    result,
    logFile: 'gc.log',
  };
}

describe('hasExhaustedStages', () => {
  it('예산 소진 단계가 있으면 true를 반환한다', () => {
    assert.equal(hasExhaustedStages(run({ budgetExhaustedStages: ['idempotency-receipt-prune'] })), true);
  });

  it('예산 소진 단계가 비면 false를 반환한다', () => {
    assert.equal(hasExhaustedStages(run({ budgetExhaustedStages: [] })), false);
  });

  it('결과를 읽지 못하면 남은 것으로 본다', () => {
    assert.equal(hasExhaustedStages(run(null)), true);
  });
});
