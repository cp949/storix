import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 코드가 읽지 않고 compose 보간에만 쓰이는 변수. .env.example과 README 표에는
// 있어야 하지만 apps/api/src에는 등장하지 않는다.
const COMPOSE_ONLY_VARS = ['STORIX_PUBLISH_PORT', 'STORIX_VERSITYGW_DATA_PATH', 'STORIX_NGINX_PUBLIC_PORT'];

// 따옴표로 감싼 이름 전체('STORIX_X') 또는 process.env.STORIX_X 만 env 읽기로 본다.
// 에러 메시지 안의 "STORIX_X가 …" 같은 언급은 이름 뒤에 따옴표가 오지 않아 제외된다.
const ENV_READ_PATTERN = /['"`](STORIX_[A-Z0-9_]+)['"`]|process\.env\.(STORIX_[A-Z0-9_]+)/g;

function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('pnpm-workspace.yaml을 찾지 못함 — 저장소 안에서 실행해야 한다');
    }
    dir = parent;
  }
  return dir;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.integration-spec.ts')) {
      files.push(path);
    }
  }
  return files;
}

function envVarsReadByCode(srcDir: string): Set<string> {
  const names = new Set<string>();
  for (const file of listSourceFiles(srcDir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(ENV_READ_PATTERN)) {
      names.add(match[1] ?? match[2]);
    }
  }
  return names;
}

// `STORIX_X=` 또는 주석 처리된 `#STORIX_X=` 를 키로 본다.
function envExampleKeys(path: string): Set<string> {
  const keys = new Set<string>();
  for (const match of readFileSync(path, 'utf8').matchAll(/^#?(STORIX_[A-Z0-9_]+)=/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

// README의 `## 환경변수` 절(다음 `## ` 헤더 전까지) 안의 표 첫 열에서 변수명을 뽑는다.
function readmeEnvTableKeys(path: string): Set<string> {
  const readme = readFileSync(path, 'utf8');
  const start = readme.indexOf('\n## 환경변수');
  if (start < 0) {
    throw new Error('README.md에 "## 환경변수" 절이 없음');
  }
  const rest = readme.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  const section = end < 0 ? rest : rest.slice(0, end);
  const keys = new Set<string>();
  for (const match of section.matchAll(/^\| `(STORIX_[A-Z0-9_]+)`/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

function sortedDiff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((name) => !b.has(name)).sort();
}

describe('환경변수 문서 동기화', () => {
  const repoRoot = findRepoRoot(process.cwd());
  const codeVars = envVarsReadByCode(join(repoRoot, 'apps/api/src'));
  const exampleKeys = envExampleKeys(join(repoRoot, '.env.example'));
  const readmeKeys = readmeEnvTableKeys(join(repoRoot, 'README.md'));

  it('코드가 STORIX_ 변수를 하나 이상 읽는다(스캔 자체가 동작하는지 확인)', () => {
    expect(codeVars.size).toBeGreaterThan(20);
  });

  it('코드가 읽는 STORIX_ 변수는 전부 .env.example에 키로 있다', () => {
    expect(sortedDiff(codeVars, exampleKeys)).toEqual([]);
  });

  it('코드가 읽는 STORIX_ 변수는 전부 README 환경변수 표에 있다', () => {
    expect(sortedDiff(codeVars, readmeKeys)).toEqual([]);
  });

  it('.env.example에만 있는 키는 compose 전용 허용 목록과 일치한다', () => {
    expect(sortedDiff(exampleKeys, codeVars)).toEqual([...COMPOSE_ONLY_VARS].sort());
  });

  it('README 환경변수 표에만 있는 키는 compose 전용 허용 목록과 일치한다', () => {
    expect(sortedDiff(readmeKeys, codeVars)).toEqual([...COMPOSE_ONLY_VARS].sort());
  });
});
