import { assertStrictMimeType, normalizeMimeType } from '../../src/vfs/mime.js';
import { VfsInvalidMutationRequestError } from '../../src/vfs/vfs.errors.js';

describe('normalizeMimeType', () => {
  it('Content-Type이 없으면 기본 MIME을 반환한다', () => {
    expect(normalizeMimeType(undefined)).toBe('application/octet-stream');
  });

  it('빈 문자열이면 기본 MIME을 반환한다', () => {
    expect(normalizeMimeType('')).toBe('application/octet-stream');
  });

  it('유효한 MIME은 소문자로 정규화해 반환한다', () => {
    expect(normalizeMimeType('IMAGE/PNG')).toBe('image/png');
  });

  it('charset 등 파라미터는 제거한다', () => {
    expect(normalizeMimeType('text/plain; charset=utf-8')).toBe('text/plain');
  });

  it('형식이 유효하지 않으면 기본 MIME으로 대체한다', () => {
    expect(normalizeMimeType('not-a-mime-type')).toBe('application/octet-stream');
  });

  it('파라미터를 뗀 값이 255자이면 그대로 반환한다', () => {
    const mime = `application/${'x'.repeat(243)}`;
    expect(mime).toHaveLength(255);
    expect(normalizeMimeType(mime)).toBe(mime);
  });

  it('파라미터를 뗀 값이 256자이면 기본 MIME으로 대체한다', () => {
    expect(normalizeMimeType(`application/${'x'.repeat(244)}`)).toBe('application/octet-stream');
  });

  it('파라미터가 길어도 뗀 값이 255자 이하이면 통과한다', () => {
    const mime = `application/${'x'.repeat(243)}`;
    expect(normalizeMimeType(`${mime}; charset=${'y'.repeat(300)}`)).toBe(mime);
  });
});

describe('assertStrictMimeType', () => {
  it('유효한 type/subtype은 그대로 통과한다', () => {
    expect(assertStrictMimeType('text/plain')).toBe('text/plain');
  });

  it('대문자 입력은 소문자로 정규화해 반환한다', () => {
    expect(assertStrictMimeType('IMAGE/PNG')).toBe('image/png');
  });

  it('세미콜론 등 파라미터가 있으면 예외를 던진다', () => {
    expect(() => assertStrictMimeType('text/plain; charset=utf-8')).toThrow(VfsInvalidMutationRequestError);
  });

  it.each([undefined, null, 123, {}, [], true])('문자열이 아닌 값 %j는 예외를 던진다', (value) => {
    expect(() => assertStrictMimeType(value)).toThrow(VfsInvalidMutationRequestError);
  });

  it('빈 문자열은 예외를 던진다', () => {
    expect(() => assertStrictMimeType('')).toThrow(VfsInvalidMutationRequestError);
  });

  it('255자를 초과하면 예외를 던진다', () => {
    const tooLong = `${'a'.repeat(250)}/plain`;
    expect(tooLong.length).toBeGreaterThan(255);
    expect(() => assertStrictMimeType(tooLong)).toThrow(VfsInvalidMutationRequestError);
  });

  it.each(['not-a-mime-type', 'text/', '/plain', 'text//plain'])(
    'MIME_PATTERN에 맞지 않는 값 %j는 예외를 던진다',
    (value) => {
      expect(() => assertStrictMimeType(value)).toThrow(VfsInvalidMutationRequestError);
    },
  );
});
