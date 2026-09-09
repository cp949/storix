import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { DEMO_WAS_CONFIG } from '../config/demo-was-config.js';
import { mockFetchOnce } from '../../test/fetch-mock.js';
import { StorixClient } from './storix-client.service.js';
import { StorixHttpClient } from './storix-http.client.js';

describe('StorixClient — namespace 부트스트랩', () => {
  let client: StorixClient;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        StorixClient,
        StorixHttpClient,
        {
          provide: DEMO_WAS_CONFIG,
          useValue: {
            storixBaseUrl: 'http://storix.test',
            storixApiKey: 'key',
            namespaceName: 'demo',
            publicNamespaceName: 'demo-public',
            publicUrlBase: 'http://storix.test',
          },
        },
      ],
    }).compile();
    client = moduleRef.get(StorixClient);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('ensureDemoNamespace는 고정 Idempotency-Key로 PRIVATE namespace를 생성한다', async () => {
    const spy = mockFetchOnce(201, { id: 'ns-private-id' });
    const id = await client.ensureDemoNamespace();

    expect(id).toBe('ns-private-id');
    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://storix.test/api/v1/namespaces');
    const headers = init.headers as Headers;
    expect(headers.get('idempotency-key')).toBe('demo-was:namespace:private');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'demo',
      encryptionPolicy: 'NONE',
      accessPolicy: 'PRIVATE',
    });
  });

  it('ensurePublicNamespace는 고정 Idempotency-Key로 PUBLIC namespace를 생성한다', async () => {
    const spy = mockFetchOnce(201, { id: 'ns-public-id' });
    const id = await client.ensurePublicNamespace();

    expect(id).toBe('ns-public-id');
    const [, init] = spy.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get('idempotency-key')).toBe('demo-was:namespace:public');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'demo-public',
      encryptionPolicy: 'NONE',
      accessPolicy: 'PUBLIC',
    });
  });
});
