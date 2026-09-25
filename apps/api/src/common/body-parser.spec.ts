import { isMutationJsonRoute, isRawUploadRoute } from './body-parser.js';

describe('isRawUploadRoute', () => {
  it('conditional raw content route bypasses JSON parsing', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v1/namespaces/abc/fs/content/conditional' })).toBe(
      true,
    );
  });
  it('POST .../fs/content 요청이면 true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v1/namespaces/abc/fs/content' })).toBe(true);
  });

  it('GET .../fs/content 요청이면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'GET', path: '/api/v1/namespaces/abc/fs/content' })).toBe(false);
  });

  it('PUT .../fs/content 요청이면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'PUT', path: '/api/v1/namespaces/abc/fs/content' })).toBe(false);
  });

  it('POST이지만 다른 경로면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v1/namespaces/abc/fs/mkdir' })).toBe(false);
  });

  it('trailing slash가 있어도 true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v1/namespaces/abc/fs/content/' })).toBe(true);
  });

  it('경로 대소문자가 섞여 있어도(FS) true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v1/namespaces/abc/FS/content' })).toBe(true);
  });

  it('경로 대소문자가 섞여 있어도(CONTENT) true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'POST', path: '/api/v1/namespaces/abc/fs/CONTENT' })).toBe(true);
  });
});

describe('isMutationJsonRoute', () => {
  it('matches only the new JSON mutation endpoint', () => {
    expect(isMutationJsonRoute({ method: 'POST', path: '/api/v1/namespaces/abc/fs/mutations' })).toBe(true);
    expect(isMutationJsonRoute({ method: 'POST', path: '/api/v1/namespaces/abc/fs/mkdir' })).toBe(false);
    expect(isMutationJsonRoute({ method: 'GET', path: '/api/v1/namespaces/abc/fs/mutations' })).toBe(false);
  });
});
