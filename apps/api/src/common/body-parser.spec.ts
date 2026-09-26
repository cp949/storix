import { isMutationJsonRoute, isRawUploadRoute, isSnapshotJsonMutationRoute } from './body-parser.js';

describe('isRawUploadRoute', () => {
  it('conditional raw content route bypasses JSON parsing', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/content/conditional' })).toBe(
      true,
    );
  });
  it('POST .../fs/content 요청이면 true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/content' })).toBe(true);
  });

  it('GET .../fs/content 요청이면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'GET', path: '/api/v2/namespaces/abc/fs/content' })).toBe(false);
  });

  it('PUT .../fs/content 요청이면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'PUT', path: '/api/v2/namespaces/abc/fs/content' })).toBe(false);
  });

  it('POST이지만 다른 경로면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/mkdir' })).toBe(false);
  });

  it('trailing slash가 있어도 true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/content/' })).toBe(true);
  });

  it('경로 대소문자가 섞여 있어도(FS) true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/FS/content' })).toBe(true);
  });

  it('경로 대소문자가 섞여 있어도(CONTENT) true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/CONTENT' })).toBe(true);
  });
});

describe('isMutationJsonRoute', () => {
  it('matches only the new JSON mutation endpoint', () => {
    expect(isMutationJsonRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/mutations' })).toBe(true);
    expect(isMutationJsonRoute({ method: 'POST', path: '/api/v2/namespaces/abc/fs/mkdir' })).toBe(false);
    expect(isMutationJsonRoute({ method: 'GET', path: '/api/v2/namespaces/abc/fs/mutations' })).toBe(false);
  });
});

describe('snapshot JSON mutation routes', () => {
  const base = '/api/v2/namespaces/abc/fs/snapshots';
  const id = '550e8400-e29b-41d4-a716-446655440000';
  it.each(['', `/${id}/restore`, `/${id}/delete`])('raw JSON을 보존한다: %s', (suffix) => {
    expect(isSnapshotJsonMutationRoute({ method: 'POST', path: base + suffix })).toBe(true);
    expect(isSnapshotJsonMutationRoute({ method: 'post', path: (base + suffix).toUpperCase() + '/' })).toBe(
      true,
    );
  });
  it.each(['/invalid-id/restore', '/invalid-id/delete'])('%s도 raw JSON으로 읽는다', (suffix) => {
    expect(isSnapshotJsonMutationRoute({ method: 'POST', path: base + suffix })).toBe(true);
  });
  it.each(['GET', 'PUT', 'DELETE'])('다른 method는 매칭하지 않는다: %s', (method) => {
    expect(isSnapshotJsonMutationRoute({ method, path: base })).toBe(false);
  });
  it.each(['/content', '/entries', `/${id}`, `/${id}/delete/extra`, 'extra'])(
    '다른 경로는 매칭하지 않는다: %s',
    (suffix) => {
      expect(isSnapshotJsonMutationRoute({ method: 'POST', path: base + suffix })).toBe(false);
    },
  );
});
