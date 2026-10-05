import { InvalidRequestBodyError } from './document-archive.errors.js';

/**
 * JSON 본문에서 문자열 필드를 꺼낸다. 본문이 객체가 아니거나 필드가 없거나 문자열이 아니면 400이다.
 * 빈 문자열은 사용자 root를 뜻하므로 허용한다. 오류 message에는 필드 이름만 싣고 입력 값은 싣지 않는다.
 */
export function requireStringFields<K extends string>(
  body: unknown,
  fields: readonly K[],
): Record<K, string> {
  const source: Record<string, unknown> =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const result = {} as Record<K, string>;
  for (const field of fields) {
    const value = source[field];
    if (typeof value !== 'string') throw new InvalidRequestBodyError(field);
    result[field] = value;
  }
  return result;
}
