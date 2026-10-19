// extract 요청 JSON의 shape·경로·revision·exclude·mimeTypes를 검증하고 정규화한다.
// source 종류·revision 일치·대상 상태는 후속 capture와 commit이 검사한다. 규칙은 docs/design/17-file-extract.md "공개 계약".
import { DomainError } from '../../common/domain-error.js';
import { compileExclude } from '../extract-exclude.js';
import { assertStrictMimeType } from '../mime.js';
import { PathResolver } from '../path-resolver.js';
import { decodeRevision } from '../revision.js';
import { VfsExtractInvalidRequestError } from '../vfs.errors.js';

/** 대상 DIRECTORY에 반영하는 방식이다. */
export type ExtractMode = 'overwrite' | 'clean';

/** 검증과 정규화를 마친 extract 요청이다. */
export interface ExtractRequest {
  /** 정규화한 원본 압축 FILE 절대 경로다. */
  readonly source: string;

  /** 원본 경로의 segment 목록이다. root는 허용하지 않으므로 비어 있지 않다. */
  readonly sourceSegments: string[];

  /** 원본 FILE이 일치해야 하는 revision이다. */
  readonly sourceRevision: string;

  /** 정규화한 대상 DIRECTORY 절대 경로다. */
  readonly destination: string;

  /** 대상 경로의 segment 목록이다. root는 허용하지 않으므로 비어 있지 않다. */
  readonly destinationSegments: string[];

  /** 지정하면 대상 DIRECTORY가 일치해야 하는 revision이다. 생략하면 커밋 시점 대상에 mode를 적용한다. */
  readonly destinationRevision?: string;

  /** 반영 방식이다. */
  readonly mode: ExtractMode;

  /** 제외할 상대 경로 glob 목록이다. */
  readonly exclude: readonly string[];

  /** 소문자 확장자(`.html`)에서 MIME으로 가는 map이다. 값은 소문자로 정규화한다. */
  readonly mimeTypes: Readonly<Record<string, string>>;

  /** true면 대상을 바꾸지 않고 entry 목록만 돌려준다. */
  readonly dryRun: boolean;
}

const ALLOWED_KEYS = [
  'source',
  'sourceRevision',
  'destination',
  'mode',
  'destinationRevision',
  'exclude',
  'mimeTypes',
  'dryRun',
] as const;
const MAX_EXCLUDE_PATTERNS = 64;
const MAX_EXCLUDE_LENGTH = 1024;
const MAX_MIME_TYPES = 256;
const MIME_EXTENSION = /^\.[a-z0-9]{1,32}$/;
const pathResolver = new PathResolver();

/**
 * extract 요청의 JSON shape와 값을 검증한다.
 *
 * 검증 순서는 구조, 경로, exclude·mimeTypes, revision 형식이다.
 * 경로·MIME helper가 던지는 오류는 `VFS_INVALID_EXTRACT_REQUEST`로 바꾼다.
 * 문자열 revision의 형식 오류만 `VFS_INVALID_REVISION`을 유지한다.
 */
export function parseExtractRequest(value: unknown): ExtractRequest {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) => (ALLOWED_KEYS as readonly string[]).includes(key))
  ) {
    throw new VfsExtractInvalidRequestError();
  }
  const { source, sourceRevision, destination, mode, destinationRevision, exclude, mimeTypes, dryRun } =
    value;
  if (
    typeof source !== 'string' ||
    typeof sourceRevision !== 'string' ||
    typeof destination !== 'string' ||
    (mode !== 'overwrite' && mode !== 'clean') ||
    (destinationRevision !== undefined && typeof destinationRevision !== 'string') ||
    (dryRun !== undefined && typeof dryRun !== 'boolean')
  ) {
    throw new VfsExtractInvalidRequestError();
  }
  const resolvedSource = resolveNonRoot(source);
  const resolvedDestination = resolveNonRoot(destination);
  const excludePatterns = parseExclude(exclude);
  const normalizedMimeTypes = parseMimeTypes(mimeTypes);
  decodeRevision(sourceRevision);
  if (destinationRevision !== undefined) decodeRevision(destinationRevision);
  return {
    source: resolvedSource.canonical,
    sourceSegments: resolvedSource.segments,
    sourceRevision,
    destination: resolvedDestination.canonical,
    destinationSegments: resolvedDestination.segments,
    ...(destinationRevision === undefined ? {} : { destinationRevision }),
    mode,
    exclude: excludePatterns,
    mimeTypes: normalizedMimeTypes,
    dryRun: dryRun ?? false,
  };
}

/** 절대 경로를 정규화한다. root와 helper 오류는 extract 요청 오류다. */
function resolveNonRoot(raw: string): { canonical: string; segments: string[] } {
  try {
    const resolved = pathResolver.resolveConditional(raw);
    if (resolved.segments.length === 0) throw new VfsExtractInvalidRequestError();
    return resolved;
  } catch (error) {
    throw toRequestError(error);
  }
}

/** exclude 배열의 개수·길이·glob 문법을 검사하고 그대로 돌려준다. */
function parseExclude(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EXCLUDE_PATTERNS) throw new VfsExtractInvalidRequestError();
  for (const pattern of value) {
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_EXCLUDE_LENGTH) {
      throw new VfsExtractInvalidRequestError();
    }
  }
  compileExclude(value as string[]);
  return value as string[];
}

/** mimeTypes 객체의 개수·키 형식·strict MIME을 검사하고 값을 소문자로 정규화한다. */
function parseMimeTypes(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new VfsExtractInvalidRequestError();
  const entries = Object.entries(value);
  if (entries.length > MAX_MIME_TYPES) throw new VfsExtractInvalidRequestError();
  const out: Record<string, string> = {};
  for (const [extension, mimeType] of entries) {
    if (!MIME_EXTENSION.test(extension)) throw new VfsExtractInvalidRequestError();
    try {
      out[extension] = assertStrictMimeType(mimeType);
    } catch (error) {
      throw toRequestError(error);
    }
  }
  return out;
}

/** helper가 던진 DomainError를 extract 요청 오류로 바꾼다. 이미 extract 요청 오류면 그대로 둔다. */
function toRequestError(error: unknown): Error {
  if (error instanceof VfsExtractInvalidRequestError) return error;
  if (error instanceof DomainError) return new VfsExtractInvalidRequestError();
  return error as Error;
}

/** 배열과 null을 제외한 JSON 객체인지 검사한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
