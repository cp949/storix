import { VfsInvalidPathError } from '../vfs.errors.js';
import { parseMoveRequest } from './move-request.dto.js';

describe('parseMoveRequest', () => {
  it('source/destination만 주어지면 destinationParents는 false로 기본값을 가진다', () => {
    expect(parseMoveRequest({ source: '/a', destination: '/b' })).toEqual({
      source: '/a',
      destination: '/b',
      destinationParents: false,
    });
  });

  it('destinationParents:true를 그대로 반영한다', () => {
    expect(parseMoveRequest({ source: '/a', destination: '/b', destinationParents: true })).toEqual({
      source: '/a',
      destination: '/b',
      destinationParents: true,
    });
  });

  it('destinationParents가 boolean이 아니면 false로 취급한다', () => {
    expect(
      parseMoveRequest({ source: '/a', destination: '/b', destinationParents: 'true' }),
    ).toEqual({ source: '/a', destination: '/b', destinationParents: false });
  });

  it('source가 없으면 VfsInvalidPathError를 던진다', () => {
    expect(() => parseMoveRequest({ destination: '/b' })).toThrow(VfsInvalidPathError);
  });

  it('destination이 없으면 VfsInvalidPathError를 던진다', () => {
    expect(() => parseMoveRequest({ source: '/a' })).toThrow(VfsInvalidPathError);
  });

  it('body가 객체가 아니면 VfsInvalidPathError를 던진다', () => {
    expect(() => parseMoveRequest(null)).toThrow(VfsInvalidPathError);
  });
});
