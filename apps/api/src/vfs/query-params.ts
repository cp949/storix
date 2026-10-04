/**
 * `ls`·`find` 컨트롤러가 SQL 실행 전에 쿼리 파라미터를 검사하는 함수 모음.
 * 규칙은 docs/design/05-vfs-path-contract.md "목록·검색 쿼리 입력".
 */
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

/**
 * `ls`의 `consistency` 값을 검사한다. 생략하거나 `revision`만 허용하고, 빈 문자열·대소문자 변형·
 * 알 수 없는 값·중복 파라미터(배열)는 `VFS_INVALID_QUERY`다. cursor 오류가 아니므로 `VFS_INVALID_CURSOR`를 쓰지 않는다.
 */
export function optionalConsistencyParam(value: unknown): 'revision' | undefined {
  if (value === undefined || value === 'revision') return value;
  throw new VfsInvalidQueryError('consistency');
}
