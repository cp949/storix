import { decodeRevision } from '../revision.js';
import {
  VfsInvalidChecksumError,
  VfsInvalidMutationRequestError,
  VfsPreconditionRequiredError,
} from '../vfs.errors.js';

export interface UploadSessionCreateRequest {
  readonly path: string;
  readonly sizeBytes: string;
  readonly mimeType: string;
  readonly ifAbsent?: true;
  readonly ifRevision?: string;
  readonly sha256?: string;
}

export function parseUploadSessionCreateRequest(value: unknown): UploadSessionCreateRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new VfsInvalidMutationRequestError();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) => !['path', 'sizeBytes', 'mimeType', 'ifAbsent', 'ifRevision', 'sha256'].includes(key),
    )
  )
    throw new VfsInvalidMutationRequestError();
  if (Object.hasOwn(row, 'sha256') && (typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256)))
    throw new VfsInvalidChecksumError();
  const absent = Object.hasOwn(row, 'ifAbsent');
  const revision = Object.hasOwn(row, 'ifRevision');
  if (!absent && !revision) throw new VfsPreconditionRequiredError();
  if (
    absent === revision ||
    (absent && row.ifAbsent !== true) ||
    (revision && typeof row.ifRevision !== 'string')
  )
    throw new VfsInvalidMutationRequestError();
  if (
    typeof row.path !== 'string' ||
    typeof row.sizeBytes !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(row.sizeBytes) ||
    typeof row.mimeType !== 'string' ||
    row.mimeType.length > 255 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/.test(row.mimeType)
  )
    throw new VfsInvalidMutationRequestError();
  if (revision) decodeRevision(row.ifRevision as string);
  return {
    path: row.path,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType.toLowerCase(),
    ...(row.sha256 !== undefined ? { sha256: row.sha256 as string } : {}),
    ...(absent ? { ifAbsent: true as const } : { ifRevision: row.ifRevision as string }),
  };
}
