import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

// 코드가 읽지 않고 compose 보간에만 쓰이는 변수. .env.example과 README 표에는
// 있어야 하지만 apps/api/src에는 등장하지 않는다.
const COMPOSE_ONLY_VARS = [
  'STORIX_NGINX_PUBLIC_PORT',
  'STORIX_PUBLISH_HOST',
  'STORIX_PUBLISH_PORT',
  'STORIX_SCENARIO_SECRETS_DIR',
  'STORIX_SCENARIO_VERSITYGW_PORT',
  'STORIX_VERSITYGW_DATA_PATH',
];

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

type ComposeService = 'app' | 'migrate' | 'gc' | 'backup' | 'restore';

// README 변수표 "읽는 곳" 값이 가리키는 compose 서비스. README의 범례(`모두`, `app·잡`, `app·gc`)와 같다.
// `compose`(코드가 읽지 않는 보간 값)는 컨테이너 전달 대상이 아니라서 없다.
const SERVICES_BY_READER: Record<string, ComposeService[]> = {
  모두: ['app', 'migrate', 'gc', 'backup', 'restore'],
  'app·잡': ['app', 'gc', 'backup', 'restore'],
  'app·gc': ['app', 'gc'],
  app: ['app'],
  gc: ['gc'],
  backup: ['backup'],
  restore: ['restore'],
  compose: [],
};

interface ReadmeEnvRow {
  name: string;
  reader: string;
}

interface UnforwardedAllowance {
  variable: string;
  services: ComposeService[];
  /** 전달하지 않는 이유. 의도라면 근거 문서, 미결이면 후속 issue 번호다. */
  reason: string;
}

// README가 읽는다고 적었지만 compose가 전달하지 않는 변수의 허용 목록이다.
// 항목은 이유를 함께 적고, 전달하게 되면 이 목록에서 지운다(낡은 항목은 아래 테스트가 잡는다).
const UNFORWARDED_ALLOWANCES: UnforwardedAllowance[] = [
  {
    variable: 'STORIX_SECRET_ADAPTERS',
    services: ['app', 'migrate', 'gc', 'backup', 'restore'],
    reason:
      '의도: 기본 compose는 통신형 비밀값 설정을 넘기지 않는다. docs/design/15-secret-sources.md "compose 전달 범위"',
  },
  {
    variable: 'STORIX_SECRET_RESOLVE_TIMEOUT_MS',
    services: ['app', 'migrate', 'gc', 'backup', 'restore'],
    reason:
      '의도: 기본 compose는 통신형 비밀값 설정을 넘기지 않는다. docs/design/15-secret-sources.md "compose 전달 범위"',
  },
  {
    variable: 'STORIX_VFS_CAPABILITIES_CONFIG_PATH',
    services: ['app'],
    reason:
      '의도: 컨테이너 안 파일 경로라 기본 compose는 넘기지 않는다. override에서 경로와 volume을 함께 지정한다. README 환경변수 절',
  },
  {
    variable: 'STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH',
    services: ['app'],
    reason:
      '의도: 컨테이너 안 파일 경로라 기본 compose는 넘기지 않는다. override에서 경로와 volume을 함께 지정한다. README 환경변수 절',
  },
];

// README `## 환경변수` 절 표의 행에서 변수명과 "읽는 곳"(4번째 열)을 뽑는다.
function readmeEnvRows(readme: string): ReadmeEnvRow[] {
  const start = readme.indexOf('\n## 환경변수');
  if (start < 0) {
    throw new Error('README.md에 "## 환경변수" 절이 없음');
  }
  const rest = readme.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  const section = end < 0 ? rest : rest.slice(0, end);
  const rows: ReadmeEnvRow[] = [];
  for (const line of section.split('\n')) {
    const name = /^\| `(STORIX_[A-Z0-9_]+)`/.exec(line)?.[1];
    if (name === undefined) continue;
    rows.push({ name, reader: line.split('|')[4]?.trim() ?? '' });
  }
  return rows;
}

