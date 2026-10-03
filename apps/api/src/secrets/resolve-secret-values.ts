/**
 * 비밀 환경변수의 `X`·`X_FILE`·`X_REF` 지정을 해석해 `X`에 채운다.
 * 규칙은 docs/design/15-secret-sources.md "해석 규칙"과 "실패 정책"을 따른다.
 * - 빈 문자열은 지정하지 않은 것으로 본다.
 * - 오류 메시지에는 변수명, 방식, 실패 종류만 쓴다. 값과 어댑터 오류 메시지는 쓰지 않는다.
 * - 실패가 하나라도 있으면 env를 바꾸지 않고 모든 실패를 담은 오류를 던진다.
 */
import { readSecretFile } from './secret-file.js';
import { FILE_SOURCE_NAME, SECRET_ENV_NAMES, type SecretSource } from './secret-source.js';

/** 해석 실패 종류다. */
export type SecretFailureKind =
  | 'conflict'
  | 'empty'
  | 'not-found'
  | 'unreadable'
  | 'invalid-ref'
  | 'reserved-scheme'
  | 'unknown-scheme'
  | 'timeout'
  | 'adapter-error';

/** 변수 하나의 해석 실패다. 값을 담지 않는다. */
export interface SecretFailure {
  /** 비밀 변수 이름(`X`)이다. */
  readonly name: string;

  /** 지정 방식이다. `file`, `ref`, scheme, 충돌이면 `env+file` 같은 조합이다. */
  readonly method: string;

  /** 실패 종류다. */
  readonly kind: SecretFailureKind;
}

/** 해석에 실패한 변수를 모두 담은 오류다. 메시지에 값이 들어가지 않는다. */
export class SecretResolutionError extends Error {
  constructor(readonly failures: readonly SecretFailure[]) {
    super(`비밀값 해석 실패: ${failures.map((f) => `${f.name}(${f.method}): ${f.kind}`).join(', ')}`);
    this.name = 'SecretResolutionError';
  }
}

/** `resolveSecretValues()`의 입력이다. */
export interface ResolveSecretValuesOptions {
  /** 통신형 어댑터 목록이다. scheme이 서로 다르다. */
  readonly sources: readonly SecretSource[];

  /** 통신형 해석 1건의 타임아웃(ms)이다. */
  readonly timeoutMs: number;
}

type SecretSpec =
  { readonly method: 'file'; readonly path: string } | { readonly method: 'ref'; readonly ref: string };

interface ResolvedSecret {
  readonly name: string;
  readonly value: string;
}

const REF_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/./;
const TIMED_OUT = Symbol('timed-out');
const ADAPTER_FAILED = Symbol('adapter-failed');

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function isFailure(result: ResolvedSecret | SecretFailure): result is SecretFailure {
  return 'kind' in result;
}

/** env의 대상 변수 지정을 해석해 `X`에 쓴다. 실패하면 `SecretResolutionError`를 던진다. */
export async function resolveSecretValues(
  env: NodeJS.ProcessEnv,
  options: ResolveSecretValuesOptions,
): Promise<void> {
  const pending: Promise<ResolvedSecret | SecretFailure>[] = [];
  for (const name of SECRET_ENV_NAMES) {
    const spec = readSpec(env, name);
    if (spec === undefined) {
      continue;
    }
    pending.push('kind' in spec ? Promise.resolve(spec) : resolveSpec(name, spec, options));
  }

  const results = await Promise.all(pending);
  const failures = results.filter(isFailure);
  if (failures.length > 0) {
    throw new SecretResolutionError(failures);
  }
  for (const result of results) {
    if (!isFailure(result)) {
      env[result.name] = result.value;
    }
  }
}

function readSpec(env: NodeJS.ProcessEnv, name: string): SecretSpec | SecretFailure | undefined {
  const value = nonEmpty(env[name]);
  const path = nonEmpty(env[`${name}_FILE`]);
  const ref = nonEmpty(env[`${name}_REF`]);
  const given = [
    value === undefined ? undefined : 'env',
    path === undefined ? undefined : 'file',
    ref === undefined ? undefined : 'ref',
  ].filter((method): method is string => method !== undefined);

  if (given.length > 1) {
    return { name, method: given.join('+'), kind: 'conflict' };
  }
  if (path !== undefined) {
    return { method: 'file', path };
  }
  if (ref !== undefined) {
    return { method: 'ref', ref };
  }
  return undefined;
}

async function resolveSpec(
  name: string,
  spec: SecretSpec,
  options: ResolveSecretValuesOptions,
): Promise<ResolvedSecret | SecretFailure> {
  if (spec.method === 'file') {
    return resolveFile(name, spec.path);
  }

  const match = REF_PATTERN.exec(spec.ref);
  if (match === null) {
    return { name, method: 'ref', kind: 'invalid-ref' };
  }
  const scheme = match[1];
  if (scheme === FILE_SOURCE_NAME) {
    return { name, method: scheme, kind: 'reserved-scheme' };
  }
  const source = options.sources.find((candidate) => candidate.scheme === scheme);
  if (source === undefined) {
    return { name, method: scheme, kind: 'unknown-scheme' };
  }

  const outcome = await resolveWithTimeout(source, spec.ref, options.timeoutMs);
  if (outcome === TIMED_OUT) {
    return { name, method: scheme, kind: 'timeout' };
  }
  if (typeof outcome !== 'string') {
    return { name, method: scheme, kind: 'adapter-error' };
  }
  if (outcome === '') {
    return { name, method: scheme, kind: 'empty' };
  }
  return { name, value: outcome };
}

async function resolveFile(name: string, path: string): Promise<ResolvedSecret | SecretFailure> {
  let value: string;
  try {
    value = await readSecretFile(path);
  } catch (error) {
    const kind = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-found' : 'unreadable';
    return { name, method: 'file', kind };
  }
  return value === '' ? { name, method: 'file', kind: 'empty' } : { name, value };
}

// 어댑터가 signal을 무시해도 타임아웃 시점에 결과를 확정한다.
// 어댑터의 늦은 거부는 attempt 안에서 ADAPTER_FAILED로 바뀌어 미처리 거부가 되지 않는다.
async function resolveWithTimeout(source: SecretSource, ref: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(TIMED_OUT);
    }, timeoutMs);
  });
  const attempt = Promise.resolve()
    .then(() => source.resolve(ref, { signal: controller.signal }))
    .then(
      (value: unknown) => value,
      () => ADAPTER_FAILED,
    );
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
