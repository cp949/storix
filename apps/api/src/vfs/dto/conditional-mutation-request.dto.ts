import { PathResolver } from '../path-resolver.js';
import { decodeRevision } from '../revision.js';
import { assertStrictMimeType } from '../mime.js';
import {
  assertExpirySeconds,
  assertExpiryWithinBounds,
  DEFAULT_FILE_EXPIRY_BOUNDS,
  parseExpirySeconds,
  type FileExpiryBounds,
} from '../file-expiry-policy.js';
import {
  VfsInvalidExpiryError,
  VfsInvalidMutationRequestError,
  VfsPreconditionRequiredError,
} from '../vfs.errors.js';

export type ConditionalMutation =
  | { readonly kind: 'mkdir'; readonly path: string; readonly segments: string[]; readonly ifAbsent: true }
  | {
      readonly kind: 'delete';
      readonly path: string;
      readonly segments: string[];
      readonly ifRevision: string;
      readonly recursive: boolean;
    }
  | {
      readonly kind: 'persist';
      readonly path: string;
      readonly segments: string[];
      readonly ifRevision: string;
    }
  | {
      readonly kind: 'setMimeType';
      readonly path: string;
      readonly segments: string[];
      readonly ifRevision: string;
      readonly mimeType: string;
    }
  | {
      readonly kind: 'move' | 'copy';
      readonly source: string;
      readonly sourceSegments: string[];
      readonly destination: string;
      readonly destinationSegments: string[];
      readonly sourceRevision: string;
      readonly destinationAbsent: true;
      readonly destinationResolution?: 'exact';
      readonly expiresInSeconds?: number;
    };

const resolver = new PathResolver();

function recordOf(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new VfsInvalidMutationRequestError();
  }
  return body as Record<string, unknown>;
}

function requireKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new VfsInvalidMutationRequestError();
  }
}

function pathOf(value: unknown, allowRoot: boolean): { canonical: string; segments: string[] } {
  if (typeof value !== 'string') {
    throw new VfsInvalidMutationRequestError();
  }
  const path = resolver.resolveConditional(value);
  if (!allowRoot && path.segments.length === 0) {
    throw new VfsInvalidMutationRequestError();
  }
  return path;
}

function requiredRevision(record: Record<string, unknown>, field: string): string {
  if (!(field in record)) {
    throw new VfsPreconditionRequiredError();
  }
  const value = record[field];
  if (typeof value !== 'string') {
    throw new VfsInvalidMutationRequestError();
  }
  decodeRevision(value);
  return value;
}

function requireTrue(record: Record<string, unknown>, field: string): void {
  if (!(field in record)) {
    throw new VfsPreconditionRequiredError();
  }
  if (record[field] !== true) {
    throw new VfsInvalidMutationRequestError();
  }
}

// 만료 범위(설정)만 따로 검사한다. fingerprint가 env 범위에 의존하지 않도록
// parseConditionalMutation(body, null)로 구조를 먼저 파싱한 뒤 호출한다.
export function assertMutationExpiryWithinBounds(
  command: ConditionalMutation,
  expiryBounds: FileExpiryBounds,
): void {
  if (command.kind === 'copy' && command.expiresInSeconds !== undefined) {
    assertExpiryWithinBounds(command.expiresInSeconds, expiryBounds);
  }
}

// expiryBounds가 null이면 만료 입력의 형태만 확인하고 설정 범위는 검사하지 않는다.
export function parseConditionalMutation(
  body: unknown,
  expiryBounds: FileExpiryBounds | null = DEFAULT_FILE_EXPIRY_BOUNDS,
): ConditionalMutation {
  const record = recordOf(body);
  switch (record.kind) {
    case 'mkdir': {
      requireKeys(record, ['kind', 'path', 'ifAbsent']);
      const path = pathOf(record.path, false);
      requireTrue(record, 'ifAbsent');
      return { kind: 'mkdir', path: path.canonical, segments: path.segments, ifAbsent: true };
    }
    case 'delete': {
      requireKeys(record, ['kind', 'path', 'ifRevision', 'recursive']);
      const path = pathOf(record.path, false);
      const ifRevision = requiredRevision(record, 'ifRevision');
      if ('recursive' in record && typeof record.recursive !== 'boolean') {
        throw new VfsInvalidMutationRequestError();
      }
      return {
        kind: 'delete',
        path: path.canonical,
        segments: path.segments,
        ifRevision,
        recursive: record.recursive === true,
      };
    }
    case 'persist': {
      requireKeys(record, ['kind', 'path', 'ifRevision']);
      const path = pathOf(record.path, false);
      const ifRevision = requiredRevision(record, 'ifRevision');
      return { kind: 'persist', path: path.canonical, segments: path.segments, ifRevision };
    }
    case 'setMimeType': {
      requireKeys(record, ['kind', 'path', 'ifRevision', 'mimeType']);
      const path = pathOf(record.path, false);
      const ifRevision = requiredRevision(record, 'ifRevision');
      const mimeType = assertStrictMimeType(record.mimeType);
      return {
        kind: 'setMimeType',
        path: path.canonical,
        segments: path.segments,
        ifRevision,
        mimeType,
      };
    }
    case 'move':
    case 'copy': {
      requireKeys(record, [
        'kind',
        'source',
        'destination',
        'sourceRevision',
        'destinationAbsent',
        'destinationResolution',
        'expiresInSeconds',
      ]);
      const source = pathOf(record.source, false);
      const destination = pathOf(record.destination, true);
      const sourceRevision = requiredRevision(record, 'sourceRevision');
      requireTrue(record, 'destinationAbsent');
      if ('destinationResolution' in record && record.destinationResolution !== 'exact') {
        throw new VfsInvalidMutationRequestError();
      }
      // 만료는 새 FILE을 만드는 copy에서만 받는다. move는 기존 node를 옮기므로 거부한다.
      let expiresInSeconds: number | undefined;
      if ('expiresInSeconds' in record) {
        if (record.kind === 'move') throw new VfsInvalidExpiryError();
        expiresInSeconds =
          expiryBounds === null
            ? parseExpirySeconds(record.expiresInSeconds)
            : assertExpirySeconds(record.expiresInSeconds, expiryBounds);
      }
      return {
        kind: record.kind,
        source: source.canonical,
        sourceSegments: source.segments,
        destination: destination.canonical,
        destinationSegments: destination.segments,
        sourceRevision,
        destinationAbsent: true,
        ...(record.destinationResolution === 'exact' ? { destinationResolution: 'exact' as const } : {}),
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
      };
    }
    default:
      throw new VfsInvalidMutationRequestError();
  }
}
