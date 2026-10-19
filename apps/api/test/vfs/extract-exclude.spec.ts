// extract exclude glob의 segment 단위 매칭, 조상 제외, 문법 오류, 반복 `**`의 비용을 단위 테스트한다.
// 순수 함수 단위 테스트이며 DB와 저장소를 쓰지 않는다. 규칙은 docs/design/17-file-extract.md "exclude"를 따른다.
import { compileExclude } from '../../src/vfs/extract-exclude.js';
import { VfsExtractInvalidRequestError } from '../../src/vfs/vfs.errors.js';

// 반복 `**`와 다중 `*` 사례는 정규식 backtracking이 있으면 입력 크기에 따라 시간이 폭증한다.
// 그래서 큰 입력을 주고 즉시 끝나는지 확인한다.
describe('compileExclude', () => {
  it('`__MACOSX/**`는 __MACOSX와 그 자손만 맞춘다', () => {
    const match = compileExclude(['__MACOSX/**']);
    expect(match('__MACOSX')).toBe(true);
    expect(match('__MACOSX/._a')).toBe(true);
    expect(match('__MACOSX/a/b')).toBe(true);
    expect(match('x/__MACOSX')).toBe(false);
    expect(match('__MACOSXa')).toBe(false);
  });

  it('`**/.DS_Store`는 root와 깊은 경로의 이름을 맞추고 같은 이름의 DIRECTORY 아래도 맞춘다', () => {
    const match = compileExclude(['**/.DS_Store']);
    expect(match('.DS_Store')).toBe(true);
    expect(match('a/.DS_Store')).toBe(true);
    expect(match('a/b/c/.DS_Store')).toBe(true);
    expect(match('a/.DS_Store/x')).toBe(true);
    expect(match('.DS_Storex')).toBe(false);
    expect(match('a/b')).toBe(false);
  });

  it('`a/*.log`는 a의 직계만 맞추고 더 깊은 a/b/x.log는 맞추지 않는다', () => {
    const match = compileExclude(['a/*.log']);
    expect(match('a/x.log')).toBe(true);
    expect(match('a/.log')).toBe(true);
    expect(match('a/x.log/inner.txt')).toBe(true);
    expect(match('a/b/x.log')).toBe(false);
    expect(match('b/x.log')).toBe(false);
    expect(match('a/x.logs')).toBe(false);
  });

  it('`node_modules`는 root의 해당 subtree만 맞춘다', () => {
    const match = compileExclude(['node_modules']);
    expect(match('node_modules')).toBe(true);
    expect(match('node_modules/pkg/index.js')).toBe(true);
    expect(match('pkg/node_modules')).toBe(false);
  });

  it('`.`·`[x]`·`?`는 리터럴이고 `*`는 한 segment 안에서만 퍼진다', () => {
    expect(compileExclude(['a.b'])('a.b')).toBe(true);
    expect(compileExclude(['a.b'])('aXb')).toBe(false);
    expect(compileExclude(['[x]'])('[x]')).toBe(true);
    expect(compileExclude(['[x]'])('x')).toBe(false);
    expect(compileExclude(['a?'])('a?')).toBe(true);
    expect(compileExclude(['a?'])('ab')).toBe(false);
    const star = compileExclude(['a*c']);
    expect(star('abc')).toBe(true);
    expect(star('ac')).toBe(true);
    expect(star('a/b/c')).toBe(false);
  });

  it('여러 패턴은 하나라도 맞으면 제외한다', () => {
    const match = compileExclude(['__MACOSX/**', '**/Thumbs.db']);
    expect(match('__MACOSX/a')).toBe(true);
    expect(match('img/Thumbs.db')).toBe(true);
    expect(match('img/a.png')).toBe(false);
    expect(compileExclude([])('anything')).toBe(false);
  });

  it('`**` 하나만 있는 패턴은 모든 entry를 맞춘다', () => {
    expect(compileExclude(['**'])('a/b')).toBe(true);
  });

  it('`**`가 완전한 segment가 아니거나 segment가 비면 요청 오류다', () => {
    for (const pattern of ['a**b', '***', '**a', 'a/**b/c', '/a', 'a//b', 'a/']) {
      expect(() => compileExclude([pattern])).toThrow(VfsExtractInvalidRequestError);
    }
  });

  it('반복 `**`와 다중 `*` 패턴이 큰 입력에서도 즉시 끝난다', () => {
    const started = Date.now();
    const deep = compileExclude([`${'**/'.repeat(40)}x`]);
    expect(deep(`${'a/'.repeat(2000)}y`)).toBe(false);
    expect(deep(`${'a/'.repeat(2000)}x`)).toBe(true);
    const stars = compileExclude([`${'*a'.repeat(30)}*b`]);
    expect(stars('a'.repeat(200))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
