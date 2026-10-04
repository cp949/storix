/**
 * 기동 시 비밀값을 해석하는 진입 함수다.
 * 진입점은 루트 모듈을 import하기 전에 호출한다. 호출 위치는 `bootstrapWithEnv()`와 `persistence/data-source.ts`다.
 */
import { MAX_TIMER_MS, parsePositiveInt } from '../common/env-parsing.js';
import { resolveSecretValues } from './resolve-secret-values.js';
import { loadSecretAdapters, parseAdapterSpecifiers, type ImportModule } from './secret-adapter-loader.js';

/** 통신형 해석 1건의 기본 타임아웃(ms)이다. */
export const DEFAULT_SECRET_RESOLVE_TIMEOUT_MS = 10000;

/** 어댑터 패키지 목록 변수다. */
export const SECRET_ADAPTERS_ENV = 'STORIX_SECRET_ADAPTERS';

/** 통신형 해석 타임아웃 변수다. */
export const SECRET_RESOLVE_TIMEOUT_ENV = 'STORIX_SECRET_RESOLVE_TIMEOUT_MS';

/**
 * 어댑터를 불러온 뒤 env의 비밀 변수 지정을 해석해 `X`에 쓴다.
 * 어댑터 로드 실패는 `SecretAdapterLoadError`, 해석 실패는 `SecretResolutionError`를 던진다.
 */
export async function resolveSecrets(
  env: NodeJS.ProcessEnv = process.env,
  importModule?: ImportModule,
): Promise<void> {
  // 잘못된 설정은 어댑터를 불러오기 전에 거부한다.
  const timeoutMs = parsePositiveInt(
    env[SECRET_RESOLVE_TIMEOUT_ENV],
    DEFAULT_SECRET_RESOLVE_TIMEOUT_MS,
    MAX_TIMER_MS,
  );
  const sources = await loadSecretAdapters(parseAdapterSpecifiers(env[SECRET_ADAPTERS_ENV]), importModule);
  await resolveSecretValues(env, { sources, timeoutMs });
}
