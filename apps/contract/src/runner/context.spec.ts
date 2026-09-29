import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createContractContext } from './context.ts';

const server = { restart: async () => {} };

describe('계약 컨텍스트의 사전 준비 namespace 풀', () => {
  it('풀이 있으면 API를 부르지 않고 앞에서부터 하나씩 꺼낸다', async () => {
    const ctx = createContractContext({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'key',
      server,
      contractId: 'sample',
      provisioned: [
        { id: 'id-1', name: 'one' },
        { id: 'id-2', name: 'two' },
      ],
    });
    assert.deepEqual(await ctx.createNamespace(), { id: 'id-1', name: 'one' });
    assert.deepEqual(await ctx.createNamespace(), { id: 'id-2', name: 'two' });
  });

  it('풀을 모두 쓰면 비활성 namespace를 몰래 만들지 않고 오류를 던진다', async () => {
    const ctx = createContractContext({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'key',
      server,
      contractId: 'sample',
      provisioned: [],
    });
    await assert.rejects(() => ctx.createNamespace(), /사전 준비한 namespace/);
  });
});
