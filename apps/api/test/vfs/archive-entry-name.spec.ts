// 실제 문자열로 ZIP 경로·Unicode·UTF-8 길이와 FILE 조상 충돌을 검증한다.
import { validateArchiveEntryName, validateArchiveEntryNames } from '../../src/vfs/archive-entry-name.js';

// 입력과 호출 순서를 고정해 허용·거부 계약을 재현한다.
describe('ZIP entry 이름 검증', () => {
  it('유효한 NFC 상대 경로를 보존한다', () => {
    expect(validateArchiveEntryName('사진/a.jpg')).toBe('사진/a.jpg');
  });

  it.each(['', '/a', '../a', 'a/../b', 'a//b', 'a/', 'C:/a', 'a\\b', 'a/./b'])(
    '위험한 경로 %p를 거부한다',
    (name) => {
      expect(() => validateArchiveEntryName(name)).toThrow();
    },
  );

  it('상대 경로 4095 bytes와 segment 255 bytes를 허용한다', () => {
    expect(() => validateArchiveEntryName(`${'a'.repeat(255)}/${'b'.repeat(255)}`)).not.toThrow();
    const maxName = Array.from({ length: 16 }, () => 'a'.repeat(255)).join('/');
    expect(Buffer.byteLength(maxName)).toBe(4095);
    expect(() => validateArchiveEntryName(maxName)).not.toThrow();
  });

  it('길이·NFC·Bidi·FILE prefix 충돌을 거부한다', () => {
    expect(() => validateArchiveEntryName('a'.repeat(4096))).toThrow();
    expect(() => validateArchiveEntryName(`${'a'.repeat(256)}/b`)).toThrow();
    expect(() => validateArchiveEntryName('e\u0301')).toThrow();
    expect(() => validateArchiveEntryName('a/\u202eb')).toThrow();
    expect(() => validateArchiveEntryNames(['a/b', 'a/b/c'])).toThrow();
    expect(() => validateArchiveEntryNames(['a/b/c', 'a/b'])).toThrow();
  });

  it.each([
    ['a', 'a'],
    ['a', 'a-b', 'a/b'],
    ['a/b', 'a-b', 'a'],
  ])('다른 이름이 사이에 있어도 중복·FILE 조상 충돌 %j를 거부한다', (...names) => {
    expect(() => validateArchiveEntryNames(names)).toThrow();
  });

  it('공통 directory와 비슷한 FILE 이름은 충돌로 취급하지 않는다', () => {
    expect(() => validateArchiveEntryNames(['a/b', 'a-b', 'a/c', 'a/bb/c'])).not.toThrow();
  });

  it('유효한 supplementary Unicode 문자는 허용하고 lone surrogate는 거부한다', () => {
    expect(() => validateArchiveEntryName('사진/😀.jpg')).not.toThrow();
    expect(() => validateArchiveEntryName(`a\ud800b`)).toThrow();
  });
});
