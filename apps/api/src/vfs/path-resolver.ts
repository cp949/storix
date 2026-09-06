import { VfsInvalidPathError } from './vfs.errors.js';

export interface ResolvedPath {
  readonly canonical: string;
  readonly segments: string[];
}

export class PathResolver {
  resolve(rawPath: string): ResolvedPath {
    if (!rawPath.startsWith('/')) {
      throw new VfsInvalidPathError(rawPath);
    }

    const segments = rawPath.split('/').filter((segment) => segment.length > 0 && segment !== '.');

    for (const segment of segments) {
      if (segment === '..' || segment.includes('\\') || /[\x00-\x1f\x7f]/.test(segment)) {
        throw new VfsInvalidPathError(rawPath);
      }
    }

    const canonical = segments.length === 0 ? '/' : `/${segments.join('/')}`;

    return { canonical, segments };
  }
}

export function joinChildPath(parentCanonical: string, relative: string): string {
  return parentCanonical === '/' ? `/${relative}` : `${parentCanonical}/${relative}`;
}
