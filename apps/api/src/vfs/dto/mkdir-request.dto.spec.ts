import { VfsInvalidPathError } from '../vfs.errors.js';
import { parseMkdirRequest } from './mkdir-request.dto.js';

describe('parseMkdirRequest', () => {
  it('path만 주어지면 parents는 false로 기본값을 가진다', () => {
    expect(parseMkdirRequest({ path: '/a' })).toEqual({ path: '/a', parents: false });
  });

  it('parents:true를 그대로 반영한다', () => {
    expect(parseMkdirRequest({ path: '/a', parents: true })).toEqual({ path: '/a', parents: true });
  });

  it('parents가 boolean이 아니면 false로 취급한다', () => {
    expect(parseMkdirRequest({ path: '/a', parents: 'true' })).toEqual({ path: '/a', parents: false });
  });

  it('path가 없으면 VfsInvalidPathError를 던진다', () => {
    expect(() => parseMkdirRequest({})).toThrow(VfsInvalidPathError);
  });

  it('body가 객체가 아니면 VfsInvalidPathError를 던진다', () => {
    expect(() => parseMkdirRequest(null)).toThrow(VfsInvalidPathError);
  });
});
