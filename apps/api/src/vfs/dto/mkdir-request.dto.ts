import { VfsInvalidPathError } from '../vfs.errors.js';

export interface MkdirRequest {
  readonly path: string;
  readonly parents: boolean;
}

export function parseMkdirRequest(body: unknown): MkdirRequest {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const path = record.path;

  if (typeof path !== 'string') {
    throw new VfsInvalidPathError(String(path));
  }

  return { path, parents: record.parents === true };
}
