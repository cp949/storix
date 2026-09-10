import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, listDocuments } from './client';

describe('listDocuments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('X-Demo-User 헤더와 path 쿼리를 붙여 demo-api를 호출한다', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));

    await listDocuments('alice', '/reports');

    const [input, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(input).toBe('/demo-api/documents?path=%2Freports');
    expect((init.headers as Record<string, string>)['X-Demo-User']).toBe('alice');
  });

  it('응답이 실패하면 ApiError로 status/code/requestId를 담아 던진다', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'DEMO_USER_REQUIRED', message: '헤더 없음', requestId: 'req-1' }), {
        status: 400,
      }),
    );

    const error = await listDocuments('alice', '/').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'DEMO_USER_REQUIRED', requestId: 'req-1' });
  });
});
