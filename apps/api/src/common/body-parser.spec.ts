import { isRawUploadRoute } from './body-parser.js';

describe('isRawUploadRoute', () => {
  it('PUT .../fs/content 요청이면 true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'PUT', path: '/api/v1/namespaces/abc/fs/content' })).toBe(true);
  });

  it('GET .../fs/content 요청이면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'GET', path: '/api/v1/namespaces/abc/fs/content' })).toBe(false);
  });

  it('PUT이지만 다른 경로면 false를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'PUT', path: '/api/v1/namespaces/abc/fs/mkdir' })).toBe(false);
  });

  it('trailing slash가 있어도 true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'PUT', path: '/api/v1/namespaces/abc/fs/content/' })).toBe(true);
  });

  it('경로 대소문자가 섞여 있어도(FS) true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'PUT', path: '/api/v1/namespaces/abc/FS/content' })).toBe(true);
  });

  it('경로 대소문자가 섞여 있어도(CONTENT) true를 반환한다', () => {
    expect(isRawUploadRoute({ method: 'PUT', path: '/api/v1/namespaces/abc/fs/CONTENT' })).toBe(true);
  });
});
