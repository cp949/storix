// extract exclude glob을 컴파일한다. 정규식을 쓰지 않아 반복 `**`와 다중 `*`에서 backtracking이 없다.
// 문법과 매칭 규칙은 docs/design/17-file-extract.md "exclude"를 따른다.
import { VfsExtractInvalidRequestError } from './vfs.errors.js';

const GLOBSTAR = '**';

/**
 * 패턴 하나를 segment 목록으로 나눈다.
 *
 * 문법 규칙:
 * - segment는 `/`로 나눈다. 빈 segment는 거부한다.
 * - `**`는 완전한 segment일 때만 허용한다. `a**b`와 `***`는 거부한다.
 * - 연속한 `**`는 하나로 합친다. 의미가 같고 매칭 비용이 준다.
 * - `*`는 한 segment 안의 임의 문자열이다. `.`·`[`·`?`는 리터럴이다.
 */
function parsePattern(pattern: string): string[] {
  const segments: string[] = [];
  for (const segment of pattern.split('/')) {
    if (segment.length === 0) throw new VfsExtractInvalidRequestError();
    if (segment.includes(GLOBSTAR) && segment !== GLOBSTAR) throw new VfsExtractInvalidRequestError();
    if (segment === GLOBSTAR && segments.at(-1) === GLOBSTAR) continue;
    segments.push(segment);
  }
  return segments;
}

/**
 * `*`만 와일드카드로 보는 segment 하나의 일치 여부를 돌려준다.
 * 마지막 `*` 위치만 기억하는 두 포인터 방식이라 최악에도 O(길이 곱)이고 재귀와 정규식이 없다.
 */
function matchSegment(pattern: string, text: string): boolean {
  if (!pattern.includes('*')) return pattern === text;
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      resume = t;
      p += 1;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** 상태 `index`에서 `**`가 비어 있을 수 있으므로 뒤 상태까지 활성화한다. */
function closeOverGlobstar(pattern: readonly string[], active: Set<number>): void {
  for (const state of [...active]) {
    for (let next = state; next < pattern.length && pattern[next] === GLOBSTAR; next += 1)
      active.add(next + 1);
  }
}

/**
 * 이름 앞부분(조상)이 패턴 하나를 모두 소비하면 맞는 것으로 본다.
 * 이름 segment마다 활성 상태 집합을 갱신하는 시뮬레이션이라 backtracking이 없다.
 * 디렉터리 entry가 archive에 없어도 조상 제외가 적용된다.
 */
function matchesPrefix(pattern: readonly string[], segments: readonly string[]): boolean {
  const accept = pattern.length;
  let active = new Set<number>([0]);
  closeOverGlobstar(pattern, active);
  for (const segment of segments) {
    const next = new Set<number>();
    for (const state of active) {
      if (state >= accept) continue;
      if (pattern[state] === GLOBSTAR) next.add(state);
      else if (matchSegment(pattern[state], segment)) next.add(state + 1);
    }
    closeOverGlobstar(pattern, next);
    if (next.has(accept)) return true;
    if (next.size === 0) return false;
    active = next;
  }
  return false;
}

/**
 * exclude 패턴을 컴파일해 상대 entry 이름이 제외 대상인지 판정하는 함수를 돌려준다.
 * 이름은 이름 검증을 마친 `/` 구분 상대 경로이고 선행 `./`와 끝 `/`가 없다.
 * 문법 오류는 `VFS_INVALID_EXTRACT_REQUEST`로 던진다.
 */
export function compileExclude(patterns: readonly string[]): (name: string) => boolean {
  const compiled = patterns.map(parsePattern);
  if (compiled.length === 0) return () => false;
  return (name) => {
    const segments = name.split('/');
    return compiled.some((pattern) => matchesPrefix(pattern, segments));
  };
}
