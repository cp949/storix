import { isUuid } from './uuid.js';

export interface KeysetCursor {
  readonly name: string;
  readonly id: string;
}

// name은 PostgreSQL text에 바인딩되므로 NUL(22021)을 막고, id는 uuid 비교에 쓰이므로 UUID 형식만 받는다.
function isKeysetCursor(value: unknown): value is KeysetCursor {
  if (value === null || typeof value !== 'object') return false;
  const { name, id } = value as Record<string, unknown>;
  return typeof name === 'string' && !name.includes('\0') && typeof id === 'string' && isUuid(id);
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): KeysetCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return isKeysetCursor(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
