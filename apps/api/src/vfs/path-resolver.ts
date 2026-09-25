import { VfsInvalidPathError } from './vfs.errors.js';

export interface ResolvedPath {
  readonly canonical: string;
  readonly segments: string[];
}

function invalidSegment(segment: string): boolean {
  return segment === '..' || segment.includes('\\') || /[\x00-\x1f\x7f]/.test(segment);
}

export function assertConditionalSegments(segments: readonly string[]): void {
  const path = segments.length === 0 ? '/' : `/${segments.join('/')}`;
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment.includes('/') ||
      invalidSegment(segment) ||
      segment.normalize('NFC') !== segment
    ) {
      throw new VfsInvalidPathError(path);
    }
  }
}

export class PathResolver {
  resolve(rawPath: string): ResolvedPath {
    if (!rawPath.startsWith('/')) {
      throw new VfsInvalidPathError(rawPath);
    }

    const segments = rawPath.split('/').filter((segment) => segment.length > 0 && segment !== '.');

    for (const segment of segments) {
      if (invalidSegment(segment)) {
        throw new VfsInvalidPathError(rawPath);
      }
    }

    const canonical = segments.length === 0 ? '/' : `/${segments.join('/')}`;

    return { canonical, segments };
  }

  resolveConditional(rawPath: string): ResolvedPath {
    const path = this.resolve(rawPath);
    assertConditionalSegments(path.segments);
    return path;
  }
}

export function joinChildPath(parentCanonical: string, relative: string): string {
  return parentCanonical === '/' ? `/${relative}` : `${parentCanonical}/${relative}`;
}