// compose 파일의 서비스별 `environment` 키 집합. YAML 앵커·merge key(`<<`)를 펼쳐서 읽는다.
function composeEnvKeys(composeText: string): Record<string, Set<string>> {
  const parsed = parse(composeText, { merge: true }) as {
    services: Record<string, { environment?: Record<string, unknown> }>;
  };
  return Object.fromEntries(
    Object.entries(parsed.services).map(([service, definition]) => [
      service,
      new Set(Object.keys(definition.environment ?? {})),
    ]),
  );
}

// README가 서비스가 읽는다고 적었는데 compose `environment`에 없는 `서비스:변수`를 허용 목록을 빼고 돌려준다.
// 허용 목록이 낡은 항목(README가 요구하지 않거나 이미 전달 중)은 `stale`로 돌려준다.
function findComposeForwardingGaps(
  rows: ReadmeEnvRow[],
  composeEnv: Record<string, Set<string>>,
  allowances: UnforwardedAllowance[],
): { missing: string[]; stale: string[]; unknownReaders: string[] } {
  const required = new Set<string>();
  const unknownReaders = new Set<string>();
  for (const { name, reader } of rows) {
    const services = SERVICES_BY_READER[reader];
    if (services === undefined) {
      unknownReaders.add(reader);
      continue;
    }
    for (const service of services) {
      required.add(`${service}:${name}`);
    }
  }
  const allowed = new Set(allowances.flatMap((a) => a.services.map((service) => `${service}:${a.variable}`)));
  const forwarded = (key: string): boolean => {
    const [service, name] = key.split(':');
    return composeEnv[service]?.has(name) ?? false;
  };

  const missing = [...required].filter((key) => !forwarded(key) && !allowed.has(key)).sort();
  const stale = [...allowed].filter((key) => !required.has(key) || forwarded(key)).sort();
  return { missing, stale, unknownReaders: [...unknownReaders].sort() };
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

  it('capability 설정 파일 경로는 코드와 두 환경 문서에 함께 있다', () => {
    const name = 'STORIX_VFS_CAPABILITIES_CONFIG_PATH';
    expect(codeVars.has(name)).toBe(true);
    expect(exampleKeys.has(name)).toBe(true);
    expect(readmeKeys.has(name)).toBe(true);
  });

  it('upload session 설정 파일 경로는 코드와 두 환경 문서에 함께 있다', () => {
    const name = 'STORIX_VFS_UPLOAD_SESSIONS_CONFIG_PATH';
    expect(codeVars.has(name)).toBe(true);
    expect(exampleKeys.has(name)).toBe(true);
    expect(readmeKeys.has(name)).toBe(true);
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const example = readFileSync(join(repoRoot, '.env.example'), 'utf8');
    for (const field of [
      'maxStagedBytes',
      'maxActiveSessions',
      'partSizeBytes',
      'inactivitySeconds',
      'maxLifetimeSeconds',
    ]) {
      expect(readme).toContain(field);
      expect(example).toContain(field);
    }
    expect(readme).toContain('resumable-upload');
    expect(example).toContain('resumable-upload');
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

describe('compose 전달 범위 검사 함수', () => {
  const rows: ReadmeEnvRow[] = [
    { name: 'STORIX_A', reader: 'gc' },
    { name: 'STORIX_B', reader: 'app·잡' },
    { name: 'STORIX_C', reader: 'compose' },
  ];
  const noneAllowed: UnforwardedAllowance[] = [];

  it('README가 gc에서 읽는다고 적은 변수가 gc environment에 없으면 누락으로 잡는다', () => {
    const composeEnv = {
      app: new Set(['STORIX_B']),
      gc: new Set(['STORIX_B']),
      backup: new Set(['STORIX_B']),
      restore: new Set(['STORIX_B']),
    };

    expect(findComposeForwardingGaps(rows, composeEnv, noneAllowed).missing).toEqual(['gc:STORIX_A']);
  });

  it('app·잡은 app·gc·backup·restore 모두에서 요구한다', () => {
    const composeEnv = {
      app: new Set(['STORIX_B']),
      gc: new Set(['STORIX_A']),
      backup: new Set<string>(),
      restore: new Set<string>(),
    };

    expect(findComposeForwardingGaps(rows, composeEnv, noneAllowed).missing).toEqual([
      'backup:STORIX_B',
      'gc:STORIX_B',
      'restore:STORIX_B',
    ]);
  });

  it('compose 전용 변수는 요구하지 않는다', () => {
    const composeEnv = {
      app: new Set(['STORIX_B']),
      gc: new Set(['STORIX_A', 'STORIX_B']),
      backup: new Set(['STORIX_B']),
      restore: new Set(['STORIX_B']),
    };

    expect(findComposeForwardingGaps(rows, composeEnv, noneAllowed)).toEqual({
      missing: [],
      stale: [],
      unknownReaders: [],
    });
  });

  it('등록하지 않은 읽는 곳 값은 누락 없이 통과시키지 않는다', () => {
    expect(
      findComposeForwardingGaps([{ name: 'STORIX_A', reader: '미등록' }], {}, noneAllowed).unknownReaders,
    ).toEqual(['미등록']);
  });

  it('허용 목록에 있는 서비스·변수는 누락으로 보지 않는다', () => {
    const composeEnv = {
      app: new Set(['STORIX_B']),
      gc: new Set(['STORIX_B']),
      backup: new Set(['STORIX_B']),
      restore: new Set(['STORIX_B']),
    };
    const allowances = [{ variable: 'STORIX_A', services: ['gc' as const], reason: '테스트' }];

    expect(findComposeForwardingGaps(rows, composeEnv, allowances)).toEqual({
      missing: [],
      stale: [],
      unknownReaders: [],
    });
  });

  it('이미 전달 중이거나 README가 요구하지 않는 허용 항목은 낡은 항목으로 잡는다', () => {
    const composeEnv = {
      app: new Set(['STORIX_B']),
      gc: new Set(['STORIX_A', 'STORIX_B']),
      backup: new Set(['STORIX_B']),
      restore: new Set(['STORIX_B']),
    };
    const allowances = [
      { variable: 'STORIX_A', services: ['gc' as const], reason: '이미 전달 중' },
      { variable: 'STORIX_A', services: ['app' as const], reason: 'README가 app에서 읽는다고 적지 않음' },
    ];

    expect(findComposeForwardingGaps(rows, composeEnv, allowances).stale).toEqual([
      'app:STORIX_A',
      'gc:STORIX_A',
    ]);
    expect(findComposeForwardingGaps(rows, composeEnv, allowances).unknownReaders).toEqual([]);
  });

  it('YAML 앵커와 merge key를 펼쳐서 서비스별 environment 키를 읽는다', () => {
    const compose = [
      'x-shared: &shared',
      '  STORIX_SHARED: a',
      'services:',
      '  gc:',
      '    environment:',
      '      <<: [*shared]',
      '      STORIX_OWN: b',
      '  migrate: {}',
    ].join('\n');

    const keys = composeEnvKeys(compose);

    expect([...keys.gc].sort()).toEqual(['STORIX_OWN', 'STORIX_SHARED']);
    expect([...keys.migrate]).toEqual([]);
  });
});

// README 변수표의 "읽는 곳"이 가리키는 서비스의 compose `environment`에 변수가 없으면 `.env`에 적은 값이
// 컨테이너에 도달하지 않고 코드 기본값으로 동작한다. GitHub 이슈 #15.
describe('compose 전달 범위', () => {
  const repoRoot = findRepoRoot(process.cwd());
  const rows = readmeEnvRows(readFileSync(join(repoRoot, 'README.md'), 'utf8'));
  const composeEnv = composeEnvKeys(readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8'));
  const gaps = findComposeForwardingGaps(rows, composeEnv, UNFORWARDED_ALLOWANCES);

  it('README 표를 읽어 행을 하나 이상 얻는다(파싱 자체가 동작하는지 확인)', () => {
    expect(rows.length).toBeGreaterThan(40);
    expect(Object.keys(composeEnv)).toEqual(
      expect.arrayContaining(['app', 'migrate', 'gc', 'backup', 'restore']),
    );
  });

  it('README가 서비스가 읽는다고 적은 변수는 허용 목록을 뺀 전부가 compose environment에 있다', () => {
    expect(gaps.missing).toEqual([]);
  });

  it('허용 목록에는 낡은 항목이 없다', () => {
    expect(gaps.stale).toEqual([]);
  });

  it('읽는 곳 열에 등록하지 않은 값이 없다', () => {
    expect(gaps.unknownReaders).toEqual([]);
  });
});
