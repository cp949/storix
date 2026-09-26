import { VfsInvalidPathError } from './vfs.errors.js';

export interface ResolvedPath {
  readonly canonical: string;
  readonly segments: string[];
}

function invalidSegment(segment: string): boolean {
  return (
    segment === '..' ||
    segment.includes('\\') ||
    /[\u0000-\u001f\u007f-\u009f]|\p{Bidi_Control}/u.test(segment) ||
    /[\uD800-\uDFFF]/u.test(segment) ||
    segment.normalize('NFC') !== segment ||
    Buffer.byteLength(segment, 'utf8') > 255
  );
}

export function assertPathSegments(segments: readonly string[]): void {
  const path = segments.length === 0 ? '/' : `/${segments.join('/')}`;
  if (Buffer.byteLength(path, 'utf8') > 4096) throw new VfsInvalidPathError(path);
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment.includes('/') || invalidSegment(segment)) {
      throw new VfsInvalidPathError(path);
    }
  }
}

export const assertConditionalSegments = assertPathSegments;

export class PathResolver {
  resolve(rawPath: unknown): ResolvedPath {
    if (typeof rawPath !== 'string') {
      throw new VfsInvalidPathError('');
    }
    if (!rawPath.startsWith('/')) {
      throw new VfsInvalidPathError(rawPath);
    }

    const segments = rawPath.split('/').filter((segment) => segment.length > 0 && segment !== '.');

    const canonical = segments.length === 0 ? '/' : `/${segments.join('/')}`;
    assertPathSegments(segments);

    return { canonical, segments };
  }

  resolveConditional(rawPath: string): ResolvedPath {
    return this.resolve(rawPath);
  }
}

export function joinChildPath(parentCanonical: string, relative: string): string {
  return parentCanonical === '/' ? `/${relative}` : `${parentCanonical}/${relative}`;
}
