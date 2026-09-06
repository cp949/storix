import { joinChildPath, PathResolver } from './path-resolver.js';
import { VfsInvalidPathError } from './vfs.errors.js';

describe('PathResolver', () => {
  const resolver = new PathResolver();

  it('단일 세그먼트 절대 경로를 canonical form으로 반환한다', () => {
    const result = resolver.resolve('/a');

    expect(result).toEqual({ canonical: '/a', segments: ['a'] });
  });

  it('여러 세그먼트로 구성된 절대 경로를 그대로 canonical form으로 반환한다', () => {
    const result = resolver.resolve('/a/b/c');

    expect(result).toEqual({ canonical: '/a/b/c', segments: ['a', 'b', 'c'] });
  });

  it('root 경로는 빈 segments를 가진다', () => {
    const result = resolver.resolve('/');

    expect(result).toEqual({ canonical: '/', segments: [] });
  });

  it('반복된 슬래시를 canonicalize한다', () => {
    const result = resolver.resolve('/a//b');

    expect(result).toEqual({ canonical: '/a/b', segments: ['a', 'b'] });
  });

  it('. 세그먼트를 제거해 canonicalize한다', () => {
    const result = resolver.resolve('/a/./b');

    expect(result).toEqual({ canonical: '/a/b', segments: ['a', 'b'] });
  });

  it('.. 세그먼트가 있으면 항상 거부한다', () => {
    expect(() => resolver.resolve('/a/../b')).toThrow(VfsInvalidPathError);
  });

  it('/로 시작하지 않는 상대 경로는 거부한다', () => {
    expect(() => resolver.resolve('a/b')).toThrow(VfsInvalidPathError);
  });

  it('세그먼트에 \\ 문자가 포함되면 거부한다', () => {
    expect(() => resolver.resolve('/a/b\\c')).toThrow(VfsInvalidPathError);
  });

  it('세그먼트에 NUL 문자가 포함되면 거부한다', () => {
    expect(() => resolver.resolve('/a/b\u0000c')).toThrow(VfsInvalidPathError);
  });

  it('세그먼트에 제어 문자가 포함되면 거부한다', () => {
    expect(() => resolver.resolve('/a/b\u0001c')).toThrow(VfsInvalidPathError);
  });
});

describe('joinChildPath', () => {
  it('root 경로 아래 이름을 붙이면 /name이 된다', () => {
    expect(joinChildPath('/', 'a')).toBe('/a');
  });

  it('root가 아닌 경로 아래 이름을 붙이면 경로/이름이 된다', () => {
    expect(joinChildPath('/a', 'b')).toBe('/a/b');
  });

  it('여러 segment로 구성된 상대 경로도 그대로 이어붙인다', () => {
    expect(joinChildPath('/a', 'b/c')).toBe('/a/b/c');
  });
});
