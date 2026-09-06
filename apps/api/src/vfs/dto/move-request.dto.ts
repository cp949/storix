import { VfsInvalidPathError } from '../vfs.errors.js';

export interface MoveRequest {
  readonly source: string;
  readonly destination: string;
  readonly destinationParents: boolean;
}

export function parseMoveRequest(body: unknown): MoveRequest {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const source = record.source;
  const destination = record.destination;

  if (typeof source !== 'string') {
    throw new VfsInvalidPathError(String(source));
  }
  if (typeof destination !== 'string') {
    throw new VfsInvalidPathError(String(destination));
  }

  return { source, destination, destinationParents: record.destinationParents === true };
}
