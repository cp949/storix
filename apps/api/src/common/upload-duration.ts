import { MAX_TIMER_MS, parsePositiveInt } from './env-parsing.js';

/** `STORIX_MUTATION_MAX_UPLOAD_SECONDS`가 없을 때 쓰는 업로드 최대 지속 시간(초)이다. 24시간이다. */
export const DEFAULT_MAX_UPLOAD_SECONDS = 86_400;

/** 업로드 최대 지속 시간의 상한(초)이다. ms로 바꾼 값이 `setTimeout`이 받는 한도를 넘지 않는 최댓값이다. */
export const MAX_UPLOAD_SECONDS_LIMIT = Math.floor(MAX_TIMER_MS / 1000);

/**
 * `STORIX_MUTATION_MAX_UPLOAD_SECONDS`를 읽어 업로드 최대 지속 시간(초)을 돌려준다.
 * 초를 ms로 바꿔 `setTimeout`에 넘기므로 `MAX_UPLOAD_SECONDS_LIMIT`을 넘는 값은 거부한다.
 * 넘는 값을 그대로 쓰면 타이머가 1ms 뒤에 발화해 모든 업로드가 즉시 끊긴다.
 */
export function parseMaxUploadSeconds(value: string | undefined): number {
  return parsePositiveInt(value, DEFAULT_MAX_UPLOAD_SECONDS, MAX_UPLOAD_SECONDS_LIMIT);
}
