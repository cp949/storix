import type { ContentPrecondition } from '../../persistence/vfs-node.repository.js';
import { resolveSnapshotRestorePath, resolveSnapshotSourcePath } from '../snapshot-path.js';
import { decodeRevision } from '../revision.js';
import { VfsInvalidMutationRequestError, VfsPreconditionRequiredError } from '../vfs.errors.js';

export interface SnapshotCreateRequest {
  readonly kind: 'file' | 'tree';
  readonly path: string;
}

export interface SnapshotRestoreRequest {
  readonly path: string;
  readonly condition: ContentPrecondition;
}

function recordOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new VfsInvalidMutationRequestError();
  }
  return value as Record<string, unknown>;
}

function requireKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new VfsInvalidMutationRequestError();
}

export function parseSnapshotCreateRequest(value: unknown): SnapshotCreateRequest {
  const record = recordOf(value);
  requireKeys(record, ['kind', 'path']);
  if ((record.kind !== 'file' && record.kind !== 'tree') || typeof record.path !== 'string') {
    throw new VfsInvalidMutationRequestError();
  }
  return { kind: record.kind, path: resolveSnapshotSourcePath(record.path, record.kind).canonical };
}

export function parseSnapshotRestoreRequest(value: unknown): SnapshotRestoreRequest {
  const record = recordOf(value);
  requireKeys(record, ['path', 'ifAbsent', 'ifRevision']);
  if (typeof record.path !== 'string') throw new VfsInvalidMutationRequestError();
  const path = resolveSnapshotRestorePath(record.path).canonical;
  const hasAbsent = Object.hasOwn(record, 'ifAbsent');
  const hasRevision = Object.hasOwn(record, 'ifRevision');
  if (!hasAbsent && !hasRevision) throw new VfsPreconditionRequiredError();
  if (hasAbsent === hasRevision) throw new VfsInvalidMutationRequestError();
  if (hasAbsent) {
    if (record.ifAbsent !== true) throw new VfsInvalidMutationRequestError();
    return { path, condition: { ifAbsent: true } };
  }
  if (typeof record.ifRevision !== 'string') throw new VfsInvalidMutationRequestError();
  decodeRevision(record.ifRevision);
  return { path, condition: { ifRevision: record.ifRevision } };
}
