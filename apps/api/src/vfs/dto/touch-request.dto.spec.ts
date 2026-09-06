import { VfsInvalidPathError } from '../vfs.errors.js';
import { parseTouchRequest } from './touch-request.dto.js';

describe('parseTouchRequest', () => {
  it('path와 parents를 파싱한다', () => {
    expect(parseTouchRequest({ path: '/a.txt', parents: true })).toEqual({ path: '/a.txt', parents: true });
  });

  it('parents가 없으면 false로 기본값을 채운다', () => {
    expect(parseTouchRequest({ path: '/a.txt' })).toEqual({ path: '/a.txt', parents: false });
  });

  it('path가 문자열이 아니면 VfsInvalidPathError를 던진다', () => {
    expect(() => parseTouchRequest({})).toThrow(VfsInvalidPathError);
  });

  it('body가 객체가 아니면 VfsInvalidPathError를 던진다', () => {
    expect(() => parseTouchRequest(null)).toThrow(VfsInvalidPathError);
  });
});
