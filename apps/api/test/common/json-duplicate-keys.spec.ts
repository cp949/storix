import { assertNoDuplicateJsonKeys } from '../../src/common/json-duplicate-keys.js';

describe('assertNoDuplicateJsonKeys', () => {
  it('중복이 없으면 통과한다', () => {
    expect(() =>
      assertNoDuplicateJsonKeys('{"a":1,"b":{"a":[{"a":1},{"a":2}],"c":"x"},"d":[]}'),
    ).not.toThrow();
  });

  it('값이 스칼라·빈 컨테이너·중첩 배열이어도 통과한다', () => {
    expect(() =>
      assertNoDuplicateJsonKeys('[1,"a",null,true,{},[],[[{"k":1}],[{"k":2}]],{"k":{"k":{"k":0}}}]'),
    ).not.toThrow();
  });

  it('최상위 key 중복을 경로 $로 보고한다', () => {
    expect(() => assertNoDuplicateJsonKeys('{"a":1,"b":2,"a":3}')).toThrow('Duplicate key "a" at $');
  });

  it('중첩 객체의 중복을 상위 key 경로와 함께 보고한다', () => {
    expect(() => assertNoDuplicateJsonKeys('{"outer":{"inner":{"x":1,"x":2}}}')).toThrow(
      'Duplicate key "x" at outer.inner',
    );
  });

  it('배열 안 객체의 중복을 인덱스 경로와 함께 보고한다', () => {
    expect(() => assertNoDuplicateJsonKeys('{"list":[{"x":1},{"y":1,"y":2}]}')).toThrow(
      'Duplicate key "y" at list.1',
    );
  });

  it('이스케이프를 해석해 같아지는 key를 중복으로 본다', () => {
    expect(() => assertNoDuplicateJsonKeys('{"a":1,"\\u0061":2}')).toThrow('Duplicate key "a" at $');
  });

  it('다른 객체에 같은 key가 있는 것은 중복이 아니다', () => {
    expect(() => assertNoDuplicateJsonKeys('{"a":{"x":1},"b":{"x":2},"c":[{"x":3},{"x":4}]}')).not.toThrow();
  });

  it('문자열 값 안의 따옴표·괄호·쉼표는 구조로 보지 않는다', () => {
    expect(() =>
      assertNoDuplicateJsonKeys('{"a":"{\\"a\\":1,\\"a\\":2}","b":"],[}{,\\\\","c":"\\""}'),
    ).not.toThrow();
  });

  it('key 문자열 안의 이스케이프된 따옴표와 역슬래시를 건너뛴다', () => {
    expect(() => assertNoDuplicateJsonKeys('{"a\\"b":1,"a\\\\":2,"a":3}')).not.toThrow();
    expect(() => assertNoDuplicateJsonKeys('{"a\\"b":1,"a\\"b":2}')).toThrow('Duplicate key "a"b" at $');
  });

  it('값 문자열은 key로 취급하지 않는다', () => {
    expect(() => assertNoDuplicateJsonKeys('{"a":"x","b":"x","c":"x"}')).not.toThrow();
  });
});
