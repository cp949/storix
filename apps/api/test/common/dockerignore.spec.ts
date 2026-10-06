import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('저장소 루트를 찾을 수 없다');
    dir = parent;
  }
  return dir;
}

// 선행 `/`와 후행 `/`는 gitignore에서만 의미가 있고 dockerignore는 항상 루트 기준이라 같은 경로로 비교한다.
function patterns(file: string): string[] {
  return readFileSync(join(repoRoot(), file), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.replace(/^\//, '').replace(/\/$/, ''));
}

// 빌드 컨텍스트에서 빼지 않아도 되는 gitignore 항목이다. 크기가 작고 비밀이 없다.
const NOT_NEEDED_IN_DOCKERIGNORE = new Set(['*.tsbuildinfo']);

describe('.dockerignore', () => {
  it('.gitignore의 로컬 산출물을 모두 빌드 컨텍스트에서 제외한다', () => {
    const ignoredByDocker = new Set(patterns('.dockerignore'));
    const missing = patterns('.gitignore').filter(
      (pattern) => !NOT_NEEDED_IN_DOCKERIGNORE.has(pattern) && !ignoredByDocker.has(pattern),
    );
    // 빌드 컨텍스트가 `COPY . .`로 이미지 빌드 단계에 복사되므로 개인키·백업·측정 산출물이 새면 안 된다.
    expect(missing).toEqual([]);
  });
});
