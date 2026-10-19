// 압축 entry 이름을 정규화·검증하고 exclude·중복·조상 충돌·MIME을 판정해 커밋할 목록으로 만든다.
// 이름 규칙은 archive의 validateArchiveEntryName을 재사용한다. 규칙은 docs/design/17-file-extract.md "공개 계약"을 따른다.
import { DomainError } from '../common/domain-error.js';
import { validateArchiveEntryName } from './archive-entry-name.js';
import { compileExclude } from './extract-exclude.js';
import type { ExtractFormat } from './extract-format.js';
import { VfsExtractInvalidEntryError } from './vfs.errors.js';

/** 검증을 통과해 선택된 entry 하나다. */
export interface PlannedEntry {
  /** 제외한 entry를 세지 않는 0부터의 순번이다. */
  readonly entryIndex: number;

  /** 선행 `./`와 DIRECTORY 끝 `/`를 벗긴 destination 기준 상대 이름이다. */
  readonly name: string;

  readonly segments: string[];

  readonly type: 'FILE' | 'DIRECTORY';

  /** FILE의 MIME이다. 결정할 수 없으면 `application/octet-stream`이다. DIRECTORY는 항상 이 값이다. */
  readonly mimeType: string;
}

const DEFAULT_MIME_TYPE = 'application/octet-stream';
const MAX_ABSOLUTE_PATH_BYTES = 4096;

/** 경로 trie 노드의 명시 표시 비트다. */
const EXPLICIT = 1;
const FILE_NODE = 2;

/**
 * entry를 순서대로 받아 선택 여부와 정규화 결과를 정한다.
 *
 * 처리 순서는 이름 정규화·검증, exclude, 중복·충돌 판정, 순번 부여, MIME 결정이다.
 * 이름 검증이 exclude보다 앞서므로 위험한 이름을 제외 패턴으로 숨길 수 없다.
 * 중복·충돌은 제외하지 않은 entry 사이에서만 판정한다.
 *
 * 충돌 판정은 segment 단위 trie다. 경로 prefix 문자열을 모으면 깊은 경로 entry 수에 대해 메모리가
 * 경로 길이의 제곱으로 늘어난다.
 */
export class ExtractEntryPlanner {
  private readonly tarLike: boolean;
  private readonly destinationSegments: readonly string[];
  private readonly excludes: (name: string) => boolean;
  private readonly mimeTypes: Readonly<Record<string, string>>;
  // `부모 노드 id\0segment`에서 노드 id로 가는 map이다. 노드 0은 destination이다.
  private readonly children = new Map<string, number>();
  private readonly flags: number[] = [0];
  private readonly hasChildren: boolean[] = [false];
  private selected = 0;

  constructor(input: {
    readonly format: ExtractFormat;
    readonly destinationSegments: readonly string[];
    readonly exclude: readonly string[];
    readonly mimeTypes: Readonly<Record<string, string>>;
  }) {
    this.tarLike = input.format !== 'zip';
    this.destinationSegments = input.destinationSegments;
    this.excludes = compileExclude(input.exclude);
    this.mimeTypes = input.mimeTypes;
  }

  /** 지금까지 선택한 entry 수다. 다음 선택 entry의 순번이기도 하다. */
  get count(): number {
    return this.selected;
  }

  /**
   * entry 하나를 판정한다. 건너뛰면 null, 선택하면 정규화 결과를 돌려준다.
   * 규칙을 어기면 다음 선택 순번을 담은 VFS_EXTRACT_INVALID_ENTRY를 던진다. 던진 뒤 상태는 바뀌지 않는다.
   */
  plan(rawName: string, type: 'FILE' | 'DIRECTORY'): PlannedEntry | null {
    let name = rawName;
    if (this.tarLike) {
      // tar가 root를 가리키는 `./` DIRECTORY만 건너뛴다. 그 밖의 선행 `./`는 벗긴다.
      if (type === 'DIRECTORY' && name === './') return null;
      if (name.startsWith('./')) name = name.slice(2);
    }
    if (type === 'DIRECTORY' && name.endsWith('/')) name = name.slice(0, -1);
    const reject = (reason: string): never => {
      throw new VfsExtractInvalidEntryError(this.selected, rawName, reason);
    };
    try {
      validateArchiveEntryName(name);
    } catch (error) {
      if (error instanceof DomainError) return reject('entry 이름 규칙 위반');
      throw error;
    }
    const segments = name.split('/');
    const absolute = `/${[...this.destinationSegments, ...segments].join('/')}`;
    if (Buffer.byteLength(absolute, 'utf8') > MAX_ABSOLUTE_PATH_BYTES)
      return reject('destination을 합친 경로가 4096 byte 초과');
    if (this.excludes(name)) return null;

    const path = this.locate(segments);
    this.assertNoConflict(path, segments, type, reject);
    this.record(path, segments, type);

    const entryIndex = this.selected;
    this.selected += 1;
    return {
      entryIndex,
      name,
      segments,
      type,
      mimeType: type === 'FILE' ? this.resolveMimeType(segments[segments.length - 1]) : DEFAULT_MIME_TYPE,
    };
  }

  /** 경로를 따라 이미 있는 노드 id를 모은다. 없는 노드부터는 -1이다. 상태를 바꾸지 않는다. */
  private locate(segments: readonly string[]): number[] {
    const ids: number[] = [];
    let node = 0;
    for (const segment of segments) {
      const child = node === -1 ? undefined : this.children.get(`${node}\0${segment}`);
      node = child ?? -1;
      ids.push(node);
    }
    return ids;
  }

  /** 같은 경로의 중복, 조상 FILE 아래 entry, 암시적 조상 자리의 FILE을 거부한다. */
  private assertNoConflict(
    path: readonly number[],
    segments: readonly string[],
    type: 'FILE' | 'DIRECTORY',
    reject: (reason: string) => never,
  ): void {
    for (let depth = 0; depth < path.length - 1; depth += 1) {
      const id = path[depth];
      if (id !== -1 && (this.flags[id] & FILE_NODE) !== 0)
        reject(`FILE ${segments.slice(0, depth + 1).join('/')} 아래 entry`);
    }
    const last = path[path.length - 1];
    if (last === -1) return;
    if ((this.flags[last] & EXPLICIT) !== 0) reject('같은 경로의 entry가 중복됨');
    if (type === 'FILE' && this.hasChildren[last]) reject('FILE이 다른 entry의 조상 디렉터리와 같은 경로');
  }

  /** 판정을 통과한 entry를 trie에 기록한다. */
  private record(path: readonly number[], segments: readonly string[], type: 'FILE' | 'DIRECTORY'): void {
    let node = 0;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const existing = path[depth];
      let child = existing;
      if (child === -1) {
        child = this.flags.length;
        this.children.set(`${node}\0${segments[depth]}`, child);
        this.flags.push(0);
        this.hasChildren.push(false);
      }
      this.hasChildren[node] = true;
      node = child;
    }
    this.flags[node] |= EXPLICIT | (type === 'FILE' ? FILE_NODE : 0);
  }

  /** 마지막 segment의 확장자를 소문자로 비교해 mimeTypes map을 적용한다. 확장자가 없는 dotfile은 map을 쓰지 않는다. */
  private resolveMimeType(basename: string): string {
    const dot = basename.lastIndexOf('.');
    if (dot <= 0 || dot === basename.length - 1) return DEFAULT_MIME_TYPE;
    return this.mimeTypes[basename.slice(dot).toLowerCase()] ?? DEFAULT_MIME_TYPE;
  }
}
