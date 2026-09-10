import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { DEMO_WAS_CONFIG } from '../config/demo-was-config.js';
import { mockFetchOnce } from '../../test/fetch-mock.js';
import { StorixUnreachableError } from './storix-client.errors.js';
import { StorixHttpClient } from './storix-http.client.js';

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
    await client.requestJson({ method: 'GET', path: '/api/v1/probe' });

    const [, init] = spy.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer secret-key');
  });

  it('query 파라미터를 URL에 반영한다', async () => {
    const spy = mockFetchOnce(200, {});
    await client.requestJson({ method: 'GET', path: '/api/v1/probe', query: { path: '/a b', empty: undefined } });

    const [url] = spy.mock.calls[0] as [URL];
    expect(url.toString()).toBe('http://storix.test/api/v1/probe?path=%2Fa+b');
  });

  it('실패 응답의 code/message/requestId로 StorixApiError를 던진다', async () => {
    mockFetchOnce(404, { code: 'VFS_NODE_NOT_FOUND', message: '없음', requestId: 'req-1' });

    await expect(client.requestJson({ method: 'GET', path: '/api/v1/probe' })).rejects.toMatchObject({
      code: 'VFS_NODE_NOT_FOUND',
      status: 404,
      upstreamRequestId: 'req-1',
    });
  });

  it('네트워크 오류는 StorixUnreachableError로 감싼다', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(client.requestJson({ method: 'GET', path: '/api/v1/probe' })).rejects.toBeInstanceOf(
      StorixUnreachableError,
    );
  });
});
