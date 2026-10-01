/**
 * `GET /api/v2/namespaces`의 page cursor. `(name, id)` keyset 위치를 `nl1.` 접두어의 base64url JSON으로 만든다.
 * 서명하지 않는다. 위치만 담으므로 변조해도 다른 namespace의 정보를 읽을 수 없고 목록 범위만 바뀐다.
 */
import { isUuid } from '../common/uuid.js';
import { VfsInvalidCursorError } from '../vfs/vfs.errors.js';

/** cursor가 가리키는 마지막 항목의 위치. */
export interface NamespaceListCursor {
  readonly name: string;
  readonly id: string;
}

const MAX_RAW_LENGTH = 512;
const MAX_NAME_LENGTH = 128;

function valid(value: NamespaceListCursor): boolean {
  return (
    typeof value.name === 'string' &&
    value.name.length >= 1 &&
    value.name.length <= MAX_NAME_LENGTH &&
    isUuid(value.id)
  );
}

/** 위치를 cursor 문자열로 만든다. 입력이 올바르지 않으면 거부한다. */
export function encodeNamespaceListCursor(value: NamespaceListCursor): string {
  if (!valid(value)) throw new VfsInvalidCursorError(JSON.stringify(value));
  return `nl1.${Buffer.from(JSON.stringify({ name: value.name, id: value.id }), 'utf8').toString('base64url')}`;
}

/** cursor 문자열을 위치로 되돌린다. 형식·필드·길이·정규 표기가 맞지 않으면 `VFS_INVALID_CURSOR`다. */
export function decodeNamespaceListCursor(raw: string): NamespaceListCursor {
  try {
    if (raw.length > MAX_RAW_LENGTH || !/^nl1\.[A-Za-z0-9_-]+$/.test(raw)) throw new Error('prefix');
    const value: unknown = JSON.parse(Buffer.from(raw.slice(4), 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.name !== 'string' || typeof record.id !== 'string')
      throw new Error('fields');
    const cursor = { name: record.name, id: record.id };
    if (!valid(cursor) || encodeNamespaceListCursor(cursor) !== raw) throw new Error('canonicality');
    return cursor;
  } catch {
    throw new VfsInvalidCursorError(raw.slice(0, 64));
  }
}
