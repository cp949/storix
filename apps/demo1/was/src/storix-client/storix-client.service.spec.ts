import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { DEMO_WAS_CONFIG } from '../config/demo-was-config.js';
import { mockFetchOnce, transportResponse } from '../../test/fetch-mock.js';
import { StorixClient } from './storix-client.service.js';
import { StorixHttpClient } from './storix-http.client.js';
import { storixTransport } from './storix-transport.js';
import { derivePublicPath } from './public-path.js';

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
    expect(url.toString()).toBe('http://storix.test/api/v2/namespaces');
    const headers = init.headers as Headers;
    expect(headers.get('idempotency-key')).toBe('demo-was:namespace:private');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'demo',
      encryptionPolicy: 'NONE',
      accessPolicy: 'PRIVATE',
    });
  });

  it('고정 UUID가 있으면 private namespace를 생성하지 않고 VFS 요청에 사용한다', async () => {
    const namespaceId = '63f238da-3f8d-482d-a384-7995994271dc';
    const config = {
      port: 4000,
      storixBaseUrl: 'http://storix.test',
      storixApiKey: 'key',
      namespaceName: 'demo',
      namespaceId,
      publicNamespaceName: 'demo-public',
      publicUrlBase: 'http://storix.test',
    };
    const pinned = new StorixClient(new StorixHttpClient(config), config);
    const spy = mockFetchOnce(200, { items: [], nextCursor: null });

    await expect(pinned.ensureDemoNamespace()).resolves.toBe(namespaceId);
    await pinned.list('/');

    expect(spy).toHaveBeenCalledTimes(1);
    const [url] = spy.mock.calls[0] as [URL];
    expect(url.pathname).toBe(`/api/v2/namespaces/${namespaceId}/fs/ls`);

    const publicSpy = mockFetchOnce(201, { id: 'ns-public-id' });
    await expect(pinned.ensurePublicNamespace()).resolves.toBe('ns-public-id');
    const [publicUrl, publicInit] = publicSpy.mock.calls[1] as [URL, RequestInit];
    expect(publicUrl.pathname).toBe('/api/v2/namespaces');
    expect(JSON.parse(publicInit.body as string).accessPolicy).toBe('PUBLIC');
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

  describe('고정 키 receipt가 만료돼 이름 충돌 409가 나는 경우', () => {
    const conflict = { code: 'NAMESPACE_ALREADY_EXISTS', message: '이미 존재함', requestId: 'req-1' };
    const entry = (id: string, name: string, accessPolicy: 'PRIVATE' | 'PUBLIC') => ({
      id,
      name,
      accessPolicy,
    });

    it('이름·accessPolicy가 일치하는 기존 namespace의 id를 쓴다', async () => {
      const spy = mockFetchOnce(409, conflict);
      mockFetchOnce(200, {
        items: [entry('ns-other', 'a', 'PRIVATE'), entry('ns-public-existing', 'demo-public', 'PUBLIC')],
        nextCursor: null,
      });

      await expect(client.ensurePublicNamespace()).resolves.toBe('ns-public-existing');

      const [listUrl, listInit] = spy.mock.calls[1] as [URL, RequestInit];
      expect(listUrl.pathname).toBe('/api/v2/namespaces');
      expect(listUrl.searchParams.get('limit')).toBe('1000');
      expect(listUrl.searchParams.has('cursor')).toBe(false);
      expect(listInit.method).toBe('GET');
    });

    it('PRIVATE namespace도 같은 방식으로 찾는다', async () => {
      mockFetchOnce(409, conflict);
      mockFetchOnce(200, { items: [entry('ns-private-existing', 'demo', 'PRIVATE')], nextCursor: null });

      await expect(client.ensureDemoNamespace()).resolves.toBe('ns-private-existing');
    });

    it('nextCursor를 따라 여러 페이지를 순회하고 찾으면 중단한다', async () => {
      const spy = mockFetchOnce(409, conflict);
      mockFetchOnce(200, { items: [entry('ns-1', 'a', 'PRIVATE')], nextCursor: 'cursor-1' });
      mockFetchOnce(200, { items: [entry('ns-found', 'demo-public', 'PUBLIC')], nextCursor: 'cursor-2' });

      await expect(client.ensurePublicNamespace()).resolves.toBe('ns-found');

      expect(spy).toHaveBeenCalledTimes(3);
      const [secondUrl] = spy.mock.calls[2] as [URL];
      expect(secondUrl.searchParams.get('cursor')).toBe('cursor-1');
    });

    it('이름은 같지만 accessPolicy가 다르면 원래 409를 던진다', async () => {
      mockFetchOnce(409, conflict);
      mockFetchOnce(200, { items: [entry('ns-private', 'demo-public', 'PRIVATE')], nextCursor: null });

      await expect(client.ensurePublicNamespace()).rejects.toMatchObject({
        status: 409,
        code: 'NAMESPACE_ALREADY_EXISTS',
      });
    });

    it('일치하는 항목이 끝까지 없으면 원래 409를 던진다', async () => {
      mockFetchOnce(409, conflict);
      mockFetchOnce(200, { items: [entry('ns-1', 'a', 'PUBLIC')], nextCursor: 'cursor-1' });
      mockFetchOnce(200, { items: [], nextCursor: null });

      await expect(client.ensurePublicNamespace()).rejects.toMatchObject({
        status: 409,
        code: 'NAMESPACE_ALREADY_EXISTS',
      });
    });

    it.each([
      [409, 'IDEMPOTENCY_KEY_REUSED'],
      [500, 'INTERNAL_ERROR'],
    ])('status %i·code %s이면 list를 호출하지 않고 전파한다', async (status, code) => {
      const spy = mockFetchOnce(status, { code, message: '실패', requestId: 'req-2' });

      await expect(client.ensurePublicNamespace()).rejects.toMatchObject({ status, code });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('upstream 401이면 list를 호출하지 않고 502 STORIX_UPSTREAM_UNAUTHORIZED로 전파한다', async () => {
      const spy = mockFetchOnce(401, { code: 'UNAUTHORIZED', message: '실패', requestId: 'req-2' });

      await expect(client.ensurePublicNamespace()).rejects.toMatchObject({
        status: 502,
        code: 'STORIX_UPSTREAM_UNAUTHORIZED',
      });
      expect(spy).toHaveBeenCalledTimes(1);
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
    expect(url.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/ls');
    expect(url.searchParams.get('path')).toBe('/docs');
    expect(url.searchParams.get('cursor')).toBe('cursor-1');
  });

  it('createDirectory는 parents=true로 mkdir를 호출한다', async () => {
    const spy = mockFetchOnce(201, {});
    await client.createDirectory('/docs/new');

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/mkdir');
    expect(JSON.parse(init.body as string)).toEqual({ path: '/docs/new', parents: true });
  });

  it('move는 destinationParents=true로 mv를 호출한다', async () => {
    const spy = mockFetchOnce(200, {});
    await client.move('/a.txt', '/b.txt');

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/mv');
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
    expect(url.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/cp');
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
    expect(url.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/rm');
    expect(url.searchParams.get('path')).toBe('/dir');
    expect(url.searchParams.get('recursive')).toBe('true');
  });

  it('setMimeType은 revision을 읽은 뒤 조건부 mutation을 보낸다', async () => {
    const fetchSpy = mockFetchOnce(200, {
      path: '/a.txt',
      name: 'a.txt',
      type: 'FILE',
      size: 5,
      mimeType: 'text/plain',
      createdAt: '',
      updatedAt: '',
      version: 1,
      revision: 'r1.ABC',
    });
    mockFetchOnce(200, {
      resource: {
        path: '/a.txt',
        name: 'a.txt',
        type: 'FILE',
        size: 5,
        mimeType: 'application/json',
        createdAt: '',
        updatedAt: '',
        version: 2,
      },
      affectedRevisions: [],
    });

    const result = await client.setMimeType('/a.txt', 'application/json');

    expect(result.mimeType).toBe('application/json');
    const [statUrl] = fetchSpy.mock.calls[0] as [URL];
    expect(statUrl.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/stat');
    expect(statUrl.searchParams.get('path')).toBe('/a.txt');
    const [mutationUrl, mutationInit] = fetchSpy.mock.calls[1] as [URL, RequestInit];
    expect(mutationUrl.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/mutations');
    expect((mutationInit.headers as Headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect((mutationInit.headers as Headers).get('x-mutation-scope')).toBe('demo1-was:set-mime-type');
    expect(JSON.parse(mutationInit.body as string)).toEqual({
      kind: 'setMimeType',
      path: '/a.txt',
      ifRevision: 'r1.ABC',
      mimeType: 'application/json',
    });
  });

  it('find는 path/name/cursor 쿼리로 find를 호출한다', async () => {
    const page = { items: [], nextCursor: null };
    const spy = mockFetchOnce(200, page);
    await expect(client.find('/docs', 'report', 'cursor-2')).resolves.toEqual(page);

    const [url] = spy.mock.calls[0] as [URL];
    expect(url.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/find');
    expect(url.searchParams.get('name')).toBe('report');
    expect(url.searchParams.get('cursor')).toBe('cursor-2');
  });

  it('upload는 mimeType/contentLength를 헤더로 싣고 스트리밍 본문을 그대로 전달한다', async () => {
    const entry = {
      path: '/a.txt',
      name: 'a.txt',
      type: 'FILE',
      size: 3,
      mimeType: 'text/plain',
      createdAt: '',
      updatedAt: '',
      version: 1,
    };
    const spy = mockFetchOnce(201, entry);
    const body = new ReadableStream();

    await expect(
      client.upload('/a.txt', body, { mimeType: 'text/plain', contentLength: 3 }),
    ).resolves.toEqual(entry);

    const [url, init] = spy.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/content');
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
    expect(url.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/presigned-download');
    expect(url.searchParams.get('path')).toBe('/a.txt');
  });

  it('publish는 원본을 읽어 유도된 공개 경로로 PUBLIC namespace에 재업로드하고 그 경로를 담은 공개 URL을 반환한다', async () => {
    const bodyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'));
        controller.close();
      },
    });
    const getSpy = jest
      .spyOn(storixTransport, 'fetch')
      .mockResolvedValueOnce(
        transportResponse(
          new Response(bodyStream, { status: 200, headers: { 'content-type': 'text/plain' } }),
        ),
      );
    const putSpy = jest
      .spyOn(storixTransport, 'fetch')
      .mockResolvedValueOnce(transportResponse(new Response(JSON.stringify({}), { status: 201 })));

    const link = await client.publish('/documents/alice/a.txt');
    const expectedPublicPath = derivePublicPath('/documents/alice/a.txt');

    expect(link).toEqual({
      url: `http://public.test/api/v2/public/ns-public-id/fs/download?path=${encodeURIComponent(expectedPublicPath)}`,
      publicPath: expectedPublicPath,
    });

    const [getUrl] = getSpy.mock.calls[0] as [URL];
    expect(getUrl.pathname).toBe('/api/v2/namespaces/ns-private-id/fs/content');

    const [putUrl, putInit] = putSpy.mock.calls[1] as [URL, RequestInit];
    expect(putUrl.pathname).toBe('/api/v2/namespaces/ns-public-id/fs/content');
    expect(putUrl.searchParams.get('path')).toBe(expectedPublicPath);
    expect(putUrl.searchParams.get('force')).toBe('true');
    expect((putInit.headers as Headers).get('content-type')).toBe('text/plain');
  });

  it('unpublish는 같은 internalPath에서 유도한 공개 경로를 PUBLIC namespace에서 삭제한다', async () => {
    const spy = mockFetchOnce(204, undefined);
    await client.unpublish('/documents/alice/a.txt');

    const [url] = spy.mock.calls[0] as [URL];
    expect(url.pathname).toBe('/api/v2/namespaces/ns-public-id/fs/rm');
    expect(url.searchParams.get('path')).toBe(derivePublicPath('/documents/alice/a.txt'));
  });
});

describe('StorixClient — upload sessions', () => {
  let client: StorixClient;

  beforeEach(async () => {
    const config = {
      port: 4000,
      storixBaseUrl: 'http://storix.test',
      storixApiKey: 'key',
      namespaceName: 'demo',
      namespaceId: '63f238da-3f8d-482d-a384-7995994271dc',
      publicNamespaceName: 'demo-public',
      publicUrlBase: 'http://storix.test',
    };
    client = new StorixClient(new StorixHttpClient(config), config);
    await client.ensureDemoNamespace();
  });

  afterEach(() => jest.restoreAllMocks());

  it('create/status/part/complete/cancel을 Storix upload-session URL과 계약 헤더로 호출한다', async () => {
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const base = '/api/v2/namespaces/63f238da-3f8d-482d-a384-7995994271dc/fs/upload-sessions';
    const created = {
      sessionId,
      state: 'OPEN',
      partSizeBytes: 4,
      partCount: 1,
      expiresAt: '',
      maxExpiresAt: '',
    };
    const status = {
      ...created,
      path: '/documents/alice/a.bin',
      sizeBytes: '4',
      mimeType: 'application/octet-stream',
      condition: { ifAbsent: true },
      parts: [],
    };
    const requestBody = {
      path: status.path,
      sizeBytes: '4',
      mimeType: status.mimeType,
      ifAbsent: true,
    } as const;
    const createSpy = mockFetchOnce(201, created);
    await expect(
      client.createUploadSession(requestBody, sessionId, 'demo1-was:upload:alice'),
    ).resolves.toEqual(created);
    const [createUrl, createInit] = createSpy.mock.calls[0] as [URL, RequestInit];
    expect(createUrl.pathname).toBe(base);
    expect(createInit.method).toBe('POST');
    expect((createInit.headers as Headers).get('idempotency-key')).toBe(sessionId);
    expect((createInit.headers as Headers).get('x-mutation-scope')).toBe('demo1-was:upload:alice');
    expect(JSON.parse(createInit.body as string)).toEqual(requestBody);

    const statusSpy = mockFetchOnce(200, status);
    await expect(client.getUploadSession(sessionId)).resolves.toEqual(status);
    expect((statusSpy.mock.calls[1] as [URL])[0].pathname).toBe(`${base}/${sessionId}`);

    const stream = new ReadableStream();
    const partResult = { index: 0, sizeBytes: '4', sha256: 'a'.repeat(64), replayed: false };
    const partSpy = mockFetchOnce(200, partResult);
    await expect(
      client.putUploadSessionPart(sessionId, '0', stream, '4', 'application/octet-stream'),
    ).resolves.toEqual(partResult);
    const [partUrl, partInit] = partSpy.mock.calls[2] as [URL, RequestInit];
    expect(partUrl.pathname).toBe(`${base}/${sessionId}/parts/0`);
    expect(partInit.method).toBe('PUT');
    expect(partInit.body).toBe(stream);
    expect(partInit.duplex).toBe('half');
    expect((partInit.headers as Headers).get('content-length')).toBe('4');
    expect((partInit.headers as Headers).get('content-type')).toBe('application/octet-stream');

    const result = { resource: { path: status.path }, affectedRevisions: [] };
    const completeSpy = mockFetchOnce(201, result);
    await expect(client.completeUploadSession(sessionId)).resolves.toEqual({ status: 201, body: result });
    expect((completeSpy.mock.calls[3] as [URL])[0].pathname).toBe(`${base}/${sessionId}/complete`);

    const cancelSpy = mockFetchOnce(200, { ...status, state: 'CANCELLED' });
    await expect(client.cancelUploadSession(sessionId)).resolves.toMatchObject({ state: 'CANCELLED' });
    const [cancelUrl, cancelInit] = cancelSpy.mock.calls[4] as [URL, RequestInit];
    expect(cancelUrl.pathname).toBe(`${base}/${sessionId}`);
    expect(cancelInit.method).toBe('DELETE');
  });

  it('Storix 실패 응답의 상태와 코드를 보존한다', async () => {
    mockFetchOnce(409, { code: 'VFS_FEATURE_DISABLED', message: 'disabled', requestId: 'req-1' });
    await expect(
      client.createUploadSession(
        {
          path: '/documents/alice/a.bin',
          sizeBytes: '4',
          mimeType: 'application/octet-stream',
          ifAbsent: true,
        },
        '33333333-3333-4333-8333-333333333333',
        'demo1-was:upload:alice',
      ),
    ).rejects.toMatchObject({ status: 409, code: 'VFS_FEATURE_DISABLED' });
  });
});
