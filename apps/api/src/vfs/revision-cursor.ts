import { isUuid } from '../common/uuid.js';
import { decodeRevision } from './revision.js';
import { VfsInvalidCursorError } from './vfs.errors.js';

export interface RevisionCursor {
  readonly directoryId: string;
  readonly directoryRevision: string;
  readonly name: string;
  readonly id: string;
}

export function encodeRevisionCursor(cursor: RevisionCursor): string {
  return `rc1.${Buffer.from(
    JSON.stringify({
      directoryId: cursor.directoryId,
      directoryRevision: cursor.directoryRevision,
      name: cursor.name,
      id: cursor.id,
    }),
    'utf8',
  ).toString('base64url')}`;
}

export function decodeRevisionCursor(raw: string): RevisionCursor {
  if (!/^rc1\.[A-Za-z0-9_-]+$/.test(raw)) throw new VfsInvalidCursorError(raw);
  try {
    const value: unknown = JSON.parse(Buffer.from(raw.slice(4), 'base64url').toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new VfsInvalidCursorError(raw);
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.directoryId !== 'string' ||
      !isUuid(record.directoryId) ||
      typeof record.directoryRevision !== 'string' ||
      typeof record.name !== 'string' ||
      record.name.length === 0 ||
      typeof record.id !== 'string' ||
      !isUuid(record.id)
    ) {
      throw new VfsInvalidCursorError(raw);
    }
    const decoded = decodeRevision(record.directoryRevision);
    if (decoded.id !== record.directoryId) throw new VfsInvalidCursorError(raw);
    const cursor: RevisionCursor = {
      directoryId: record.directoryId,
      directoryRevision: record.directoryRevision,
      name: record.name,
      id: record.id,
    };
    if (encodeRevisionCursor(cursor) !== raw) throw new VfsInvalidCursorError(raw);
    return cursor;
  } catch {
    throw new VfsInvalidCursorError(raw);
  }
}
