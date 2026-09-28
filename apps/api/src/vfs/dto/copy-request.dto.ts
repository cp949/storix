import { VfsInvalidExpiryError, VfsInvalidPathError } from '../vfs.errors.js';

export interface CopyRequest {
  readonly source: string;
  readonly destination: string;
  readonly destinationParents: boolean;
}

export function parseCopyRequest(body: unknown): CopyRequest {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const source = record.source;
  const destination = record.destination;

  // 레거시 cp는 만료를 받지 않는다. 모르는 필드처럼 무시하면 호출자가 적용됐다고 오해한다.
  if ('expiresInSeconds' in record) throw new VfsInvalidExpiryError();

  if (typeof source !== 'string') {
    throw new VfsInvalidPathError(String(source));
  }
  if (typeof destination !== 'string') {
    throw new VfsInvalidPathError(String(destination));
  }

  return { source, destination, destinationParents: record.destinationParents === true };
}
