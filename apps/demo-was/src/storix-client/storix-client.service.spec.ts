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

  it('upload는 mimeType/contentLength를 헤더로 싣고 스트리밍 본문을 그대로 전달한다', async () => {
    const entry = { path: '/a.txt', name: 'a.txt', type: 'FILE', size: 3, mimeType: 'text/plain', createdAt: '', updatedAt: '', version: 1 };
    const spy = mockFetchOnce(201, entry);
    const body = new ReadableStream();

    await expect(
      client.upload('/a.txt', body, { mimeType: 'text/plain', contentLength: 3 }),
    ).resolves.toEqual(entry);

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v1/namespaces/ns-private-id/fs/content');
    expect(url.searchParams.get('parents')).toBe('true');
    const headers = init.headers as Headers;
    expect(headers.get('content-type')).toBe('text/plain');
    expect(headers.get('content-length')).toBe('3');
    expect(init.body).toBe(body);
    expect(init.duplex).toBe('half');
  });
});

describe('StorixClient — 다운로드/공개 발행', () => {
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
            publicUrlBase: 'http://public.test',
          },
        },
      ],
    }).compile();
    client = moduleRef.get(StorixClient);

    mockFetchOnce(201, { id: 'ns-private-id' });
    await client.ensureDemoNamespace();
    mockFetchOnce(201, { id: 'ns-public-id' });
    await client.ensurePublicNamespace();
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('createDownload는 presigned-download를 호출하고 {url, expiresAt}을 반환한다', async () => {
    const payload = { url: 'http://storage.test/signed', expiresAt: '2026-01-01T00:00:00.000Z' };
    const spy = mockFetchOnce(200, payload);
    await expect(client.createDownload('/a.txt')).resolves.toEqual(payload);

    const [url] = spy.mock.calls[0] as [URL];
    expect(url.pathname).toBe('/api/v1/namespaces/ns-private-id/fs/presigned-download');
    expect(url.searchParams.get('path')).toBe('/a.txt');
  });

  it('publish는 원본을 읽어 같은 경로로 PUBLIC namespace에 재업로드하고 고정 공개 URL을 반환한다', async () => {
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'));
        controller.close();
      },
    });
    const getSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(bodyStream, { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const putSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 201 }));

    const link = await client.publish('/documents/alice/a.txt');

    expect(link).toEqual({
      url: 'http://public.test/api/v1/public/ns-public-id/fs/download?path=%2Fdocuments%2Falice%2Fa.txt',
      publicPath: '/documents/alice/a.txt',
    });

    const [getUrl] = getSpy.mock.calls[0] as [URL];
    expect(getUrl.pathname).toBe('/api/v1/namespaces/ns-private-id/fs/content');

    const [putUrl, putInit] = putSpy.mock.calls[1] as [URL, RequestInit];
    expect(putUrl.pathname).toBe('/api/v1/namespaces/ns-public-id/fs/content');
    expect(putUrl.searchParams.get('path')).toBe('/documents/alice/a.txt');
    expect(putUrl.searchParams.get('force')).toBe('true');
    expect((putInit.headers as Headers).get('content-type')).toBe('text/plain');
  });

  it('unpublish는 PUBLIC namespace에서 같은 경로를 삭제한다', async () => {
    const spy = mockFetchOnce(204, undefined);
    await client.unpublish('/documents/alice/a.txt');

    const [url] = spy.mock.calls[0] as [URL];
    expect(url.pathname).toBe('/api/v1/namespaces/ns-public-id/fs/rm');
    expect(url.searchParams.get('path')).toBe('/documents/alice/a.txt');
  });
});
