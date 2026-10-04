import { isValidTimestampKey } from '../common/timestamp-key.js';
import { isUuid } from '../common/uuid.js';
import { isNamespaceId } from '../common/namespace-id.js';
import { VfsInvalidCursorError } from './vfs.errors.js';

export interface SnapshotListCursor {
  readonly namespaceId: string;
  readonly rootNodeId: string;
  readonly createdAtKey: string;
  readonly snapshotId: string;
}

function valid(value: SnapshotListCursor): boolean {
  return (
    isNamespaceId(value.namespaceId) &&
    isUuid(value.rootNodeId) &&
    isUuid(value.snapshotId) &&
    isValidTimestampKey(value.createdAtKey)
  );
}

export function encodeSnapshotListCursor(value: SnapshotListCursor): string {
  if (!valid(value)) throw new VfsInvalidCursorError(JSON.stringify(value));
  return `sl1.${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;
}

export function decodeSnapshotListCursor(
  raw: string,
  namespaceId: string,
  rootNodeId: string,
): SnapshotListCursor {
  try {
    if (!/^sl1\.[A-Za-z0-9_-]+$/.test(raw)) throw new Error('prefix');
    const value: unknown = JSON.parse(Buffer.from(raw.slice(4), 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    const record = value as Record<string, unknown>;
    const keys = ['namespaceId', 'rootNodeId', 'createdAtKey', 'snapshotId'];
    if (
      Object.keys(record).length !== keys.length ||
      keys.some((key) => !keys.includes(key) || typeof record[key] !== 'string')
    )
      throw new Error('fields');
    const cursor = record as unknown as SnapshotListCursor;
    if (
      !valid(cursor) ||
      cursor.namespaceId !== namespaceId ||
      cursor.rootNodeId.toLowerCase() !== rootNodeId.toLowerCase()
    )
      throw new Error('owner');
    if (encodeSnapshotListCursor(cursor) !== raw) throw new Error('canonicality');
    return cursor;
  } catch {
    throw new VfsInvalidCursorError(raw);
  }
}
