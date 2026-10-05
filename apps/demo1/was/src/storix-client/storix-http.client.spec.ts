import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import v8 from 'node:v8';
import vm from 'node:vm';
import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import type { DemoWasConfig } from '../config/demo-was-config.js';
import { DEMO_WAS_CONFIG } from '../config/demo-was-config.js';
import { mockFetchOnce } from '../../test/fetch-mock.js';
import {
  StorixApiError,
  StorixUnreachableError,
  StorixUpstreamUnauthorizedError,
} from './storix-client.errors.js';
import { StorixHttpClient } from './storix-http.client.js';
import { storixTransport } from './storix-transport.js';

describe('StorixHttpClient', () => {
  let client: StorixHttpClient;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        StorixHttpClient,
        {
          provide: DEMO_WAS_CONFIG,
          useValue: { storixBaseUrl: 'http://storix.test', storixApiKey: 'secret-key' },
        },
      ],
    }).compile();
    client = moduleRef.get(StorixHttpClient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Authorization 헤더에 Bearer 토큰을 싣는다', async () => {
    const spy = mockFetchOnce(200, { ok: true });
    await client.requestJson({ method: 'GET', path: '/api/v2/probe' });

    const [, init] = spy.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer secret-key');
  });

  it('query 파라미터를 URL에 반영한다', async () => {
    const spy = mockFetchOnce(200, {});
    await client.requestJson({
      method: 'GET',
      path: '/api/v2/probe',
      query: { path: '/a b', empty: undefined },
    });

    const [url] = spy.mock.calls[0] as [URL];
    expect(url.toString()).toBe('http://storix.test/api/v2/probe?path=%2Fa+b');
  });

  it('실패 응답의 code/message/requestId로 StorixApiError를 던진다', async () => {
    mockFetchOnce(404, { code: 'VFS_NODE_NOT_FOUND', message: '없음', requestId: 'req-1' });

    await expect(client.requestJson({ method: 'GET', path: '/api/v2/probe' })).rejects.toMatchObject({
      code: 'VFS_NODE_NOT_FOUND',
      status: 404,
      upstreamRequestId: 'req-1',
    });
  });

  it('401은 사용자 인증 실패로 오해되지 않도록 502 StorixUpstreamUnauthorizedError로 바꾼다', async () => {
    mockFetchOnce(401, { code: 'UNAUTHORIZED', message: 'invalid api key abc', requestId: 'req-401' });

    const error = await client.requestJson({ method: 'GET', path: '/api/v2/probe' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorixUpstreamUnauthorizedError);
    expect(error).toMatchObject({
      status: 502,
      code: 'STORIX_UPSTREAM_UNAUTHORIZED',
      upstreamCode: 'UNAUTHORIZED',
      upstreamRequestId: 'req-401',
    });
    // 응답 message는 고정 문구이며 upstream message를 싣지 않는다.
    expect((error as Error).message).not.toContain('invalid api key abc');
  });

  it('401이 아닌 4xx는 StorixApiError 그대로 전달한다', async () => {
    mockFetchOnce(403, { code: 'FORBIDDEN', message: '금지', requestId: 'req-403' });

    const error = await client.requestJson({ method: 'GET', path: '/api/v2/probe' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StorixApiError);
    expect(error).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('429 Retry-After 헤더를 StorixApiError에 보존한다', async () => {
    mockFetchOnce(
      429,
      { code: 'VFS_UPLOAD_SESSION_LIMIT_EXCEEDED', message: 'limit', requestId: 'req-2' },
      { 'retry-after': '1' },
    );
    await expect(client.requestJson({ method: 'POST', path: '/api/v2/probe' })).rejects.toMatchObject({
      status: 429,
      code: 'VFS_UPLOAD_SESSION_LIMIT_EXCEEDED',
      retryAfter: '1',
    });
  });

  it('네트워크 오류는 StorixUnreachableError로 감싼다', async () => {
    jest.spyOn(storixTransport, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(client.requestJson({ method: 'GET', path: '/api/v2/probe' })).rejects.toBeInstanceOf(
      StorixUnreachableError,
    );
  });

  it('수신 측이 본문을 읽지 않으면 소스 스트림을 상한 이상 미리 읽지 않는다(백프레셔)', async () => {
    const chunkBytes = 64 * 1024;
    const totalBytes = 64 * 1024 * 1024;
    const readAheadLimitBytes = 16 * 1024 * 1024;
    let pulledBytes = 0;

    // 본문을 소비하지 않는 수신 서버. 일정 시간 뒤 소켓을 끊어 요청을 종료한다.
    const server = createServer((req, res) => {
      req.pause();
      setTimeout(() => {
        req.destroy();
        res.destroy();
      }, 500);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const source = new Readable({
      read() {
        if (pulledBytes >= totalBytes) {
          this.push(null);
          return;
        }
        pulledBytes += chunkBytes;
        this.push(Buffer.alloc(chunkBytes, 1));
      },
    });
    const streamingClient = new StorixHttpClient({
      storixBaseUrl: `http://127.0.0.1:${port}`,
      storixApiKey: 'secret-key',
    } as DemoWasConfig);

    try {
      await streamingClient
        .request({
          method: 'PUT',
          path: '/api/v2/probe',
          body: Readable.toWeb(source) as ReadableStream,
          duplex: 'half',
        })
        .catch(() => undefined);
    } finally {
      source.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(pulledBytes).toBeLessThan(readAheadLimitBytes);
  });

  it('수신 측이 본문을 즉시 소비하면 전송을 마친 청크를 요청이 끝날 때까지 보유하지 않는다', async () => {
    const chunkBytes = 64 * 1024;
    const totalChunks = 512;
    const heldLimitBytes = 8 * 1024 * 1024;

    // 강제 GC 뒤의 arrayBuffers만 남은(살아 있는) 참조로 본다.
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    gc();
    const baselineBytes = process.memoryUsage().arrayBuffers;
    let heldBytes = Number.POSITIVE_INFINITY;
    let pulledChunks = 0;

    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setImmediate(resolve));
        if (pulledChunks >= totalChunks) {
          // 마지막 청크를 요청하는 시점: 앞서 보낸 본문이 아직 붙들려 있는지 잰다.
          gc();
          heldBytes = process.memoryUsage().arrayBuffers - baselineBytes;
          controller.close();
          return;
        }
        pulledChunks += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    });
    const streamingClient = new StorixHttpClient({
      storixBaseUrl: `http://127.0.0.1:${port}`,
      storixApiKey: 'secret-key',
    } as DemoWasConfig);

    try {
      await streamingClient.request({ method: 'PUT', path: '/api/v2/probe', body, duplex: 'half' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(pulledChunks).toBe(totalChunks);
    expect(heldBytes).toBeLessThan(heldLimitBytes);
  });
});
