import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineContract, type ContractContext } from '../../src/define-contract.ts';
import { runContract, summarize } from '../../src/runner/run.ts';

const fakeContext: ContractContext = {
  signal: new AbortController().signal,
  baseUrl: 'http://127.0.0.1:1',
  apiKey: 'test-key',
  adminKey: 'test-admin-key',
  client: {} as ContractContext['client'],
  server: { restart: async () => {} },
  blobStorage: { stop: async () => {}, start: async () => {}, deleteAllObjects: async () => {} },
  createNamespace: async () => ({ id: 'id', name: 'name' }),
};

describe('계약 실행 결과', () => {
  it('정상 종료한 계약을 통과로 기록한다', async () => {
    const contract = defineContract({ id: 'pass', title: '통과', rq: ['RQ-005'], async run() {} });
    const result = await runContract(contract, fakeContext);
    assert.equal(result.passed, true);
    assert.equal(result.id, 'pass');
  });

  it('assert 실패를 메시지와 함께 실패로 기록하고 예외를 밖으로 던지지 않는다', async () => {
    const contract = defineContract({
      id: 'fail',
      title: '실패',
      rq: ['RQ-005'],
      async run() {
        assert.equal(1, 2);
      },
    });
    const result = await runContract(contract, fakeContext);
    assert.equal(result.passed, false);
    assert.match(result.error ?? '', /1 !== 2|Expected values/);
  });

  it('실패가 하나라도 있으면 종료 코드가 1이다', () => {
    const summary = summarize([
      { id: 'a', rq: ['RQ-005'], passed: true, durationMs: 1 },
      { id: 'b', rq: ['RQ-005'], passed: false, durationMs: 1, error: '실패' },
    ]);
    assert.deepEqual(summary, { passed: 1, failed: 1, exitCode: 1 });
  });

  it('모두 통과하면 종료 코드가 0이다', () => {
    assert.deepEqual(summarize([{ id: 'a', rq: ['RQ-005'], passed: true, durationMs: 1 }]), {
      passed: 1,
      failed: 0,
      exitCode: 0,
    });
  });

  it('결과가 없으면 통과로 취급하지 않고 종료 코드 1이다', () => {
    assert.equal(summarize([]).exitCode, 1);
  });
});
