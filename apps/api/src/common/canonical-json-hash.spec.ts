import { canonicalJsonHash } from './canonical-json-hash.js';

describe('canonicalJsonHash', () => {
  it('64자 hex 문자열을 반환한다', () => {
    const hash = canonicalJsonHash({ name: 'acme' });

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('키 순서가 달라도 내용이 같으면 같은 해시를 반환한다', () => {
    const first = canonicalJsonHash({ a: 1, b: 2 });
    const second = canonicalJsonHash({ b: 2, a: 1 });

    expect(first).toBe(second);
  });

  it('중첩 객체도 키 순서와 무관하게 같은 해시를 반환한다', () => {
    const first = canonicalJsonHash({ outer: { z: 1, a: 2 } });
    const second = canonicalJsonHash({ outer: { a: 2, z: 1 } });

    expect(first).toBe(second);
  });

  it('내용이 다르면 다른 해시를 반환한다', () => {
    const first = canonicalJsonHash({ name: 'acme' });
    const second = canonicalJsonHash({ name: 'other' });

    expect(first).not.toBe(second);
  });

  it('배열의 순서는 내용으로 취급해 순서가 바뀌면 다른 해시를 반환한다', () => {
    const first = canonicalJsonHash({ tags: ['a', 'b'] });
    const second = canonicalJsonHash({ tags: ['b', 'a'] });

    expect(first).not.toBe(second);
  });
});
