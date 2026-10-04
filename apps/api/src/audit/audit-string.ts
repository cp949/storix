// 이 파일은 persistence 계층(엔티티)을 import하지 않는다. `main.ts`가 정적으로 import하는
// `DomainErrorFilter`가 쓰므로, 엔티티를 끌어오면 `bootstrapWithEnv()`의 `.env` 로딩보다 먼저
// 드라이버 중립 컬럼 타입 상수가 얼어붙는다(`main.ts` 상단 주석).

const MAX_AUDIT_STRING_LENGTH = 4096;
const CONTROL_CHARS = /[\x00-\x1f]/g;
// 짝이 맞지 않는 high/low surrogate. `u` 플래그 없이 코드 유닛 단위로 찾는다.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const REPLACEMENT_CHAR = '�';

/**
 * 요청 본문·쿼리의 문자열을 감사 로그 컬럼(text/jsonb)에 저장할 수 있게 정리한다.
 * 요청 값은 공격자가 임의로 채울 수 있으므로 기록 자체가 실패해 감사 행이 누락되는 일을 막는다.
 *
 * 처리 순서:
 * - NUL 등 제어 문자를 제거한다.
 * - 짝이 맞지 않는 surrogate를 `U+FFFD`로 바꾼다. PostgreSQL `jsonb`가 lone surrogate를 거부한다.
 * - 4096 코드 유닛으로 자른다.
 * - 자른 끝이 high surrogate이면 pair가 깨진 것이므로 그 글자를 버린다.
 */
export function sanitizeAuditString(value: string): string {
  const cleaned = value.replace(CONTROL_CHARS, '').replace(LONE_SURROGATE, REPLACEMENT_CHAR);
  const truncated = cleaned.slice(0, MAX_AUDIT_STRING_LENGTH);
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
}
