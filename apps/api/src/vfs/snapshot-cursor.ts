import { isUuid } from '../common/uuid.js';
import { VfsInvalidCursorError } from './vfs.errors.js';

export interface SnapshotCursor {
  readonly snapshotId: string;
  readonly pathKey: string;
}

function validCursor(cursor: SnapshotCursor): boolean {
  return isUuid(cursor.snapshotId) && /^[0-9a-f]+$/.test(cursor.pathKey) && cursor.pathKey.length % 2 === 0;
}

export function encodeSnapshotCursor(cursor: SnapshotCursor): string {
  if (!validCursor(cursor)) throw new VfsInvalidCursorError(JSON.stringify(cursor));
  const payload = JSON.stringify({ snapshotId: cursor.snapshotId, pathKey: cursor.pathKey });
  return `sc1.${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export function decodeSnapshotCursor(raw: string, expectedSnapshotId?: string): SnapshotCursor {
  if (!/^sc1\.[A-Za-z0-9_-]+$/.test(raw)) throw new VfsInvalidCursorError(raw);
  try {
    const json = Buffer.from(raw.slice(4), 'base64url').toString('utf8');
    const value: unknown = JSON.parse(json);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('cursor shape');
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      typeof record.snapshotId !== 'string' ||
      typeof record.pathKey !== 'string'
    )
      throw new Error('cursor fields');
    const cursor: SnapshotCursor = { snapshotId: record.snapshotId, pathKey: record.pathKey };
    if (
      !validCursor(cursor) ||
      (expectedSnapshotId !== undefined && cursor.snapshotId !== expectedSnapshotId)
    ) {
      throw new Error('cursor values');
    }
    if (encodeSnapshotCursor(cursor) !== raw) throw new Error('cursor canonicality');
    return cursor;
  } catch {
    throw new VfsInvalidCursorError(raw);
  }
}
