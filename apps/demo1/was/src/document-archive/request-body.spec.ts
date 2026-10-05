import { InvalidRequestBodyError } from './document-archive.errors.js';
import { requireStringFields } from './request-body.js';

describe('requireStringFields', () => {
  it('문자열 필드를 꺼낸다', () => {
    expect(requireStringFields({ source: '/a', destination: '/b' }, ['source', 'destination'])).toEqual({
      source: '/a',
      destination: '/b',
    });
  });

  it('빈 문자열은 사용자 root를 뜻하므로 허용한다', () => {
    expect(requireStringFields({ path: '' }, ['path'])).toEqual({ path: '' });
  });

  it.each([
    ['배열', { path: ['x'] }],
    ['숫자', { path: 1 }],
    ['객체', { path: {} }],
    ['null', { path: null }],
    ['누락', {}],
  ])('필드 값이 %s이면 InvalidRequestBodyError다', (_label, body) => {
    expect(() => requireStringFields(body, ['path'])).toThrow(InvalidRequestBodyError);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['문자열', 'path'],
    ['배열', ['path']],
  ])('본문이 %s이면 InvalidRequestBodyError다', (_label, body) => {
    expect(() => requireStringFields(body, ['path'])).toThrow(InvalidRequestBodyError);
  });

  it('오류 message에는 필드 이름만 싣고 입력 값은 싣지 않는다', () => {
    expect.assertions(2);
    try {
      requireStringFields({ source: 'secret-value', destination: 5 }, ['source', 'destination']);
    } catch (error) {
      expect((error as Error).message).toContain('destination');
      expect((error as Error).message).not.toContain('secret-value');
    }
  });
});
