// archive JSON shape·UUID·revision과 ZIP FILE 이름을 검증한다.
// 원본 존재·종류·개수·byte 합계와 target VFS 경로 조건은 후속 capture에서 검사한다.
import { decodeRevision } from '../revision.js';
import { VfsArchiveInvalidRequestError, VfsArchiveInvalidRevisionError } from '../vfs.errors.js';
import { validateArchiveEntryNames } from '../archive-entry-name.js';

/** 요청에서 선택한 원본 FILE과 ZIP 내부 경로다. */
export interface ArchiveRequestEntry {
  /** 같은 namespace에 속해야 하는 원본 FILE ID다. */
  readonly id: string;

  /** 검증된 ZIP 내부 상대 경로다. */
  readonly name: string;

  /** 지정하면 ID가 원본과 일치해야 하는 조건부 revision이다. */
  readonly revision?: string;
}

/** 구조와 entry 이름을 검증한 archive 요청이다. */
export interface ArchiveRequest {
  /** 후속 VFS 경로 검증에 전달할 출력 FILE 경로다. */
  readonly target: string;

  /** ZIP 출력 순서대로 지정한 원본 목록이다. */
  readonly entries: readonly ArchiveRequestEntry[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** archive 요청의 JSON shape와 항목별 revision을 검증한다. */
export function parseArchiveRequest(value: unknown): ArchiveRequest {
  if (
    !isRecord(value) ||
    !hasOnlyAllowedKeys(value, ['target', 'entries']) ||
    typeof value.target !== 'string' ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    throw new VfsArchiveInvalidRequestError();
  }
  const entries = value.entries.map((entry, index): ArchiveRequestEntry => {
    if (
      !isRecord(entry) ||
      !hasOnlyAllowedKeys(entry, ['id', 'name', 'revision']) ||
      typeof entry.id !== 'string' ||
      !UUID.test(entry.id) ||
      typeof entry.name !== 'string' ||
      (entry.revision !== undefined && typeof entry.revision !== 'string')
    ) {
      throw new VfsArchiveInvalidRequestError();
    }
    if (entry.revision !== undefined) {
      try {
        if (decodeRevision(entry.revision).id !== entry.id.toLowerCase())
          throw new Error('revision id mismatch');
      } catch {
        throw new VfsArchiveInvalidRevisionError(index);
      }
    }
    return {
      id: entry.id.toLowerCase(),
      name: entry.name,
      ...(entry.revision === undefined ? {} : { revision: entry.revision }),
    };
  });
  validateArchiveEntryNames(entries.map(({ name }) => name));
  return { target: value.target, entries };
}

/** 배열과 null을 제외한 JSON 객체인지 검사한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 필수 키 존재 여부와 별개로 허용하지 않은 추가 키를 거부한다. */
function hasOnlyAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
