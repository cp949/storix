import { IdempotencyKeyRequiredError } from './namespace.errors.js';

/** `Idempotency-Key` 헤더의 최대 길이. openapi `IdempotencyKeyHeader.maxLength`와 같다. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * 관리자 PATCH 경로의 `Idempotency-Key`를 검사한다. 없거나 255 byte를 넘으면 `IDEMPOTENCY_KEY_REQUIRED`다.
 * Node는 헤더 값을 latin1로 읽어 문자 수가 곧 byte 수다.
 */
export function requireIdempotencyKey(idempotencyKey: string | undefined): string {
  if (!idempotencyKey) throw new IdempotencyKeyRequiredError();
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new IdempotencyKeyRequiredError('Idempotency-Key 헤더가 필요하며 255 byte 이하여야 함');
  }
  return idempotencyKey;
}
