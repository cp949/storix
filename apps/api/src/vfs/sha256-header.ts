// content/conditional과 조각 PUT이 공유하는 SHA-256 헤더 형식을 검증한다.
// 규칙은 docs/design/07-resumable-upload.md "공개 계약".
import { VfsInvalidChecksumError } from './vfs.errors.js';

/**
 * `X-Content-Sha256` 요청 헤더 값을 검증해 그대로 돌려준다.
 * 값은 64자리 소문자 hex여야 한다. 헤더가 없으면 `undefined`를 돌려준다.
 * 형식 오류는 본문 소비 전에 `VFS_INVALID_CHECKSUM`(400)으로 거부하도록 호출부가 요청 맨 앞에서 부른다.
 *
 * 쓰는 곳은 `content/conditional`과 재개 업로드 조각 PUT이다. 규칙은 docs/design/07-resumable-upload.md "공개 계약".
 */
export function parseSha256Header(value: string | undefined): string | undefined {
  if (value !== undefined && !/^[0-9a-f]{64}$/.test(value)) throw new VfsInvalidChecksumError();
  return value;
}
