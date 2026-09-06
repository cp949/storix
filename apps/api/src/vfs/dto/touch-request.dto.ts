import { VfsInvalidPathError } from '../vfs.errors.js';

export interface TouchRequest {
  readonly path: string;
  readonly parents: boolean;
}

export function parseTouchRequest(body: unknown): TouchRequest {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const path = record.path;

  if (typeof path !== 'string') {
    throw new VfsInvalidPathError(String(path));
  }

  return { path, parents: record.parents === true };
}
