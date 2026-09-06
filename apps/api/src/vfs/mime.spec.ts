import { normalizeMimeType } from './mime.js';

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
});
