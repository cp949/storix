import {
  assertExpirySeconds,
  parseExpiresInHeader,
  resolveFileExpiryBounds,
} from '../../src/vfs/file-expiry-policy.js';
import { VfsInvalidExpiryError } from '../../src/vfs/vfs.errors.js';

describe('파일 만료 정책', () => {
  const bounds = { minSeconds: 60, maxSeconds: 2592000 };

  it('설정이 없으면 기본 범위 60~2592000초를 쓴다', () => {
    expect(resolveFileExpiryBounds(undefined, undefined)).toEqual(bounds);
    expect(resolveFileExpiryBounds('', '')).toEqual(bounds);
  });

  it.each([
    ['0', undefined],
    ['-1', undefined],
    ['1.5', undefined],
    ['abc', undefined],
    [undefined, '9007199254740993'],
  ])('잘못된 설정 min=%j max=%j는 부팅을 거부한다', (min, max) => {
    expect(() => resolveFileExpiryBounds(min, max)).toThrow();
  });

  it('MIN이 MAX보다 크면 부팅을 거부한다', () => {
    expect(() => resolveFileExpiryBounds('120', '60')).toThrow('STORIX_VFS_EXPIRY_MIN_SECONDS');
  });

  it('PostgreSQL INTEGER 초 상한을 넘는 MAX 설정은 부팅을 거부한다', () => {
    expect(resolveFileExpiryBounds('60', '2147483647')).toEqual({
      minSeconds: 60,
      maxSeconds: 2147483647,
    });
    expect(() => resolveFileExpiryBounds('60', '2147483648')).toThrow('STORIX_VFS_EXPIRY_MAX_SECONDS');
  });

  it('범위 경계값은 허용하고 밖은 VFS_INVALID_EXPIRY다', () => {
    expect(assertExpirySeconds(60, bounds)).toBe(60);
    expect(assertExpirySeconds(2592000, bounds)).toBe(2592000);
    for (const value of [59, 2592001, 60.5, '60', null, Number.NaN]) {
      expect(() => assertExpirySeconds(value, bounds)).toThrow(VfsInvalidExpiryError);
    }
  });

  it.each(['+60', ' 60', '60 ', '60.0', '6e1', '', '0x3c', '060'])(
    '헤더 %j는 10진 정수 표기가 아니므로 거부한다',
    (raw) => {
      expect(() => parseExpiresInHeader(raw, bounds)).toThrow(VfsInvalidExpiryError);
    },
  );

  it('헤더 "600"은 600초다', () => {
    expect(parseExpiresInHeader('600', bounds)).toBe(600);
  });
});
