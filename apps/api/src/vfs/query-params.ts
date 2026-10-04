import { VfsInvalidCursorError, VfsInvalidQueryError } from './vfs.errors.js';

/**
 * `cursor` 쿼리 파라미터를 문자열로 좁힌다. 같은 이름을 여러 번 보내면 Express가 배열로 파싱하므로
 * 문자열이 아니면 `VFS_INVALID_CURSOR`로 거절한다.
 */
export function optionalCursorParam(value: unknown): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  throw new VfsInvalidCursorError(Array.isArray(value) ? 'array' : typeof value);
}

/**
 * `find`의 `name` 필터 값을 검사한다. 문자열이 아니거나(중복 파라미터) NUL을 포함하면
 * `VFS_INVALID_QUERY`다. NUL은 PostgreSQL text에 바인딩할 수 없다(22021).
 * 그 밖의 문자는 이름 일부를 찾는 `contains`·`prefix`·`suffix`가 있어 제한하지 않는다.
 */
export function optionalNameFilterParam(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.includes('\0')) throw new VfsInvalidQueryError('name');
  return value;
}
