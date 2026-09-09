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

describe('StorixClient — VFS 조작', () => {
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

    mockFetchOnce(201, { id: 'ns-private-id' });
    await client.ensureDemoNamespace();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('list는 ls를 호출하고 EntryPage를 반환한다', async () => {
    const page = { items: [], nextCursor: null };
    const spy = mockFetchOnce(200, page);
    await expect(client.list('/docs', 'cursor-1')).resolves.toEqual(page);

    const [url] = spy.mock.calls[0] as [URL];
    expect(url.pathname).toBe('/api/v1/namespaces/ns-private-id/fs/ls');
    expect(url.searchParams.get('path')).toBe('/docs');
    expect(url.searchParams.get('cursor')).toBe('cursor-1');
  });

  it('createDirectory는 parents=true로 mkdir를 호출한다', async () => {
    const spy = mockFetchOnce(201, {});
    await client.createDirectory('/docs/new');

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v1/namespaces/ns-private-id/fs/mkdir');
    expect(JSON.parse(init.body as string)).toEqual({ path: '/docs/new', parents: true });
  });

  it('move는 destinationParents=true로 mv를 호출한다', async () => {
    const spy = mockFetchOnce(200, {});
    await client.move('/a.txt', '/b.txt');

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v1/namespaces/ns-private-id/fs/mv');
    expect(JSON.parse(init.body as string)).toEqual({
      source: '/a.txt',
      destination: '/b.txt',
      destinationParents: true,
    });
  });

  it('copy는 destinationParents=true로 cp를 호출한다', async () => {
    const spy = mockFetchOnce(201, {});
    await client.copy('/a.txt', '/copy/a.txt');

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v1/namespaces/ns-private-id/fs/cp');
    expect(JSON.parse(init.body as string)).toEqual({
      source: '/a.txt',
      destination: '/copy/a.txt',
      destinationParents: true,
    });
  });

  it('remove는 path/recursive 쿼리로 rm을 호출한다', async () => {
    const spy = mockFetchOnce(204, undefined);
    await client.remove('/dir', true);

    const [url] = spy.mock.calls[0] as [URL];
    expect(url.pathname).toBe('/api/v1/namespaces/ns-private-id/fs/rm');
    expect(url.searchParams.get('path')).toBe('/dir');
    expect(url.searchParams.get('recursive')).toBe('true');
  });

  it('find는 path/name/cursor 쿼리로 find를 호출한다', async () => {
    const page = { items: [], nextCursor: null };
    const spy = mockFetchOnce(200, page);
    await expect(client.find('/docs', 'report', 'cursor-2')).resolves.toEqual(page);

    const [url] = spy.mock.calls[0] as [URL];
    expect(url.pathname).toBe('/api/v1/namespaces/ns-private-id/fs/find');
    expect(url.searchParams.get('name')).toBe('report');
    expect(url.searchParams.get('cursor')).toBe('cursor-2');
  });
});
