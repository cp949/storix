import { randomUUID } from 'node:crypto';

/** Namespace ID의 최대 길이. 12자 prefix와 구분자·32자리 UUID를 포함한다. */
export const NAMESPACE_ID_MAX_LENGTH = 45;

/** 허용할 Namespace ID prefix 문법. */
export const NAMESPACE_ID_PREFIX_PATTERN = /^[a-z][a-z0-9_-]{0,11}$/;

/** 기존 하이픈 UUID와 prefix가 붙은 소문자 hex ID 문법. */
const NAMESPACE_ID_PATTERN =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:[a-z][a-z0-9_-]{0,11}_)?[0-9a-f]{32})$/;

/** Namespace ID가 저장·경로 입력에 허용되는 canonical 표기인지 확인한다. */
export function isNamespaceId(value: string): boolean {
  return value.length <= NAMESPACE_ID_MAX_LENGTH && NAMESPACE_ID_PATTERN.test(value);
}

/** 선택 prefix와 UUID v4로 새 Namespace ID를 만든다. */
export function generateNamespaceId(prefix?: string): string {
  return `${prefix ? `${prefix}_` : ''}${randomUUID().replaceAll('-', '')}`;
}
