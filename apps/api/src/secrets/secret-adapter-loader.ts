/**
 * `STORIX_SECRET_ADAPTERS`에 지정한 통신형 비밀값 어댑터 모듈을 불러온다.
 * - 지정자는 bare 패키지 이름만 허용한다. 경로·URL·`node:` 접두 형식·하위 경로는 거부한다.
 * - `fs` 같은 bare 내장 모듈 이름은 형식상 통과한다. 이 경우 `invalid-export`로 실패한다.
 * - 지정자는 이 파일 위치(`apps/api`)의 node_modules에서 해석된다.
 * - 오류 메시지에는 지정자와 실패 종류만 쓴다. import 오류 메시지는 옮기지 않는다.
 * 위협 모델은 docs/design/15-secret-sources.md "어댑터 로더"에 있다.
 */
import { FILE_SOURCE_NAME, SECRET_SCHEME_PATTERN, type SecretSource } from './secret-source.js';

/** 모듈을 불러오는 함수다. 테스트가 가짜 모듈을 주입한다. */
export type ImportModule = (specifier: string) => Promise<unknown>;

/** 어댑터 로드 실패 종류다. */
export type AdapterLoadFailureKind =
  | 'invalid-specifier'
  | 'not-found'
  | 'import-failed'
  | 'invalid-export'
  | 'reserved-scheme'
  | 'duplicate-scheme';

/** 지정자 하나의 로드 실패다. */
export interface AdapterLoadFailure {
  /** `STORIX_SECRET_ADAPTERS`의 항목이다. */
  readonly specifier: string;

  /** 실패 종류다. */
  readonly kind: AdapterLoadFailureKind;
}

/** 로드에 실패한 지정자를 모두 담은 오류다. */
export class SecretAdapterLoadError extends Error {
  constructor(readonly failures: readonly AdapterLoadFailure[]) {
    super(`비밀값 어댑터 로드 실패: ${failures.map((f) => `${f.specifier}: ${f.kind}`).join(', ')}`);
    this.name = 'SecretAdapterLoadError';
  }
}

const BARE_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
// Node ESM은 ERR_MODULE_NOT_FOUND, Jest 런타임은 MODULE_NOT_FOUND를 쓴다.
const NOT_FOUND_CODES = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);

const defaultImportModule: ImportModule = (specifier) => import(specifier);

/** 쉼표로 구분한 지정자 목록을 나눈다. 공백과 빈 항목은 버린다. */
export function parseAdapterSpecifiers(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier.length > 0);
}

function isSecretSource(value: unknown): value is SecretSource {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { scheme?: unknown; resolve?: unknown };
  return (
    typeof candidate.scheme === 'string' &&
    SECRET_SCHEME_PATTERN.test(candidate.scheme) &&
    typeof candidate.resolve === 'function'
  );
}

/** 지정자마다 모듈을 불러와 기본 export를 검증한다. 실패가 있으면 모두 모아 `SecretAdapterLoadError`를 던진다. */
export async function loadSecretAdapters(
  specifiers: readonly string[],
  importModule: ImportModule = defaultImportModule,
): Promise<SecretSource[]> {
  const failures: AdapterLoadFailure[] = [];
  const sources: SecretSource[] = [];
  for (const specifier of specifiers) {
    if (!BARE_PACKAGE_PATTERN.test(specifier)) {
      failures.push({ specifier, kind: 'invalid-specifier' });
      continue;
    }
    let loaded: unknown;
    try {
      loaded = await importModule(specifier);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      failures.push({ specifier, kind: NOT_FOUND_CODES.has(code) ? 'not-found' : 'import-failed' });
      continue;
    }
    const source = (loaded as { default?: unknown } | null | undefined)?.default;
    if (!isSecretSource(source)) {
      failures.push({ specifier, kind: 'invalid-export' });
      continue;
    }
    if (source.scheme === FILE_SOURCE_NAME) {
      failures.push({ specifier, kind: 'reserved-scheme' });
      continue;
    }
    if (sources.some((existing) => existing.scheme === source.scheme)) {
      failures.push({ specifier, kind: 'duplicate-scheme' });
      continue;
    }
    sources.push(source);
  }
  if (failures.length > 0) {
    throw new SecretAdapterLoadError(failures);
  }
  return sources;
}
