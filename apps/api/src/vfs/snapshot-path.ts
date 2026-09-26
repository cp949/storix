import { assertPathSegments, PathResolver, type ResolvedPath } from './path-resolver.js';
import { VfsInvalidPathError } from './vfs.errors.js';

const resolver = new PathResolver();

export function resolveSnapshotSourcePath(rawPath: string, kind: 'file' | 'tree' = 'file'): ResolvedPath {
  const path = resolver.resolve(rawPath);
  if (kind === 'file' && path.segments.length === 0) throw new VfsInvalidPathError(rawPath);
  return path;
}

export function resolveSnapshotRestorePath(rawPath: string): ResolvedPath {
  const path = resolver.resolve(rawPath);
  if (path.segments.length === 0) throw new VfsInvalidPathError(rawPath);
  return path;
}

export function resolveSnapshotRelativePath(rawPath: string): ResolvedPath {
  if (rawPath.startsWith('/')) throw new VfsInvalidPathError(rawPath);
  const segments = rawPath.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  assertPathSegments(segments);
  return { canonical: segments.length === 0 ? '.' : segments.join('/'), segments };
}

export function snapshotPathKey(relativePath: string): string {
  return Buffer.from(relativePath, 'utf8').toString('hex');
}
