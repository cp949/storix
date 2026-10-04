import { VfsInvalidMutationRequestError } from './vfs.errors.js';

const MIME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/;
const DEFAULT_MIME_TYPE = 'application/octet-stream';
// blob.mime_type·vfs_node.mime_type 컬럼이 varchar(255)다. PostgreSQL은 초과 값을 22001로 거절한다.
const MAX_MIME_LENGTH = 255;

export function normalizeMimeType(raw: string | undefined): string {
  if (!raw) {
    return DEFAULT_MIME_TYPE;
  }

  const primary = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  // 형식 오류와 같이 관대하게 대체한다(api ADR-0028). 길이 초과도 저장 컬럼을 넘지 않게 대체한다.
  return primary.length <= MAX_MIME_LENGTH && MIME_PATTERN.test(primary) ? primary : DEFAULT_MIME_TYPE;
}

// upload-session-request.dto.ts의 strict 검증과 동일하게, 파라미터 제거 없이 원문 그대로
// MIME_PATTERN에 매칭한다(세미콜론 등이 있으면 그대로 거절한다). 통과하면 소문자로 반환한다.
export function assertStrictMimeType(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > MAX_MIME_LENGTH || !MIME_PATTERN.test(raw)) {
    throw new VfsInvalidMutationRequestError();
  }
  return raw.toLowerCase();
}
