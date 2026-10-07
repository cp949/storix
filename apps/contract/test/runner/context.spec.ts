import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createContractContext } from '../../src/runner/context.ts';

const server = { restart: async () => {}, restartWithUploadSessionLimits: async () => {} };
const blobStorage = {
  stop: async () => {},
  start: async () => {},
  deleteAllObjects: async () => {},
};

describe('계약 컨텍스트의 사전 준비 namespace 풀', () => {
  it('풀이 있으면 API를 부르지 않고 앞에서부터 하나씩 꺼낸다', async () => {
    const ctx = createContractContext({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'key',
      adminKey: 'admin-key',
      server,
      blobStorage,
      contractId: 'sample',
      signal: new AbortController().signal,
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
      adminKey: 'admin-key',
      server,
      blobStorage,
      contractId: 'sample',
      signal: new AbortController().signal,
      provisioned: [],
    });
    await assert.rejects(() => ctx.createNamespace(), /사전 준비한 namespace/);
  });
});

describe('계약 컨텍스트의 namespace 접근 정책', () => {
  const input = {
    baseUrl: 'http://example.test',
    apiKey: 'key',
    adminKey: 'admin',
    server,
    blobStorage,
    contractId: 'sample',
  };

  it('accessPolicy를 주면 사전 준비 풀을 쓰지 않고 API 요청 본문에 실어 만든다', async () => {
    const bodies: unknown[] = [];
    const ctx = createContractContext(
      { ...input, provisioned: [{ id: 'id-1', name: 'one' }] },
      {
        async fetch(_url, options) {
          bodies.push(JSON.parse(String(options?.body)));
          return new Response(JSON.stringify({ id: 'public-id', name: 'sample-x' }), { status: 201 });
        },
      },
    );
    assert.deepEqual(await ctx.createNamespace({ accessPolicy: 'PUBLIC' }), {
      id: 'public-id',
      name: 'sample-x',
    });
    assert.equal((bodies[0] as { accessPolicy: string }).accessPolicy, 'PUBLIC');
    // 풀의 namespace는 소비되지 않고 그대로 남는다.
    assert.deepEqual(await ctx.createNamespace(), { id: 'id-1', name: 'one' });
  });

  it("accessPolicy: 'PRIVATE'를 명시해도 사전 준비 풀을 쓰지 않고 본문에 싣는다", async () => {
    const bodies: unknown[] = [];
    const ctx = createContractContext(
      { ...input, provisioned: [{ id: 'id-1', name: 'one' }] },
      {
        async fetch(_url, options) {
          bodies.push(JSON.parse(String(options?.body)));
          return new Response(JSON.stringify({ id: 'api-id', name: 'sample-z' }), { status: 201 });
        },
      },
    );
    assert.deepEqual(await ctx.createNamespace({ accessPolicy: 'PRIVATE' }), {
      id: 'api-id',
      name: 'sample-z',
    });
    assert.equal((bodies[0] as { accessPolicy: string }).accessPolicy, 'PRIVATE');
    assert.deepEqual(await ctx.createNamespace(), { id: 'id-1', name: 'one' });
  });

  it('accessPolicy를 주지 않으면 요청 본문에 필드를 넣지 않는다', async () => {
    const bodies: unknown[] = [];
    const ctx = createContractContext(input, {
      async fetch(_url, options) {
        bodies.push(JSON.parse(String(options?.body)));
        return new Response(JSON.stringify({ id: 'private-id', name: 'sample-y' }), { status: 201 });
      },
    });
    await ctx.createNamespace();
    assert.equal('accessPolicy' in (bodies[0] as object), false);
  });
});

describe('계약 컨텍스트의 관리자 key', () => {
  it('서비스 key와 별개로 관리자 key를 노출한다', () => {
    const ctx = createContractContext({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'service',
      adminKey: 'admin',
      server,
      blobStorage,
      contractId: 'sample',
      signal: new AbortController().signal,
    });
    assert.equal(ctx.apiKey, 'service');
    assert.equal(ctx.adminKey, 'admin');
  });
});

describe('계약 컨텍스트의 업로드 정책 제어', () => {
  it('준비 서버의 정책 변경을 전달하고 취소 뒤에는 호출하지 않는다', async () => {
    const received: unknown[] = [];
    const ctx = createContractContext({
      baseUrl: 'http://127.0.0.1:1',
      apiKey: 'key',
      adminKey: 'admin',
      server: {
        restart: async () => {},
        restartWithUploadSessionLimits: async (limits) => {
          received.push(limits);
        },
      },
      blobStorage,
      contractId: 'sample',
      signal: new AbortController().signal,
    });
    const limits = { namespaceId: 'namespace', maxStagedBytes: '8', partSizeBytes: 2 };
    await ctx.server.restartWithUploadSessionLimits(limits);
    assert.deepEqual(received, [limits]);
  });
});

// 취소 이후 풀 소비와 HTTP·서버·blob 제어를 모두 막는다.
describe('계약 컨텍스트의 취소', () => {
  it('client 요청에 실행 신호를 전달한다', async () => {
    const controller = new AbortController();
    const ctx = createContractContext(
      {
        baseUrl: 'http://example.test',
        apiKey: 'key',
        adminKey: 'admin',
        contractId: 'sample',
        server,
        blobStorage,
        signal: controller.signal,
      },
      {
        async fetch(_url, options) {
          assert.equal(options?.signal, controller.signal);
          return new Response('ok');
        },
      },
    );
    assert.equal(ctx.signal, controller.signal);
    assert.equal((await ctx.client.getContent('namespace', '/file')).text(), 'ok');
  });

  it('취소 뒤 namespace와 context 제어는 부수 효과를 시작하지 않는다', async () => {
    const controller = new AbortController();
    const effects: string[] = [];
    const pool = [{ id: 'prepared', name: 'prepared' }];
    const ctx = createContractContext(
      {
        baseUrl: 'http://example.test',
        apiKey: 'key',
        adminKey: 'admin',
        contractId: 'sample',
        signal: controller.signal,
        provisioned: pool,
        server: {
          async restart() {
            effects.push('restart');
          },
          async restartWithUploadSessionLimits() {
            effects.push('upload-policy');
          },
        },
        blobStorage: {
          async stop() {
            effects.push('stop');
          },
          async start() {
            effects.push('start');
          },
          async deleteAllObjects() {
            effects.push('delete');
          },
        },
      },
      {
        async fetch() {
          effects.push('fetch');
          return new Response('{}');
        },
      },
    );
    controller.abort();
    for (const action of [
      () => ctx.createNamespace(),
      () => ctx.createNamespace({ withoutCapabilities: true }),
      () => ctx.client.request('POST', '/namespace'),
      () => ctx.server.restart(),
      () => ctx.server.restartWithUploadSessionLimits({ namespaceId: 'id', maxStagedBytes: '8' }),
      () => ctx.blobStorage.stop(),
      () => ctx.blobStorage.start(),
      () => ctx.blobStorage.deleteAllObjects(),
    ])
      await assert.rejects(action, { name: 'AbortError' });
    assert.deepEqual(effects, []);
    assert.equal(pool.length, 1);
  });
});
